import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApi } from "../src/api.js";
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
    expect(r.body).not.toContain(ACCOUNT);
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
