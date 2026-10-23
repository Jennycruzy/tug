import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { buildApi } from "../src/api.js";
import { Executor } from "../src/executor.js";
import { Trader } from "../src/trader.js";
import type { Db } from "../src/db.js";
import { OPENAPI } from "../src/openapi.js";
import { fixtureDb } from "./fixture-db.js";
import { check } from "./schema-check.js";

// Real rows from the TUG mainnet database: the live account's minutes and its two fills (23 Oct, 01:20–03:20 UTC).
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/live-mainnet-2026-10-23.json", import.meta.url), "utf8")) as {
  live_equity: Array<{ network: string; ts: number; equity: number; positions_json: string }>;
  fills: Array<Record<string, string | number | null>>;
};
const ACCOUNT = "01a16637-81cb-7682-b614-4728271550aa";
const root = OPENAPI as unknown as { components: { schemas: Record<string, Record<string, unknown>> }; paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> }>> };
const schemaOf = (path: string) => root.paths[path]!.get!.responses["200"]!.content["application/json"].schema;

function withLive(db: Db, upTo = Infinity): Db {
  const eq = db.prepare("INSERT INTO live_equity (network, ts, equity, positions_json) VALUES (?,?,?,?)");
  for (const r of LIVE.live_equity.filter((r) => r.ts <= upTo)) eq.run(r.network, r.ts, r.equity, r.positions_json);
  const f = db.prepare(
    "INSERT INTO fills (network, fill_id, trade_id, order_id, client_order_id, symbol, side, role, price, size, fee, realized_pnl, ts, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'null')",
  );
  for (const x of LIVE.fills.filter((x) => Number(x.ts) <= upTo)) f.run(x.network, x.fill_id, x.trade_id, x.order_id, x.client_order_id, x.symbol, x.side, x.role, x.price, x.size, x.fee, x.realized_pnl, x.ts);
  return db;
}
const ctx = { network: "mainnet", rulesSha256: "0".repeat(64), rulesVersion: 1, recordStartMs: 0, revision: "test", liveStartEquity: 18.709836, liveAccountId: ACCOUNT };

