import { existsSync, writeFileSync } from "node:fs";
import { accountStatusFrom, computeTargets, marketRulesFrom, planOrders, riskCheck, toStep, type Holding, type MarketRules, type RiskAction, type Rules } from "@tug/core";
import { bookTickers, markets as strikeMarkets, UserStream, type StrikeMarket } from "@tug/strike";
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
  keyFile: string;
  vaultId?: string;
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
  private flattenTries = 0;
  private riskBusy = false;
  private timers: NodeJS.Timeout[] = [];

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
      resync: () => void this.syncFills(),
      status: (s) => logEvent(this.db, "userstream", s.state === "closed" ? "warn" : "info", `user stream ${s.state}`, s.state === "closed" ? "E-WS" : undefined, s),
    }, { vaultId: this.cfg.vaultId });
    this.stream.start();
    const every = (ms: number, fn: () => Promise<void>) => this.timers.push(setInterval(() => void fn().catch((e) => this.fail(e)), ms));
    every(MARKS_EVERY_MS, () => this.readMarkets());
    every(RISK_EVERY_MS, () => this.riskTick());
    every(TRADE_EVERY_MS, () => this.tradeTick());
    every(60_000, () => this.syncFills());
    void this.readMarkets()
      .then(() => this.leverageForHeld())
      .then(() => this.riskTick())
      .catch((e) => this.fail(e));
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

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.stream?.stop();
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
        this.targets = computeTargets(gaps, acct.equity, this.rules, (s) => rules[s]?.minNotional ?? 5);
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
    if (w && !keep && this.mayPlace()) await this.placeWithRequote(w, 0);
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
