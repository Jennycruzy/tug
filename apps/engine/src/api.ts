import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { allMappedMarkets, depthSummary, MAPPING_FINGERPRINTS, MAPPING_VERSION, publicSentence, type FeesSaved } from "@tug/core";
import { ROOT, TRADING, killFileFor } from "./config.js";
import type { Db } from "./db.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LLMS_TXT, OPENAPI } from "./openapi.js";
import type { Connect } from "./connect.js";

export interface ApiContext {
  network: string;
  rulesSha256: string;
  rulesVersion: number;
  recordStartMs: number;
  revision: string;
  /** All money put into the live account, top-ups included (TUG_START_EQUITY); otherwise its first stored minute. */
  liveStartEquity?: number;
  /** The live account's Strike id: shortened in text, in full only inside links to Strike's own public records. */
  liveAccountId?: string;
  /** The live account's nickname on Strike, for its public trader page. */
  liveNickname?: string;
  /** The checkout of the evidence repository, served file by file for the browser check (`/check`). */
  evidenceDir?: string;
  /** Builder Connect (TUG in your account), when TUG_KEK is set. */
  connect?: Connect;
}

interface SnapshotRow {
  id: number;
  crowd_version: number;
  started_at: number;
  finished_at: number | null;
  read_copy: number | null;
  read_fade: number | null;
  status: string;
  errors: number;
}

interface LeanDbRow {
  symbol: string;
  long_copy: number;
  short_copy: number;
  lean_copy: number;
  n_copy: number;
  long_fade: number;
  short_fade: number;
  lean_fade: number;
  n_fade: number;
  gap: number;
  tradable: number;
  reason: string;
}

const SYMBOL = /^[A-Z0-9]{1,16}-USD$/;
const STRIKE_FADE_MIN_FOR_SIZE = 3;
const DAY = 86_400_000;

/** Shortened public id: Hyperliquid addresses and Strike account ids alike. */
const short = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/**
 * Read-only public API. Every reply is built from rows the engine already stored, so a request never
 * calls Strike or Hyperliquid.
 */