describe("the live record (real mainnet rows)", () => {
  it("shows equity, both maker fills with their rebates, the realized result and a flat book", async () => {
    const app = buildApi(withLive(fixtureDb()), ctx);
    const r = await app.inject({ url: "/api/v1/record" });
    expect(r.statusCode).toBe(200);
    expect(check(r.json(), schemaOf("/api/v1/record"), root)).toEqual([]);
    const live = r.json().live;
    expect(live.label).toBe("LIVE");
    expect(live.start_equity).toBe(18.709836);
    expect(live.fills).toBe(2);
    expect(live.maker_fills).toBe(2);
    expect(live.fees).toBeCloseTo(-0.00046689 - 0.0004867, 10);
    expect(live.realized).toBeCloseTo(-0.39632, 10);
    expect(live.positions).toEqual([]);
    expect(live.equity).toBe(LIVE.live_equity.at(-1)!.equity);
    // One point per 5 minutes, first and last kept.
    expect(live.curve[0].at).toBe(LIVE.live_equity[0]!.ts);
    expect(live.curve.at(-1).at).toBe(LIVE.live_equity.at(-1)!.ts);
    expect(live.curve.length).toBeLessThan(LIVE.live_equity.length / 3);
    // The full account id appears only inside the links to Strike's own public records.
    expect(JSON.stringify({ ...live, links: null })).not.toContain(ACCOUNT);
    expect(live.links.strike_fills).toBe(`https://api.strikefinance.org/v2/history/fill?account_id=${ACCOUNT}`);
    await app.close();
  });

  it("lists fills newest first with Strike's order id, also when Strike left out the client order id", async () => {
    const app = buildApi(withLive(fixtureDb()), ctx);
    const r = await app.inject({ url: "/api/v1/record/fills" });
    expect(check(r.json(), schemaOf("/api/v1/record/fills"), root)).toEqual([]);
    const fills = r.json().fills as Array<{ side: string; role: string; fee: number; order_id: number; client_order_id: string | null }>;
    expect(fills.map((f) => f.side)).toEqual(["buy", "sell"]);
    expect(fills[0]).toMatchObject({ role: "maker", order_id: 11517512902, client_order_id: null });
    expect(fills[1]!.client_order_id).toBe("tug-v1-mainnet-1792718426518-1-CXMT-USD-0");
    expect(fills.every((f) => f.fee < 0)).toBe(true);
    await app.close();
  });

  it("each market shows the live account's position at its latest minute, and the account only by a short id", async () => {
    // Up to the minute after the first fill: TUG held 1.6 CXMT short.
    const held = LIVE.live_equity.find((r) => r.positions_json.includes("CXMT-USD"))!;
    const db = withLive(fixtureDb(), held.ts);
    const snap = db.prepare("SELECT MAX(id) AS id FROM snapshots WHERE status='COMPLETE'").get() as { id: number };
    const mark = db.prepare("SELECT mark FROM marks WHERE snapshot_id=? AND symbol='CXMT-USD'").get(snap.id) as { mark: number } | undefined;
    const app = buildApi(db, ctx);
    const r = await app.inject({ url: "/api/v1/tug" });
    expect(check(r.json(), schemaOf("/api/v1/tug"), root)).toEqual([]);
    const cxmt = (r.json().markets as Array<{ symbol: string; position: { live: { side: string; notional: number } } }>).find((m) => m.symbol === "CXMT-USD");
    expect(mark).toBeDefined();
    expect(cxmt!.position.live.side).toBe("short");
    expect(cxmt!.position.live.notional).toBeCloseTo(-1.6 * mark!.mark, 9);
    const others = (r.json().markets as Array<{ symbol: string; position: { live: { side: string } } }>).filter((m) => m.symbol !== "CXMT-USD");
    expect(others.every((m) => m.position.live.side === "flat")).toBe(true);
    expect(r.json().live.account).toBe("01a166…50aa");
    expect(r.body).not.toContain(ACCOUNT);
    await app.close();
  });

  it("with no live minutes stored, the record says so with null", async () => {
    const app = buildApi(fixtureDb(), ctx);
    expect((await app.inject({ url: "/api/v1/record" })).json().live).toBeNull();
    expect((await app.inject({ url: "/api/v1/record/fills" })).json().fills).toEqual([]);
    await app.close();
  });
});

// Real rows around the owner's top-up (04:11:19 UTC) and Strike's public deposit records for the account.
const TOPUP = JSON.parse(readFileSync(new URL("./fixtures/live-topup-mainnet-2026-10-23.json", import.meta.url), "utf8")) as {
  live_equity: Array<{ network: string; ts: number; equity: number; positions_json: string }>;
  transactions_reply: { status: number; raw: string };
};

