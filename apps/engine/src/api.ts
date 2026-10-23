import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { allMappedMarkets, MAPPING_FINGERPRINTS, MAPPING_VERSION, publicSentence, type FeesSaved } from "@tug/core";
import { ROOT, TRADING, killFileFor } from "./config.js";
import type { Db } from "./db.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LLMS_TXT, OPENAPI } from "./openapi.js";

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
    };
  });

  const recentQ = db.prepare("SELECT id, started_at, finished_at, status, read_copy, read_fade, errors FROM snapshots WHERE network=? ORDER BY id DESC LIMIT 12");
  const lastCrowdQ = db.prepare("SELECT id, pulled_at, copy_count, fade_count FROM crowd_versions WHERE network=? ORDER BY id DESC LIMIT 1");
  const eventCountQ = db.prepare("SELECT level, COUNT(*) AS n FROM events WHERE ts>=? AND level IN ('warn','error') GROUP BY level");
  // The event's own message is never read here: the public reply carries the code's fixed sentence only.
  const eventsQ = db.prepare("SELECT ts, network, component, level, code FROM events WHERE ts>=? AND level IN ('warn','error') ORDER BY ts DESC LIMIT 20");
  const ordersQ = db.prepare("SELECT client_order_id, network, order_id, symbol, side, price, size, status, placed_at, updated_at FROM orders ORDER BY placed_at DESC LIMIT 10");
  const openCountQ = db.prepare("SELECT network, COUNT(*) AS n FROM orders WHERE status IN ('pending','open','partially_filled') GROUP BY network");

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
        kill_switch: { mainnet: existsSync(killFileFor("mainnet")) ? "on" : "off", testnet: existsSync(killFileFor("testnet")) ? "on" : "off" },
      },
      orders: { open: Object.fromEntries((openCountQ.all() as Array<{ network: string; n: number }>).map((r) => [r.network, r.n])), recent: ordersQ.all() },
      errors_24h: {
        warn: counts.warn ?? 0,
        error: counts.error ?? 0,
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

  app.get<{ Querystring: { network?: string } }>("/api/v1/record", async (req, reply) => {
    const network = req.query.network ?? "mainnet";
    if (network !== "mainnet" && network !== "testnet") return reply.code(400).send({ code: "E-NETWORK", message: "network is mainnet or testnet." });
    const curve = (paperAllQ.all() as Array<{ ts: number; equity: number }>).map((p) => ({ at: p.ts, equity: p.equity }));
    return {
      network,
      // The live account: real money on mainnet, test money on testnet (labelled TESTNET). The vault comes later.
      live: liveRecord(network),
      vault: null,
      paper: network === "mainnet" && paperSummary() ? { ...paperSummary()!, curve } : null,
    };
  });

  app.get<{ Querystring: { network?: string } }>("/api/v1/record/fills", async (req, reply) => {
    const network = req.query.network ?? "mainnet";
    if (network !== "mainnet" && network !== "testnet") return reply.code(400).send({ code: "E-NETWORK", message: "network is mainnet or testnet." });
    const fills = fillsQ.all(network) as Array<{ ts: number; symbol: string; side: string; role: string | null; price: number; size: number; fee: number; realized_pnl: number; order_id: number | null; client_order_id: string | null }>;
    // Negative fee = maker rebate. Strike's fill history can omit the client order id; Strike's order id is always kept.
    return { network, strike_fills: network === "mainnet" ? (strikeLinks()?.strike_fills ?? null) : null, fills: fills.map((x) => ({ at: x.ts, symbol: x.symbol, side: x.side, role: x.role, price: x.price, size: x.size, fee: x.fee, realized: x.realized_pnl, order_id: x.order_id, client_order_id: x.client_order_id })) };
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

  app.get("/api/v1/proof", async () => {
    const fees = recordJsonQ.get("fees_saved") as { computed_at: number; json: string } | undefined;
    const counts = Object.fromEntries((snapCountQ.all(ctx.network, ctx.recordStartMs) as Array<{ status: string; n: number }>).map((r) => [r.status.toLowerCase(), r.n]));
    return {
      rules: evidence("rules-fingerprints.json"),
      mapping: { version: MAPPING_VERSION, fingerprint: MAPPING_FINGERPRINTS[MAPPING_VERSION] ?? null, markets_covered: allMappedMarkets().length },
      snapshots_since_record_start: { complete: counts.complete ?? 0, partial: counts.partial ?? 0, interrupted: counts.interrupted ?? 0 },
      fees_saved: fees ? { computed_at: fees.computed_at, ...(JSON.parse(fees.json) as FeesSaved | null ?? {}) } : null,
      // Depth added is measured while TUG's orders rest on Strike's books.
      depth_added: null,
      evidence: { code: "https://github.com/Jennycruzy/tug", data: "https://github.com/Jennycruzy/tug-evidence" },
    };
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