export function buildApi(db: Db, ctx: ApiContext): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: "127.0.0.1" });
  const startedAt = Date.now();

  void app.register(cors, { origin: "*", methods: ["GET"] });
  void app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

  const latestQ = db.prepare(
    "SELECT * FROM snapshots WHERE network=? AND status='COMPLETE' ORDER BY id DESC LIMIT 1",
  );
  const leansQ = db.prepare("SELECT * FROM leans WHERE snapshot_id=? ORDER BY symbol");
  const marksQ = db.prepare("SELECT symbol, mark, funding_rate, bid, ask FROM marks WHERE snapshot_id=?");
  const crowdQ = db.prepare("SELECT id, pulled_at, copy_count, fade_count, member_hash FROM crowd_versions WHERE id=?");
  const paperQ = db.prepare("SELECT snapshot_id, ts, equity, positions_json FROM paper ORDER BY snapshot_id DESC LIMIT 1");

  const latest = () => latestQ.get(ctx.network) as SnapshotRow | undefined;

  const liveLastQ = db.prepare("SELECT ts, equity, positions_json FROM live_equity WHERE network=? ORDER BY ts DESC LIMIT 1");
  /** The live account's positions at its latest stored minute (signed size per market). */
  const livePositions = (network: string): Record<string, { size: string; entry: number; upnl: number }> => {
    const r = liveLastQ.get(network) as { positions_json: string } | undefined;
    return r ? (JSON.parse(r.positions_json) as Record<string, { size: string; entry: number; upnl: number }>) : {};
  };
  const side = (v: number) => (v > 0 ? "long" : v < 0 ? "short" : "flat") as "long" | "short" | "flat";

  const marketRow = (l: LeanDbRow, marks: Map<string, { mark: number; funding_rate: number | null; bid: number | null; ask: number | null }>, model: Record<string, number>, live: Record<string, { size: string }>) => {
    const k = marks.get(l.symbol);
    const modelNotional = model[l.symbol] ?? 0;
    const liveNotional = live[l.symbol] && k?.mark ? Number(live[l.symbol]!.size) * k.mark : 0;
    return {
      symbol: l.symbol,
      copy: { long: l.long_copy, short: l.short_copy, lean: l.lean_copy, n: l.n_copy },
      fade: { long: l.long_fade, short: l.short_fade, lean: l.lean_fade, n: l.n_fade },
      gap: l.gap,
      tradable: l.tradable === 1,
      reason: l.reason,
      mark: k?.mark ?? null,
      funding_rate: k?.funding_rate ?? null,
      bid: k?.bid ?? null,
      ask: k?.ask ?? null,
      // The live position is the live account's at its latest stored minute; the model position is the paper record's.
      position: { live: { side: side(liveNotional), notional: liveNotional }, model: { side: side(modelNotional), notional: modelNotional } },
    };
  };

  const loadModel = () => {
    const p = paperQ.get() as { snapshot_id: number; ts: number; equity: number; positions_json: string } | undefined;
    return { row: p, positions: p ? (JSON.parse(p.positions_json) as Record<string, number>) : {} };
  };

  app.get("/api/v1/tug", async (_req, reply) => {
    const s = latest();
    if (!s) return reply.code(503).send({ code: "E-NO-DATA", message: "No complete snapshot yet; the first one lands within 5 minutes." });
    const marks = new Map((marksQ.all(s.id) as Array<{ symbol: string; mark: number; funding_rate: number | null; bid: number | null; ask: number | null }>).map((m) => [m.symbol, m]));
    const model = loadModel();
    const live = ctx.network === "mainnet" ? livePositions("mainnet") : {};
    const rows = (leansQ.all(s.id) as LeanDbRow[]).map((l) => marketRow(l, marks, model.positions, live));
    rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.symbol.localeCompare(b.symbol));
    return {
      network: ctx.network,
      snapshot: { id: s.id, at: s.started_at, finished_at: s.finished_at, read_copy: s.read_copy, read_fade: s.read_fade },
      rules: { version: ctx.rulesVersion, sha256: ctx.rulesSha256, record_start: ctx.recordStartMs },
      crowds: crowdQ.get(s.crowd_version) ?? null,
      model: model.row ? { equity: model.row.equity, start_equity: 10_000, at: model.row.ts } : null,
      live: { trading: TRADING && !existsSync(killFileFor(ctx.network)), account: ctx.liveAccountId ? short(ctx.liveAccountId) : null },
      markets: rows,
    };
  });

  const historyQ = db.prepare(
    `SELECT s.started_at AS at, l.lean_copy, l.lean_fade, l.n_copy, l.n_fade, l.gap FROM leans l JOIN snapshots s ON s.id = l.snapshot_id
     WHERE l.symbol=? AND s.network=? AND s.status='COMPLETE' AND s.started_at>=? ORDER BY s.id`,
  );
  const membersQ = db.prepare(
    `SELECT p.platform, p.member_id, p.crowd, p.signed_notional, m.copy_score
     FROM positions p LEFT JOIN crowd_members m ON m.version_id=? AND m.platform=p.platform AND m.member_id=p.member_id
     WHERE p.snapshot_id=? AND p.symbol=?`,
  );

  const marketTradesQ = db.prepare(
    "SELECT f.ts AS at, f.side, f.size, f.price, f.role, f.fee, f.realized_pnl AS realized, (SELECT o.reason FROM orders o WHERE o.network=f.network AND (o.order_id=f.order_id OR o.client_order_id=f.client_order_id) LIMIT 1) AS why, f.order_id FROM fills f WHERE f.network='mainnet' AND f.symbol=? ORDER BY f.ts DESC LIMIT 10",
  );
  app.get<{ Params: { symbol: string } }>("/api/v1/tug/:symbol", async (req, reply) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!SYMBOL.test(symbol)) return reply.code(400).send({ code: "E-SYMBOL", message: "Markets look like ETH-USD." });
    const s = latest();
    if (!s) return reply.code(503).send({ code: "E-NO-DATA", message: "No complete snapshot yet; the first one lands within 5 minutes." });
    const l = (leansQ.all(s.id) as LeanDbRow[]).find((r) => r.symbol === symbol);
    if (!l) return reply.code(404).send({ code: "E-SYMBOL", message: `${symbol} is not one of the markets TUG reads.` });
    const marks = new Map((marksQ.all(s.id) as Array<{ symbol: string; mark: number; funding_rate: number | null; bid: number | null; ask: number | null }>).map((m) => [m.symbol, m]));
    const members = membersQ.all(s.crowd_version, s.id, symbol) as Array<{ platform: string; member_id: string; crowd: "copy" | "fade"; signed_notional: number; copy_score: number | null }>;
    const top = (crowd: "copy" | "fade") =>
      members
        .filter((m) => m.crowd === crowd && m.platform === "hyperliquid")
        .sort((a, b) => Math.abs(b.signed_notional) - Math.abs(a.signed_notional))
        .slice(0, 10)
        .map((m) => ({ id: short(m.member_id), notional: m.signed_notional, score: m.copy_score }));
    // Strike's own fade picks: a count, and their net size only when at least three hold the market,
    // so no single account's position can be read from the total.
    const strikeFade = () => {
      const rows = members.filter((m) => m.crowd === "fade" && m.platform === "strike");
      return { n: rows.length, net: rows.length >= STRIKE_FADE_MIN_FOR_SIZE ? rows.reduce((a, m) => a + m.signed_notional, 0) : null };
    };
    return {
      network: ctx.network,
      snapshot: { id: s.id, at: s.started_at },
      market: marketRow(l, marks, loadModel().positions, ctx.network === "mainnet" ? livePositions("mainnet") : {}),
      top: { copy: top("copy"), fade: top("fade") },
      // Strike's own copy picks are listed by shortened id; Strike accounts on the fade side only in aggregate.
      strike: {
        copy: members.filter((m) => m.crowd === "copy" && m.platform === "strike").map((m) => ({ id: short(m.member_id), notional: m.signed_notional, score: m.copy_score })),
        fade: strikeFade(),
      },
      history: historyQ.all(symbol, ctx.network, Date.now() - DAY),
      // TUG's last live fills in this market, each with the one line its order was placed for.
      trades: (marketTradesQ.all(symbol) as Array<{ at: number; side: string; size: number; price: number; role: string | null; fee: number; realized: number; why: string | null; order_id: number | null }>),
    };
  });

  const recentQ = db.prepare("SELECT id, started_at, finished_at, status, read_copy, read_fade, errors FROM snapshots WHERE network=? ORDER BY id DESC LIMIT 12");
  const lastCrowdQ = db.prepare("SELECT id, pulled_at, copy_count, fade_count FROM crowd_versions WHERE network=? ORDER BY id DESC LIMIT 1");
  const eventCountQ = db.prepare("SELECT level, COUNT(*) AS n FROM events WHERE ts>=? AND level IN ('warn','error') GROUP BY level");
  // The event's own message is never read here: the public reply carries the code's fixed sentence only.
  const lastErrorQ = db.prepare("SELECT MAX(ts) AS ts FROM events WHERE ts>=? AND level='error'");
  const eventsQ = db.prepare("SELECT ts, network, component, level, code FROM events WHERE ts>=? AND level IN ('warn','error') ORDER BY ts DESC LIMIT 20");
  const ordersQ = db.prepare("SELECT client_order_id, network, order_id, symbol, side, price, size, status, placed_at, updated_at FROM orders WHERE network IN ('mainnet','testnet','vault') ORDER BY placed_at DESC LIMIT 10");
  // Public status shows TUG's own accounts only; a connected person's orders are theirs.
  const openCountQ = db.prepare("SELECT network, COUNT(*) AS n FROM orders WHERE status IN ('pending','open','partially_filled') AND network IN ('mainnet','testnet','vault') GROUP BY network");

  app.get("/api/v1/status", async () => {
    const since = Date.now() - DAY;
    const recent = recentQ.all(ctx.network) as SnapshotRow[];
    const last = recent.find((r) => r.status === "COMPLETE");
    const counts = Object.fromEntries((eventCountQ.all(since) as Array<{ level: string; n: number }>).map((r) => [r.level, r.n]));
    return {
      network: ctx.network,
      now: Date.now(),
      engine: { started_at: startedAt, revision: ctx.revision, rules_sha256: ctx.rulesSha256 },
      recorder: {
        last_complete: last ? { id: last.id, at: last.started_at, finished_at: last.finished_at, read_copy: last.read_copy, read_fade: last.read_fade } : null,
        recent: recent.map((r) => ({ id: r.id, at: r.started_at, status: r.status, errors: r.errors })),
      },
      crowds: lastCrowdQ.get(ctx.network) ?? null,
      trading: {
        mainnet: TRADING ? "on" : "off",
        kill_switch: { mainnet: existsSync(killFileFor("mainnet")) ? "on" : "off", testnet: existsSync(killFileFor("testnet")) ? "on" : "off", vault: existsSync(killFileFor("vault")) ? "on" : "off" },
      },
      orders: { open: Object.fromEntries((openCountQ.all() as Array<{ network: string; n: number }>).map((r) => [r.network, r.n])), recent: ordersQ.all() },
      errors_24h: {
        warn: counts.warn ?? 0,
        error: counts.error ?? 0,
        last_error_at: (lastErrorQ.get(since) as { ts: number | null }).ts,
        recent: (eventsQ.all(since) as Array<{ ts: number; network: string | null; component: string; level: string; code: string | null }>).map((e) => ({ ...e, message: publicSentence(e.code) })),
      },
    };
  });

  const evidence = (file: string) => JSON.parse(readFileSync(join(ROOT, "evidence", file), "utf8")) as unknown;
  const lastCrowd = db.prepare("SELECT id, pulled_at, copy_count, fade_count, member_hash, raw_sha256 FROM crowd_versions WHERE network=? ORDER BY id DESC LIMIT 1");
  const crowdMembersQ = db.prepare("SELECT platform, member_id, crowd, copy_score FROM crowd_members WHERE version_id=? ORDER BY crowd, copy_score DESC, member_id");
  const paperAllQ = db.prepare("SELECT snapshot_id, ts, equity, turnover, fees, funding FROM paper ORDER BY snapshot_id");
  const paperLastQ = db.prepare("SELECT snapshot_id, ts, equity, turnover, fees, funding, positions_json FROM paper ORDER BY snapshot_id DESC LIMIT 1");
  const lastTargetsQ = db.prepare("SELECT snapshot_id, symbol, target_usd FROM targets WHERE snapshot_id=(SELECT MAX(snapshot_id) FROM targets) ORDER BY symbol");
  const boardSumQ = db.prepare("SELECT * FROM scoreboard_summary WHERE id=1");
  const boardRowsQ = db.prepare("SELECT crowd, symbol, pnl_usd FROM scoreboard ORDER BY symbol, crowd");
  const recordJsonQ = db.prepare("SELECT computed_at, json FROM records_json WHERE name=?");
  const snapCountQ = db.prepare("SELECT status, COUNT(*) AS n FROM snapshots WHERE network=? AND started_at>=? GROUP BY status");

  const START_EQUITY = 10_000;
  const paperSummary = () => {
    const p = paperLastQ.get() as { snapshot_id: number; ts: number; equity: number; turnover: number; fees: number; funding: number; positions_json: string } | undefined;
    if (!p) return null;
    const positions = Object.entries(JSON.parse(p.positions_json) as Record<string, number>)
      .filter(([, v]) => Math.abs(v) >= 1)
      .map(([symbol, notional]) => ({ symbol, notional }))
      .sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));
    return { label: "MODEL", start_equity: START_EQUITY, start: ctx.recordStartMs, at: p.ts, snapshot_id: p.snapshot_id, equity: p.equity, turnover: p.turnover, fees: p.fees, funding: p.funding, positions };
  };

  app.get("/api/v1/crowds", async (_req, reply) => {
    const c = lastCrowd.get(ctx.network) as { id: number; pulled_at: number; copy_count: number; fade_count: number; member_hash: string; raw_sha256: string } | undefined;
    if (!c) return reply.code(503).send({ code: "E-NO-DATA", message: "No crowd list yet; the first one is built when the engine starts." });
    const rows = crowdMembersQ.all(c.id) as Array<{ platform: string; member_id: string; crowd: "copy" | "fade"; copy_score: number | null }>;
    const count = (crowd: string, platform: string) => rows.filter((r) => r.crowd === crowd && r.platform === platform).length;
    const scores = (crowd: string) => {
      const v = rows.filter((r) => r.crowd === crowd && r.copy_score !== null).map((r) => r.copy_score!);
      return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
    };
    return {
      network: ctx.network,
      version: { id: c.id, pulled_at: c.pulled_at, member_hash: c.member_hash, raw_sha256: c.raw_sha256 },
      counts: {
        copy: { total: c.copy_count, hyperliquid: count("copy", "hyperliquid"), strike: count("copy", "strike") },
        fade: { total: c.fade_count, hyperliquid: count("fade", "hyperliquid"), strike: count("fade", "strike") },
      },
      score_range: { copy: scores("copy"), fade: scores("fade") },
      members: {
        hyperliquid: rows.filter((r) => r.platform === "hyperliquid").map((r) => ({ address: r.member_id, crowd: r.crowd, score: r.copy_score })),
        // Strike's own traders: copy picks by shortened id; fade picks only as a count.
        strike_copy: rows.filter((r) => r.platform === "strike" && r.crowd === "copy").map((r) => ({ id: short(r.member_id), score: r.copy_score })),
        strike_fade: { n: count("fade", "strike") },
      },
    };
  });

  const liveCurveQ = db.prepare("SELECT ts, equity FROM live_equity WHERE network=? ORDER BY ts");
  const fillsQ = db.prepare(
    "SELECT ts, symbol, side, role, price, size, fee, realized_pnl, order_id, client_order_id FROM fills WHERE network=? ORDER BY ts DESC, fill_id DESC LIMIT 500",
  );
  const fillSumQ = db.prepare(
    "SELECT COUNT(*) AS n, SUM(role='maker') AS maker, COALESCE(SUM(fee),0) AS fees, COALESCE(SUM(realized_pnl),0) AS realized, COALESCE(SUM(price*size),0) AS traded FROM fills WHERE network=?",
  );
  const transfersQ = db.prepare("SELECT ts, type, amount, tx_hash FROM transfers WHERE network=? AND type IN ('deposit','withdraw') AND status='settled' ORDER BY ts, id");
  /** Links to Strike's own public records of the live account (mainnet). */
  const strikeLinks = () =>
    ctx.liveAccountId
      ? {
          strike_page: `https://app.strikefinance.org/public-portfolio/${ctx.liveNickname ? `@${ctx.liveNickname}` : ctx.liveAccountId}`,
          strike_fills: `https://api.strikefinance.org/v2/history/fill?account_id=${ctx.liveAccountId}`,
          strike_positions: `https://api.strikefinance.org/v2/positions?account_id=${ctx.liveAccountId}`,
          strike_deposits: `https://api.strikefinance.org/v2/history/transaction?account_id=${ctx.liveAccountId}&type=deposit,withdraw`,
        }
      : null;

  /**
   * The live account's record from stored rows only: equity each minute (one point per 5 minutes served), fills,
   * positions. Money put in comes from Strike's own deposit and withdrawal records; the curve's `result` is equity
   * minus the money put in up to that moment, so a top-up is never drawn as a gain.
   */
  const liveRecord = (network: string) => {
    const curve = liveCurveQ.all(network) as Array<{ ts: number; equity: number }>;
    if (curve.length === 0) return null;
    const first = curve[0]!;
    const last = curve[curve.length - 1]!;
    const f = fillSumQ.get(network) as { n: number; maker: number | null; fees: number; realized: number; traded: number };
    const moves = (transfersQ.all(network) as Array<{ ts: number; type: string; amount: number; tx_hash: string | null }>).map((t) => ({
      at: t.ts,
      type: t.type as "deposit" | "withdraw",
      amount: t.type === "deposit" ? Math.abs(t.amount) : -Math.abs(t.amount),
      tx_hash: t.tx_hash,
    }));
    const fallback = network === "mainnet" && ctx.liveStartEquity ? ctx.liveStartEquity : first.equity;
    const putInAt = (ts: number) => (moves.length ? moves.filter((m) => m.at <= ts).reduce((a, m) => a + m.amount, 0) : fallback);
    const startEquity = moves.length ? moves.reduce((a, m) => a + m.amount, 0) : fallback;
    const step = 5 * 60_000;
    // Keep each 5-minute bucket's first point, the last point, and the minutes either side of every deposit or withdrawal.
    const near = (ts: number) => moves.some((m) => Math.abs(m.at - ts) <= 60_000);
    const thinned = curve.filter((p, i) => i === 0 || i === curve.length - 1 || near(p.ts) || Math.floor(p.ts / step) !== Math.floor(curve[i - 1]!.ts / step));
    return {
      label: network === "mainnet" ? "LIVE" : "TESTNET",
      account: network === "mainnet" && ctx.liveAccountId ? short(ctx.liveAccountId) : null,
      start_equity: startEquity,
      start: first.ts,
      at: last.ts,
      equity: last.equity,
      fills: f.n,
      maker_fills: f.maker ?? 0,
      traded: f.traded,
      fees: f.fees,
      realized: f.realized,
      positions: Object.entries(livePositions(network)).map(([symbol, p]) => ({ symbol, size: Number(p.size), entry: p.entry, upnl: p.upnl })),
      money_moves: moves,
      links: network === "mainnet" ? strikeLinks() : null,
      curve: thinned.map((p) => {
        const putIn = putInAt(p.ts);
        return { at: p.ts, equity: p.equity, put_in: putIn, result: p.equity - putIn };
      }),
    };
  };

  const vaultIdQ = db.prepare("SELECT vault_id FROM vault_points ORDER BY ts DESC LIMIT 1");
  const vaultPointsQ = db.prepare("SELECT ts, share_price, equity, total_shares, raw FROM vault_points WHERE vault_id=? ORDER BY ts");
  const vaultMovesQ = db.prepare("SELECT id, type, account_id, status, ts, usd, shares, share_price, execute_at, executed_at FROM vault_moves WHERE vault_id=? ORDER BY ts DESC");
  const TESTNET_API = "https://api-v2-testnet.strikefinance.org";

  /**
   * The testnet vault's record (labelled TESTNET), from stored rows only: Strike's share price each minute (one
   * point per 5 minutes served), every deposit and withdrawal with Strike's status, the vault's own fills and
   * positions, and links to Strike's public vault records.
   */
  const vaultRecord = () => {
    const row = vaultIdQ.get() as { vault_id: string } | undefined;
    if (!row) return null;
    const id = row.vault_id;
    const points = vaultPointsQ.all(id) as Array<{ ts: number; share_price: number; equity: number; total_shares: number; raw: string }>;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const v = JSON.parse(last.raw) as { name?: string; status?: string; lockup_days?: number; leader_commission_bps?: number; leader_account_id?: string };
    const f = fillSumQ.get("vault") as { n: number; maker: number | null; fees: number; realized: number; traded: number };
    const step = 5 * 60_000;
    const thinned = points.filter((p, i) => i === 0 || i === points.length - 1 || Math.floor(p.ts / step) !== Math.floor(points[i - 1]!.ts / step));
    const moves = vaultMovesQ.all(id) as Array<{ id: string; type: string; account_id: string | null; status: string; ts: number; usd: number | null; shares: number | null; share_price: number | null; execute_at: number | null; executed_at: number | null }>;
    return {
      label: "TESTNET" as const,
      vault_id: id,
      name: v.name ?? "TUG",
      status: v.status ?? "unknown",
      lockup_days: v.lockup_days ?? null,
      leader_fee_bps: v.leader_commission_bps ?? null,
      start: first.ts,
      at: last.ts,
      share_price: last.share_price,
      start_share_price: first.share_price,
      equity: last.equity,
      total_shares: last.total_shares,
      fills: f.n,
      maker_fills: f.maker ?? 0,
      traded: f.traded,
      fees: f.fees,
      realized: f.realized,
      positions: Object.entries(livePositions("vault")).map(([symbol, p]) => ({ symbol, size: Number(p.size), entry: p.entry, upnl: p.upnl })),
      moves: moves.map((m) => ({
        id: m.id,
        type: m.type as "deposit" | "withdrawal",
        who: (m.account_id && m.account_id === v.leader_account_id ? "leader" : "depositor") as "leader" | "depositor",
        account: m.account_id ? short(m.account_id) : null,
        status: m.status,
        at: m.ts,
        usd: m.usd,
        shares: m.shares,
        share_price: m.share_price,
        execute_at: m.execute_at,
        executed_at: m.executed_at,
      })),
      links: {
        strike_vault_page: `https://testnet.strikefinance.org/vaults/${id}`,
        strike_vault: `${TESTNET_API}/v2/vault/${id}`,
        strike_history: `${TESTNET_API}/v2/vault/${id}/history`,
        strike_fills: `${TESTNET_API}/v2/history/fill?vault_id=${id}`,
        strike_positions: `${TESTNET_API}/v2/positions?vault_id=${id}`,
      },
      curve: thinned.map((p) => ({ at: p.ts, share_price: p.share_price, equity: p.equity })),
    };
  };

  app.get<{ Querystring: { network?: string } }>("/api/v1/record", async (req, reply) => {
    const network = req.query.network ?? "mainnet";
    if (network !== "mainnet" && network !== "testnet") return reply.code(400).send({ code: "E-NETWORK", message: "network is mainnet or testnet." });
    const curve = (paperAllQ.all() as Array<{ ts: number; equity: number }>).map((p) => ({ at: p.ts, equity: p.equity }));
    return {
      network,
      // The live account: real money on mainnet, test money on testnet (labelled TESTNET); the vault is testnet only.
      live: liveRecord(network),
      vault: vaultRecord(),
      paper: network === "mainnet" && paperSummary() ? { ...paperSummary()!, curve } : null,
    };
  });

  app.get<{ Querystring: { network?: string } }>("/api/v1/record/fills", async (req, reply) => {
    const network = req.query.network ?? "mainnet";
    if (network !== "mainnet" && network !== "testnet" && network !== "vault") return reply.code(400).send({ code: "E-NETWORK", message: "network is mainnet, testnet or vault." });
    const fills = fillsQ.all(network) as Array<{ ts: number; symbol: string; side: string; role: string | null; price: number; size: number; fee: number; realized_pnl: number; order_id: number | null; client_order_id: string | null }>;
    // Negative fee = maker rebate. Strike's fill history can omit the client order id; Strike's order id is always kept.
    const vaultFills = network === "vault" ? (vaultRecord()?.links.strike_fills ?? null) : null;
    return { network, strike_fills: network === "mainnet" ? (strikeLinks()?.strike_fills ?? null) : vaultFills, fills: fills.map((x) => ({ at: x.ts, symbol: x.symbol, side: x.side, role: x.role, price: x.price, size: x.size, fee: x.fee, realized: x.realized_pnl, order_id: x.order_id, client_order_id: x.client_order_id })) };
  });

  app.get("/api/v1/paper", async () => {
    const t = lastTargetsQ.all() as Array<{ snapshot_id: number; symbol: string; target_usd: number }>;
    return {
      ...paperSummary(),
      last_rebalance: t.length ? { snapshot_id: t[0]!.snapshot_id, targets: t.map((r) => ({ symbol: r.symbol, target: r.target_usd })) } : null,
      curve: (paperAllQ.all() as Array<{ snapshot_id: number; ts: number; equity: number; turnover: number; fees: number; funding: number }>).map((p) => ({
        snapshot_id: p.snapshot_id,
        at: p.ts,
        equity: p.equity,
        turnover: p.turnover,
        fees: p.fees,
        funding: p.funding,
      })),
    };
  });

  app.get("/api/v1/scoreboard", async () => {
    const sum = boardSumQ.get() as
      | { from_ts: number; to_ts: number; copy_pnl: number; fade_pnl: number; copy_up: number; copy_active: number; fade_up: number; fade_active: number; snapshots: number }
      | undefined;
    const rows = boardRowsQ.all() as Array<{ crowd: "copy" | "fade"; symbol: string; pnl_usd: number }>;
    const markets = [...new Set(rows.map((r) => r.symbol))].map((symbol) => ({
      symbol,
      copy: rows.find((r) => r.symbol === symbol && r.crowd === "copy")?.pnl_usd ?? 0,
      fade: rows.find((r) => r.symbol === symbol && r.crowd === "fade")?.pnl_usd ?? 0,
    }));
    return {
      since_record_start: sum
        ? {
            from: sum.from_ts,
            to: sum.to_ts,
            snapshots: sum.snapshots,
            copy: { pnl: sum.copy_pnl, up: sum.copy_up, active: sum.copy_active },
            fade: { pnl: sum.fade_pnl, up: sum.fade_up, active: sum.fade_active },
            markets,
          }
        : null,
      before_record: evidence("pre-record/stats_7d.json"),
    };
  });

  const depthQ = db.prepare("SELECT ts, symbol, side, tug_size, at_best, best_total, top5_total FROM depth_samples WHERE network=? ORDER BY ts");
  const makerQ = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(role='maker'),0) AS maker, COALESCE(SUM(CASE WHEN role='maker' THEN price*size END),0) AS vol, COALESCE(SUM(CASE WHEN fee<0 THEN -fee END),0) AS rebates FROM fills WHERE network=?");
  /** Depth added on the live account (mainnet): the minute samples summed up, with its maker fills and rebates. */
  const depthAdded = (network: string) => {
    const rows = depthQ.all(network) as Array<{ ts: number; symbol: string; side: string; tug_size: number; at_best: number; best_total: number; top5_total: number }>;
    const d = depthSummary(rows.map((r) => ({ ts: r.ts, symbol: r.symbol, side: r.side, tugSize: r.tug_size, atBest: r.at_best === 1, bestTotal: r.best_total, top5Total: r.top5_total })));
    const m = makerQ.get(network) as { n: number; maker: number; vol: number; rebates: number };
    return {
      network,
      since: rows[0]?.ts ?? null,
      minutes_resting: d.minutesResting,
      markets: d.markets.map((x) => ({ symbol: x.symbol, minutes_resting: x.minutesResting, minutes_at_best: x.minutesAtBest, avg_share_of_best: x.avgShareOfBest, avg_share_of_top5: x.avgShareOfTop5 })),
      maker_fills: m.maker,
      fills: m.n,
      maker_volume: m.vol,
      rebates: m.rebates,
    };
  };

  app.get("/api/v1/proof", async () => {
    const fees = recordJsonQ.get("fees_saved") as { computed_at: number; json: string } | undefined;
    const counts = Object.fromEntries((snapCountQ.all(ctx.network, ctx.recordStartMs) as Array<{ status: string; n: number }>).map((r) => [r.status.toLowerCase(), r.n]));
    return {
      rules: evidence("rules-fingerprints.json"),
      mapping: { version: MAPPING_VERSION, fingerprint: MAPPING_FINGERPRINTS[MAPPING_VERSION] ?? null, markets_covered: allMappedMarkets().length },
      snapshots_since_record_start: { complete: counts.complete ?? 0, partial: counts.partial ?? 0, interrupted: counts.interrupted ?? 0 },
      fees_saved: fees ? { computed_at: fees.computed_at, ...(JSON.parse(fees.json) as FeesSaved | null ?? {}) } : null,
      // Depth added is measured each minute while TUG's orders rest on Strike's books (from 23 Oct).
      depth_added: depthAdded("mainnet"),
      evidence: { code: "https://github.com/Jennycruzy/tug", data: "https://github.com/Jennycruzy/tug-evidence" },
    };
  });

  // TUG in your account (Builder Connect, testnet): each step answers {code, message} on failure. The control
  // token goes in the x-tug-token header for reads, never in a URL.
  const connectStep = (fn: (c: Connect, body: unknown) => unknown) => async (req: { body: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!ctx.connect) return reply.code(503).send({ code: "E-CONN", message: "TUG in your account is not open yet." });
    try {
      return await fn(ctx.connect, req.body);
    } catch (e) {
      const err = e as { code?: string; message?: string; issues?: unknown };
      if (err.issues) return reply.code(400).send({ code: "E-INPUT", message: "Some of the details sent are not valid." });
      return reply.code(400).send({ code: err.code ?? "E-CONN", message: err.message ?? "Your wallet connection could not be verified." });
    }
  };
  app.get("/api/v1/connect/networks", async () => ctx.connect?.networks() ?? { testnet: false, mainnet: false });
  app.post("/api/v1/connect/start", connectStep((c, b) => c.start(b)));
  app.post("/api/v1/connect/verify", connectStep((c, b) => c.verify(b)));
  app.post("/api/v1/connect/activate", connectStep((c, b) => c.activate(b)));
  app.post("/api/v1/connect/stop", connectStep((c, b) => c.stop(b)));
  app.get<{ Params: { id: string } }>("/api/v1/connect/:id", async (req, reply) => {
    if (!ctx.connect) return reply.code(503).send({ code: "E-CONN", message: "TUG in your account is not open yet." });
    try {
      return ctx.connect.view(req.params.id, String(req.headers["x-tug-token"] ?? ""));
    } catch (e) {
      return reply.code(404).send({ code: "E-CONN", message: (e as Error).message });
    }
  });

  // The evidence bundle for `/check`: MANIFEST.sha256 and only the files it lists, read as they are on disk.
  app.get<{ Params: { "*": string } }>("/api/v1/evidence/*", async (req, reply) => {
    const dir = ctx.evidenceDir;
    const path = req.params["*"];
    const manifestFile = dir ? join(dir, "MANIFEST.sha256") : "";
    if (!dir || !existsSync(manifestFile)) return reply.code(404).send({ code: "E-EVIDENCE", message: "No evidence bundle yet." });
    const listed = new Set(readFileSync(manifestFile, "utf8").split("\n").filter(Boolean).map((l) => l.slice(66)));
    if (path !== "MANIFEST.sha256" && !listed.has(path)) return reply.code(404).send({ code: "E-EVIDENCE", message: "Not a file of the evidence bundle." });
    return reply.type(path.endsWith(".json") ? "application/json" : path.endsWith(".sha256") ? "text/plain; charset=utf-8" : "application/octet-stream").header("cache-control", "no-cache").send(readFileSync(join(dir, path)));
  });

  app.get("/api/openapi.json", async () => OPENAPI);
  app.get("/llms.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").send(LLMS_TXT));

  return app;
}

export async function startApi(db: Db, ctx: ApiContext, port: number): Promise<FastifyInstance> {
  const app = buildApi(db, ctx);
  await app.listen({ host: "127.0.0.1", port });
  return app;
}