describe("money put in comes from Strike's deposit records (real top-up, 23 Oct)", () => {
  /** Runs the trader's own transfer sync against Strike's real reply, then serves the record. */
  async function withTopup(replies: string[] = [TOPUP.transactions_reply.raw]) {
    const db = fixtureDb();
    const eq = db.prepare("INSERT INTO live_equity (network, ts, equity, positions_json) VALUES (?,?,?,?)");
    for (const r of TOPUP.live_equity) eq.run(r.network, r.ts, r.equity, r.positions_json);
    const ex = new Executor(db, new StrikeSigned("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "https://example.invalid"), "mainnet", { trading: true, killFile: "/nonexistent/kill" });
    const trader = new Trader(db, ex, loadRules("rules/tug-rules-v1.json").rules, { network: "mainnet", markets: "all", tradingOn: () => true, pausedFile: "/nonexistent/paused", keyFile: "unused" });
    trader.setAccountIdForCheck(ACCOUNT);
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(replies[urls.length - 1], { status: TOPUP.transactions_reply.status });
    }) as typeof fetch;
    try {
      for (let i = 0; i < replies.length; i++) await trader.syncTransfers();
    } finally {
      globalThis.fetch = real;
    }
    return { db, urls };
  }

  it("the trader stores both deposits from Strike's own records, with their Cardano transaction hashes", async () => {
    const { db, urls } = await withTopup();
    expect(urls[0]).toContain(`/v2/history/transaction?account_id=${ACCOUNT}&type=deposit,withdraw,transfer,reward_grant`);
    const rows = db.prepare("SELECT type, amount, tx_hash FROM transfers ORDER BY ts").all() as Array<{ type: string; amount: number; tx_hash: string }>;
    expect(rows.map((r) => [r.type, r.amount])).toEqual([
      ["deposit", 18.709836],
      ["deposit", 14.083852],
    ]);
    expect(rows.every((r) => /^[0-9a-f]{64}#0$/.test(r.tx_hash))).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE code='E-TRANSFER'").get() as { n: number }).n).toBe(0);
  });

  it("the curve's result does not jump at the top-up, and low and high are on the result", async () => {
    const { db } = await withTopup();
    const app = buildApi(db, { ...ctx, liveNickname: "tug-mainnet" });
    const r = await app.inject({ url: "/api/v1/record" });
    expect(check(r.json(), schemaOf("/api/v1/record"), root)).toEqual([]);
    const live = r.json().live;
    expect(live.start_equity).toBeCloseTo(32.793688, 9);
    expect(live.money_moves.map((m: { amount: number }) => m.amount)).toEqual([18.709836, 14.083852]);
    const curve = live.curve as Array<{ at: number; equity: number; put_in: number; result: number }>;
    const deposit = 1792728679155;
    const before = curve.filter((p) => p.at < deposit).at(-1)!;
    const after = curve.find((p) => p.at > deposit)!;
    // Equity jumps by the $14.08 top-up; the result moves by cents.
    expect(after.equity - before.equity).toBeGreaterThan(14);
    expect(Math.abs(after.result - before.result)).toBeLessThan(0.05);
    expect(before.put_in).toBeCloseTo(18.709836, 9);
    expect(after.put_in).toBeCloseTo(32.793688, 9);
    const results = curve.map((p) => p.result);
    expect(Math.min(...results)).toBeGreaterThan(-1);
    expect(Math.max(...results)).toBeLessThan(1);
    expect(live.links.strike_page).toBe("https://app.strikefinance.org/public-portfolio/@tug-mainnet");
    await app.close();
  });

  it("a deposit counts as money put in only once Strike shows it settled, and the stored status follows Strike's", async () => {
    const pending = JSON.parse(TOPUP.transactions_reply.raw) as { transactions: Array<{ id: number; status: string }> };
    pending.transactions.find((t) => t.id === 7805172)!.status = "pending";
    const { db } = await withTopup([JSON.stringify(pending)]);
    let app = buildApi(db, { ...ctx, liveNickname: "tug-mainnet" });
    let live = (await app.inject({ url: "/api/v1/record" })).json().live;
    expect(live.money_moves.map((m: { amount: number }) => m.amount)).toEqual([18.709836]);
    await app.close();
    // Strike later shows the same deposit settled: the stored row is updated, not kept at its first status.
    const { db: db2 } = await withTopup([JSON.stringify(pending), TOPUP.transactions_reply.raw]);
    expect((db2.prepare("SELECT status FROM transfers WHERE id=7805172").get() as { status: string }).status).toBe("settled");
    app = buildApi(db2, { ...ctx, liveNickname: "tug-mainnet" });
    live = (await app.inject({ url: "/api/v1/record" })).json().live;
    expect(live.money_moves.map((m: { amount: number }) => m.amount)).toEqual([18.709836, 14.083852]);
    expect(live.start_equity).toBeCloseTo(32.793688, 9);
    await app.close();
  });
});
