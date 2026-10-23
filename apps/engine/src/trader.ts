import { existsSync, writeFileSync } from "node:fs";
import { accountStatusFrom, computeTargets, marketRulesFrom, planOrders, riskCheck, toStep, type Holding, type MarketRules, type RiskAction, type Rules } from "@tug/core";
import { bookTickers, depth as strikeDepth, markets as strikeMarkets, UserStream, vault as strikeVault, vaultHistory, type StrikeMarket } from "@tug/strike";
import { logEvent, type Db } from "./db.js";
import type { Executor } from "./executor.js";

export interface TraderConfig {
  network: string;
  /** Markets this account may trade (testnet: the rules' testnet markets). */
  markets: string[] | "all";
  tradingOn: () => boolean;
  pausedFile: string;
  /** The live record's starting equity; read from the database once the first equity point exists. */
  startEquity?: number;
  keyFile: string | { hex: string };
  vaultId?: string;
  /** Builder Connect: the account's budget cap in USD. Targets are sized on it, and no order may take the account's gross exposure past it times the gross cap (E-BUDGET). */
  budgetUsd?: number;
}

const RISK_EVERY_MS = 10_000;
const TRADE_EVERY_MS = 60_000;
const MARKS_EVERY_MS = 30_000;

/**
 * Runs one Strike account: the risk guard every 10 s and the rebalancer every 60 s (§9.5, §9.7). Targets
 * come from the latest complete snapshot's tradable gaps and are recomputed at each rebalance boundary;
 * between boundaries only prices are kept at the best bid or ask. Every order waits in the book; the only
 * orders that take are risk exits.
 */
