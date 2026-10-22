import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { TRADING, killFileFor } from "./config.js";
import type { Db } from "./db.js";
import { existsSync } from "node:fs";

export interface ApiContext {
  network: string;
  rulesSha256: string;
  rulesVersion: number;
  recordStartMs: number;
  revision: string;
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

  const marketRow = (l: LeanDbRow, marks: Map<string, { mark: number; funding_rate: number | null; bid: number | null; ask: number | null }>, model: Record<string, number>) => {
    const k = marks.get(l.symbol);
    const modelNotional = model[l.symbol] ?? 0;
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
      // Live trading has not started: the live position is flat. The model position is the paper record's.
      position: { live: { side: "flat", notional: 0 }, model: { side: modelNotional > 0 ? "long" : modelNotional < 0 ? "short" : "flat", notional: modelNotional } },
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
    const rows = (leansQ.all(s.id) as LeanDbRow[]).map((l) => marketRow(l, marks, model.positions));
    rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.symbol.localeCompare(b.symbol));
    return {
      network: ctx.network,
      snapshot: { id: s.id, at: s.started_at, finished_at: s.finished_at, read_copy: s.read_copy, read_fade: s.read_fade },
      rules: { version: ctx.rulesVersion, sha256: ctx.rulesSha256, record_start: ctx.recordStartMs },
      crowds: crowdQ.get(s.crowd_version) ?? null,
      model: model.row ? { equity: model.row.equity, start_equity: 10_000, at: model.row.ts } : null,
      live: { trading: TRADING, account: null },
      markets: rows,
    };
  });

  const historyQ = db.prepare(
    `SELECT s.started_at AS at, l.lean_copy, l.lean_fade, l.gap FROM leans l JOIN snapshots s ON s.id = l.snapshot_id
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
    const strikeSide = (crowd: "copy" | "fade") => {
      const rows = members.filter((m) => m.crowd === crowd && m.platform === "strike");
      return { n: rows.length, net: rows.reduce((a, m) => a + m.signed_notional, 0) };
    };
    return {
      network: ctx.network,
      snapshot: { id: s.id, at: s.started_at },
      market: marketRow(l, marks, loadModel().positions),
      top: { copy: top("copy"), fade: top("fade") },
      // Strike's own copy picks are listed by shortened id; Strike accounts on the fade side only in aggregate.
      strike: {
        copy: members.filter((m) => m.crowd === "copy" && m.platform === "strike").map((m) => ({ id: short(m.member_id), notional: m.signed_notional, score: m.copy_score })),
        fade: strikeSide("fade"),
      },
      history: historyQ.all(symbol, ctx.network, Date.now() - DAY),
    };
  });

  const recentQ = db.prepare("SELECT id, started_at, finished_at, status, read_copy, read_fade, errors FROM snapshots WHERE network=? ORDER BY id DESC LIMIT 12");
  const lastCrowdQ = db.prepare("SELECT id, pulled_at, copy_count, fade_count FROM crowd_versions WHERE network=? ORDER BY id DESC LIMIT 1");
  const eventCountQ = db.prepare("SELECT level, COUNT(*) AS n FROM events WHERE ts>=? AND level IN ('warn','error') GROUP BY level");
  const eventsQ = db.prepare("SELECT ts, component, level, code, message FROM events WHERE ts>=? AND level IN ('warn','error') ORDER BY ts DESC LIMIT 20");
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
      errors_24h: { warn: counts.warn ?? 0, error: counts.error ?? 0, recent: eventsQ.all(since) },
    };
  });

  return app;
}

export async function startApi(db: Db, ctx: ApiContext, port: number): Promise<FastifyInstance> {
  const app = buildApi(db, ctx);
  await app.listen({ host: "127.0.0.1", port });
  return app;
}