export class Trader {
  private marketsCache: { at: number; markets: Record<string, StrikeMarket>; rules: Record<string, MarketRules> } | undefined;
  private books: Record<string, { bid: number; ask: number }> = {};
  private lastMarksAt: number | null = null;
  private targets: Record<string, number> = {};
  private targetsBoundary = -1;
  private cycle = 0;
  private blocked: RiskAction[] = [];
  private busy = false;
  private stream: UserStream | undefined;
  private accountStatus = "trading";
  private accountId: string | undefined;
  private flattenTries = 0;
  private riskBusy = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly ex: Executor,
    private readonly rules: Rules,
    private readonly cfg: TraderConfig,
  ) {}

  start(): void {
    this.stream = new UserStream(this.cfg.keyFile, {
      raw: (line, at) => this.db.prepare("INSERT INTO user_frames (network, ts, raw) VALUES (?,?,?)").run(this.cfg.network, at, line),
      frame: (f) => {
        // A liquidation or auto-deleverage announced on the stream marks the account halted (§9.7).
        if (f.kind === "event" && /liquidat|adl|bankrupt/i.test(f.type)) this.accountStatus = "liquidation";
        if (f.kind === "order") {
          const o = f.order as { c: string; X: string; i: number; cr?: string };
          this.db.prepare("UPDATE orders SET status=?, order_id=COALESCE(order_id, ?), updated_at=? WHERE client_order_id=?").run(o.X.toLowerCase(), o.i, Date.now(), o.c);
          this.ex.noteStreamOrder(o.c, o.X, String(o.cr ?? ""), o.i);
        }
      },
      resync: () => void this.syncFills().then(() => this.syncMoney()),
      // A close after stop() is TUG closing it (Stop on a connected account, a restart), not a drop.
      status: (s) => {
        const drop = s.state === "closed" && !this.stopped;
        logEvent(this.db, "userstream", drop ? "warn" : "info", `user stream ${s.state}`, drop ? "E-WS" : undefined, s);
      },
    }, { vaultId: this.cfg.vaultId });
    this.stream.start();
    const every = (ms: number, fn: () => Promise<void>) =>
      this.timers.push(setInterval(() => void (this.stopped ? undefined : this.track(fn().catch((e) => this.fail(e)))), ms));
    every(MARKS_EVERY_MS, () => this.readMarkets());
    every(RISK_EVERY_MS, () => this.riskTick());
    every(TRADE_EVERY_MS, () => this.tradeTick());
    every(60_000, () => this.syncFills().then(() => this.syncMoney()));
    every(60_000, () => this.sampleDepth());
    void this.track(
      this.readMarkets()
        .then(() => this.leverageForHeld())
        .then(() => this.riskTick())
        .then(() => this.syncMoney())
        .catch((e) => this.fail(e)),
    );
  }

  /** At start: every market TUG already holds gets the rules' leverage (read back), before any new order. */
  async leverageForHeld(): Promise<void> {
    if (!this.cfg.tradingOn()) return;
    for (const s of Object.keys(await this.ex.positions()).filter((x) => this.allowed(x))) {
      try {
        await this.ex.ensureLeverage(s, this.rules.leverage_setting, this.rules.margin_mode);
      } catch (e) {
        this.fail(e);
      }
    }
  }

  /** Keeps a running tick in view, so stop() can wait for it. */
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /** Stops the timers and the stream, then resolves once every tick already running has finished (an order it was placing included). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.stream?.stop();
    await Promise.allSettled([...this.inflight]);
  }

  private fail(e: unknown): void {
    const err = e as { code?: string; message?: string };
    logEvent(this.db, "trader", "error", err.message ?? String(e), err.code ?? "E-CYCLE");
  }

  private allowed(symbol: string): boolean {
    return this.cfg.markets === "all" || this.cfg.markets.includes(symbol);
  }

  async readMarkets(): Promise<void> {
    const { markets } = await strikeMarkets();
    this.marketsCache = { at: Date.now(), markets, rules: marketRulesFrom(markets as unknown as Record<string, Record<string, unknown>>) };
    this.books = await bookTickers();
    this.lastMarksAt = Date.now();
  }

  private startEquity(equity: number): number {
    // A vault's equity moves with every deposit and withdrawal, so its stop is on the share price: the start
    // equity is the first recorded share price times today's shares.
    if (this.cfg.vaultId) {
      const first = this.db.prepare("SELECT share_price FROM vault_points WHERE vault_id=? ORDER BY ts LIMIT 1").get(this.cfg.vaultId) as { share_price: number } | undefined;
      const last = this.db.prepare("SELECT total_shares FROM vault_points WHERE vault_id=? ORDER BY ts DESC LIMIT 1").get(this.cfg.vaultId) as { total_shares: number } | undefined;
      return first && last ? first.share_price * last.total_shares : equity;
    }
    if (this.cfg.startEquity) return this.cfg.startEquity;
    const first = this.db.prepare("SELECT equity FROM live_equity WHERE network=? ORDER BY ts LIMIT 1").get(this.cfg.network) as { equity: number } | undefined;
    return first?.equity ?? equity;
  }

  /** The risk guard: decide from live state, then carry the actions out in order. */
  async riskTick(): Promise<void> {
    // One risk tick at a time: a slow exit read-back must not overlap the next tick.
    if (this.riskBusy) return;
    this.riskBusy = true;
    try {
      await this.riskTickOnce();
    } finally {
      this.riskBusy = false;
    }
  }

  private async riskTickOnce(): Promise<void> {
    const acct = await this.ex.account();
    this.accountId = acct.accountId;
    const pos = await this.ex.positions();
    const now = Date.now();
    const lastMinute = this.db.prepare("SELECT MAX(ts) AS ts FROM live_equity WHERE network=?").get(this.cfg.network) as { ts: number | null };
    if (!lastMinute.ts || now - lastMinute.ts >= 60_000) {
      this.db.prepare("INSERT INTO live_equity (network, ts, equity, positions_json) VALUES (?,?,?,?)").run(this.cfg.network, now, acct.equity, JSON.stringify(pos));
    }
    const snap = this.db.prepare("SELECT MAX(started_at) AS at FROM snapshots WHERE status='COMPLETE' AND network='mainnet'").get() as { at: number | null };
    const m = this.marketsCache?.markets ?? {};
    const positions: Record<string, number> = {};
    for (const [s, p] of Object.entries(pos)) positions[s] = Number(p.size) * (m[s]?.mark_price ?? 0);
    const actions = riskCheck(
      {
        now,
        startEquity: this.startEquity(acct.equity),
        equity: acct.equity,
        marginRatio: acct.marginRatio,
        positions,
        lastSnapshotAt: snap.at,
        lastMarksAt: this.lastMarksAt,
        // Strike's /v2/account reply carries no status field (decisions.md); liquidation is read from fills and stream events.
        accountStatus: this.accountStatus,
        marketStatus: Object.fromEntries(Object.keys(positions).map((s) => [s, String((m[s] as { status?: string } | undefined)?.status ?? "trading")])),
        tradingOn: this.cfg.tradingOn(),
        paused: existsSync(this.cfg.pausedFile),
      },
      this.rules,
    );
    this.blocked = actions.filter((a) => a.kind === "no_new_orders");
    if (!actions.some((a) => a.kind === "flatten_all")) this.flattenTries = 0;
    for (const a of actions) await this.act(a, pos);
  }

  private async act(a: RiskAction, pos: Record<string, { size: string }>): Promise<void> {
    const symbols = Object.keys(this.marketsCache?.markets ?? {}).filter((s) => this.allowed(s));
    if (a.kind === "cancel_all") {
      for (const s of symbols) {
        const open = (await this.ex.openOrders(s)).filter((o) => o.ClientOrderID.startsWith(`tug-v${this.rules.version}-${this.cfg.network}-`));
        for (const o of open) await this.ex.cancel(s, o.ClientOrderID);
      }
    } else if (a.kind === "flatten_all") {
      this.flattenTries++;
      for (const s of Object.keys(pos)) await this.ex.riskExit(s, this.clientId(`stop-${s}`), a.code, undefined, a.code);
      const left = await this.ex.positions();
      if (Object.keys(left).length > 0 && this.flattenTries >= 2) {
        logEvent(this.db, "risk", "error", "positions still open after two closing attempts", "E-STOP-OPEN", { positions: left, tries: this.flattenTries });
      }
    } else if (a.kind === "pause") {
      writeFileSync(this.cfg.pausedFile, JSON.stringify({ at: new Date().toISOString(), code: a.code }) + "\n");
      logEvent(this.db, "risk", "error", "Equity fell below the stop level: positions closed and trading paused until the owner's go.", "E-STOP");
    } else if (a.kind === "reduce_half") {
      const p = pos[a.symbol];
      const step = this.marketsCache?.rules[a.symbol]?.step;
      if (p && step) await this.ex.riskExit(a.symbol, this.clientId(`reduce-${a.symbol}`), a.code, toStep(Math.abs(Number(p.size)) / 2, step, "down"), a.code);
    } else if (a.kind === "no_new_orders" && a.code !== "E-KILLED" && a.code !== "E-STOP") {
      logEvent(this.db, "risk", "warn", `new orders held: ${a.code}`, a.code);
    }
  }

  private clientId(tail: string): string {
    return `tug-v${this.rules.version}-${this.cfg.network}-${Date.now()}-${tail}`.slice(0, 64);
  }

  /** The rebalancer: targets at each boundary, then one resting order per market at the best price. */
  async tradeTick(): Promise<void> {
    if (this.busy || this.blocked.length > 0 || !this.cfg.tradingOn() || existsSync(this.cfg.pausedFile) || !this.marketsCache) return;
    this.busy = true;
    try {
      this.cycle++;
      const acct = await this.ex.account();
      const held = await this.ex.positions();
      // Price from a fresh book: the 30 s cache can be far enough behind that a resting price would take.
      this.books = await bookTickers();
      const boundary = Math.floor(Date.now() / (this.rules.rebalance_every_minutes * 60_000));
      if (boundary !== this.targetsBoundary) {
        const snap = this.db.prepare("SELECT MAX(id) AS id FROM snapshots WHERE status='COMPLETE' AND network='mainnet'").get() as { id: number };
        const gaps = Object.fromEntries(
          (this.db.prepare("SELECT symbol, gap FROM leans WHERE snapshot_id=? AND tradable=1").all(snap.id) as Array<{ symbol: string; gap: number }>)
            .filter((g) => this.allowed(g.symbol))
            .map((g) => [g.symbol, g.gap]),
        );
        const rules = this.marketsCache.rules;
        this.targets = computeTargets(gaps, this.sizingEquity(acct.equity), this.rules, (s) => rules[s]?.minNotional ?? 5);
        this.targetsBoundary = boundary;
        logEvent(this.db, "trader", "info", "targets", undefined, { snapshot: snap.id, equity: acct.equity, targets: this.targets });
      }
      const m = this.marketsCache.markets;
      const holdings: Record<string, Holding> = Object.fromEntries(
        Object.entries(held).filter(([s]) => this.allowed(s)).map(([s, p]) => [s, { size: p.size, mark: m[s]?.mark_price ?? 0 }]),
      );
      const books = Object.fromEntries(Object.entries(this.books).filter(([s]) => this.allowed(s)));
      const plan = planOrders(this.targets, holdings, books, this.marketsCache.rules, this.rules.rebalance_band_fraction);
      const want = new Map(plan.orders.map((o) => [o.symbol, o]));
      const symbols = new Set([...want.keys(), ...Object.keys(this.targets), ...Object.keys(holdings)]);
      await this.reconcileAll([...symbols], want);
    } finally {
      this.busy = false;
    }
  }

  /** Reconciles every market in turn; one market's failure is recorded and never stops the others. */
  async reconcileAll(symbols: string[], want: Map<string, { symbol: string; side: "buy" | "sell"; price: string; size: string; why: string }>): Promise<void> {
    for (const s of symbols) {
      try {
        await this.reconcile(s, want.get(s));
      } catch (e) {
        this.fail(e);
      }
    }
  }

  /** Keeps TUG's waiting order on a market if it matches the wanted one; otherwise cancels and places it. */
  async reconcile(symbol: string, w: { symbol: string; side: "buy" | "sell"; price: string; size: string; why: string } | undefined): Promise<void> {
    const mine = (await this.ex.openOrders(symbol)).filter((o) => o.ClientOrderID.startsWith(`tug-v${this.rules.version}-${this.cfg.network}-`));
    const keep = w && mine.find((o) => o.Side.toLowerCase() === w.side && Number(o.Price) === Number(w.price) && Math.abs(Number(o.Size) - Number(o.Filled) - Number(w.size)) < 1e-12);
    for (const o of mine) if (o !== keep) await this.ex.cancel(symbol, o.ClientOrderID);
    // The risk guard runs on its own timer: re-check it before every placement.
    if (w && !keep && this.mayPlace() && (await this.withinBudget(w))) await this.placeWithRequote(w, 0);
  }

  /** The equity targets are sized on: the account's, or its budget cap when that is lower (Builder Connect). */
  sizingEquity(equity: number): number {
    return this.cfg.budgetUsd !== undefined ? Math.min(equity, this.cfg.budgetUsd) : equity;
  }

  /**
   * Builder Connect's hard limit, checked before every order whatever the targets say: the account's gross exposure
   * after the order fills must stay within budget × the rules' gross cap. An order that would pass it is not sent
   * (E-BUDGET). Orders that only reduce exposure always pass.
   */
  async withinBudget(w: { symbol: string; side: "buy" | "sell"; price: string; size: string }): Promise<boolean> {
    if (this.cfg.budgetUsd === undefined) return true;
    const held = await this.ex.positions();
    const mark = (s: string) => this.marketsCache?.markets[s]?.mark_price ?? Number(w.price);
    const sign = w.side === "buy" ? 1 : -1;
    const mine = (o: { ClientOrderID: string }) => o.ClientOrderID.startsWith(`tug-v${this.rules.version}-${this.cfg.network}-`);
    // TUG's own orders waiting on every market it may trade count as if filled: here on the same side, elsewhere in full.
    const symbols = this.cfg.markets !== "all" ? this.cfg.markets : Object.keys(this.marketsCache?.markets ?? (await strikeMarkets()).markets);
    let elsewhere = 0;
    let resting = 0;
    for (const s of new Set([...symbols, ...Object.keys(held), w.symbol])) {
      const orders = (await this.ex.openOrders(s)).filter(mine);
      if (s === w.symbol) {
        resting = orders.filter((o) => o.Side.toLowerCase() === w.side).reduce((a, o) => a + Number(o.Size) - Number(o.Filled), 0);
      } else {
        elsewhere += Math.abs(Number(held[s]?.size ?? 0)) * mark(s) + orders.reduce((a, o) => a + (Number(o.Size) - Number(o.Filled)) * Number(o.Price), 0);
      }
    }
    const before = Number(held[w.symbol]?.size ?? 0) + sign * resting;
    const after = before + sign * Number(w.size);
    if (Math.abs(after) <= Math.abs(before)) return true;
    const gross = elsewhere + Math.abs(after) * mark(w.symbol);
    const limit = this.cfg.budgetUsd * this.rules.gross_exposure_cap;
    if (gross <= limit + 1e-9) return true;
    logEvent(this.db, "trader", "warn", "This order would exceed your budget cap.", "E-BUDGET", { order: w, gross, limit, budget: this.cfg.budgetUsd });
    return false;
  }

  /** Tests only: the account id the risk tick would have read from Strike. */
  setAccountIdForCheck(id: string): void {
    this.accountId = id;
  }

  /** Testnet checks only: start a rebalance from given targets, or age the market data. */
  setTargetsForCheck(targets: Record<string, number>): void {
    this.targets = targets;
    this.targetsBoundary = Math.floor(Date.now() / (this.rules.rebalance_every_minutes * 60_000));
  }
  setMarksReadAtForCheck(ts: number): void {
    this.lastMarksAt = ts;
  }

  /** Testnet check of the reprice rule: an order resting below the best bid is replaced at the best bid. */
  async tradeTickForCheck(symbol: string, side: "buy" | "sell", size: string): Promise<void> {
    const r = this.marketsCache!.rules[symbol]!;
    const b = this.books[symbol]!;
    const away = toStep(side === "buy" ? b.bid - 5 * Number(r.tick) : b.ask + 5 * Number(r.tick), r.tick, side === "buy" ? "down" : "up");
    await this.ex.placePostOnly({ symbol, side, price: away, size, clientOrderId: this.clientId(`check-${symbol}-away`), reason: "exec check: resting away from the best price" });
    await this.readMarkets();
    const best = this.books[symbol]!;
    const price = toStep(side === "buy" ? best.bid : best.ask, r.tick, side === "buy" ? "down" : "up");
    await this.reconcile(symbol, { symbol, side, price, size, why: "exec check: reprice to the best price" });
  }

  private mayPlace(): boolean {
    return this.blocked.length === 0 && this.cfg.tradingOn() && !existsSync(this.cfg.pausedFile);
  }

  /**
   * Post-only at the best price; if Strike says it would take, re-quote one tick away once (§9.5.5); if Strike
   * accepted it but never placed it (E-DROPPED), retry once with a new id (§9.5.7).
   */
  async placeWithRequote(o: { symbol: string; side: "buy" | "sell"; price: string; size: string; why: string }, attempt: number, dropRetry = false): Promise<void> {
    // A market is traded only at the rules' leverage and margin mode; a failure here places nothing.
    if (!this.ex.leverageConfirmed(o.symbol)) await this.ex.ensureLeverage(o.symbol, this.rules.leverage_setting, this.rules.margin_mode);
    let order;
    try {
      order = await this.ex.placePostOnly({ symbol: o.symbol, side: o.side, price: o.price, size: o.size, clientOrderId: this.clientId(`${this.cycle}-${o.symbol}-${attempt}${dropRetry ? "r" : ""}`), reason: o.why });
    } catch (e) {
      if ((e as { code?: string }).code === "E-DROPPED" && !dropRetry && this.mayPlace()) return this.placeWithRequote(o, attempt, true);
      throw e;
    }
    const reason = String((order as { CloseReason?: string }).CloseReason ?? "");
    // Strike answers a post-only order that would take with Status "rejected" and this close reason (OBSERVED on testnet).
    if ((order.Status === "rejected" || order.Status === "canceled") && reason === "order_would_match_immediately" && attempt === 0) {
      const tick = Number(this.marketsCache!.rules[o.symbol]!.tick);
      const d = this.marketsCache!.rules[o.symbol]!.tick.split(".")[1]?.length ?? 0;
      const price = (o.side === "buy" ? Number(o.price) - tick : Number(o.price) + tick).toFixed(d);
      logEvent(this.db, "trader", "info", "re-quote one tick away", undefined, { symbol: o.symbol, from: o.price, to: price });
      await this.placeWithRequote({ ...o, price }, 1);
    }
  }

  /**
   * Depth added (§9.6.6), each minute: for every TUG order resting on Strike's book, its size, whether it is at
   * the best price, and the totals at the best price and in the top 5 levels of that side (public book).
   */
  async sampleDepth(): Promise<void> {
    const open = this.db
      .prepare(
        "SELECT o.symbol, o.side, o.price, CAST(o.size AS REAL) - COALESCE((SELECT SUM(f.size) FROM fills f WHERE f.network=o.network AND (f.order_id=o.order_id OR f.client_order_id=o.client_order_id)),0) AS size FROM orders o WHERE o.network=? AND o.post_only=1 AND o.status IN ('pending','new','open','partially_filled') AND o.placed_at > ?",
      )
      .all(this.cfg.network, Date.now() - 24 * 3600_000) as Array<{ symbol: string; side: "buy" | "sell"; price: string; size: number }>;
    const ts = Date.now();
    const ins = this.db.prepare("INSERT OR REPLACE INTO depth_samples (network, ts, symbol, side, price, tug_size, at_best, best_total, top5_total) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const o of open.filter((x) => x.size > 0)) {
      const book = await strikeDepth(o.symbol, 5);
      const levels = o.side === "buy" ? book.bids : book.asks;
      if (levels.length === 0) continue;
      const price = Number(o.price);
      ins.run(this.cfg.network, ts, o.symbol, o.side, price, o.size, Math.abs(levels[0]![0] - price) < 1e-12 ? 1 : 0, levels[0]![1], levels.reduce((a, l) => a + l[1], 0));
    }
  }

  /** Money in and out: the vault's deposits, withdrawals and share price, or the account's own transfers. */
  syncMoney(): Promise<void> {
    return this.cfg.vaultId ? this.syncVault() : this.syncTransfers();
  }

  /**
   * The vault's share price, equity and shares each minute (`vault_points`) and every deposit and withdrawal
   * (`vault_moves`), from Strike's public vault reads. A withdrawal's status follows Strike's: pending, then
   * completed (after the lockup) or cancelled.
   */
  async syncVault(): Promise<void> {
    const id = this.cfg.vaultId!;
    const { vault: v, raw } = await strikeVault(id);
    this.db.prepare("INSERT OR IGNORE INTO vault_points (vault_id, ts, share_price, equity, total_shares, raw) VALUES (?,?,?,?,?,?)").run(id, Date.now(), v.share_price, v.equity, v.total_shares, raw);
    const ins = this.db.prepare(
      "INSERT INTO vault_moves (vault_id, id, type, account_id, status, ts, usd, shares, share_price, execute_at, executed_at, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (vault_id, id) DO UPDATE SET status=excluded.status, usd=excluded.usd, share_price=excluded.share_price, executed_at=excluded.executed_at, raw=excluded.raw",
    );
    for (const m of await vaultHistory(id)) {
      const usd = m.type === "deposit" ? m.usd_amount : (m.actual_usd ?? m.estimated_usd);
      const shares = m.type === "deposit" ? m.shares_minted : m.shares_burned;
      ins.run(id, m.id, m.type, m.account_id ?? null, m.status, m.timestamp, usd ?? null, shares ?? null, m.share_price ?? null, m.execute_at_timestamp ?? null, m.executed_timestamp ?? null, JSON.stringify(m));
    }
  }

  /**
   * Pulls the account's money in and out from Strike's transaction history into `transfers`: deposits add to the
   * money put in, withdrawals take from it, once Strike shows them settled. Any other kind (internal transfer, reward) is stored and flagged with
   * E-TRANSFER, never counted silently.
   */
  async syncTransfers(): Promise<void> {
    if (!this.accountId) return;
    const r = await this.ex.read(`/v2/history/transaction?account_id=${encodeURIComponent(this.accountId)}&type=deposit,withdraw,transfer,reward_grant&limit=100`);
    const rows = ((r as { transactions?: Array<Record<string, unknown>> | null }).transactions ?? []) as Array<Record<string, unknown>>;
    const known = this.db.prepare("SELECT 1 FROM transfers WHERE network=? AND id=?");
    // A deposit can show as pending until its Cardano settlement completes, so the stored status follows Strike's.
    const ins = this.db.prepare(
      "INSERT INTO transfers (network, id, type, amount, ts, status, tx_hash, raw) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (network, id) DO UPDATE SET status=excluded.status, raw=excluded.raw",
    );
    for (const t of rows) {
      const added = !known.get(this.cfg.network, t.id);
      ins.run(this.cfg.network, t.id, t.type, Number(t.amount), t.timestamp, t.status ?? null, t.tx_hash ?? null, JSON.stringify(t));
      if (added && t.type !== "deposit" && t.type !== "withdraw") {
        logEvent(this.db, "trader", "warn", `Strike recorded a ${String(t.type)} of ${String(t.amount)}; it is not counted as money put in`, "E-TRANSFER", { id: t.id, type: t.type, amount: t.amount });
      }
    }
  }

  /** Pulls new fills from Strike's history into `fills` (fee negative = maker rebate). */
  async syncFills(): Promise<void> {
    const last = this.db.prepare("SELECT MAX(trade_id) AS t FROM fills WHERE network=?").get(this.cfg.network) as { t: number | null };
    const path = `/v2/history/fill?limit=1000${last.t ? `&since_trade_id=${last.t}` : ""}`;
    const r = await this.ex.read(path);
    const fills = ((r as { fills?: Array<Record<string, unknown>> | null }).fills ?? []) as Array<Record<string, unknown>>;
    if (accountStatusFrom(fills as Array<{ auto_close_type?: string }>) === "liquidation") this.accountStatus = "liquidation";
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO fills (network, fill_id, trade_id, order_id, client_order_id, symbol, side, role, price, size, fee, realized_pnl, ts, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const setFilled = this.db.prepare(
      "UPDATE orders SET status=CASE WHEN (SELECT COALESCE(SUM(size),0) FROM fills WHERE network=? AND client_order_id=?) >= CAST(size AS REAL) - 1e-12 THEN 'filled' ELSE 'partially_filled' END, updated_at=? WHERE client_order_id=? AND status NOT IN ('filled','canceled','rejected')",
    );
    for (const f of fills) {
      ins.run(this.cfg.network, f.id, f.trade_id, f.order_id, f.client_order_id ?? null, f.symbol, f.side, f.role, Number(f.price), Number(f.size), Number(f.fee), Number(f.realized_pnl ?? 0), f.timestamp, JSON.stringify(f));
      // Order rows follow the fills too, also for fills that arrived while no stream was open.
      if (f.client_order_id) setFilled.run(this.cfg.network, f.client_order_id, Date.now(), f.client_order_id);
    }
  }
}
