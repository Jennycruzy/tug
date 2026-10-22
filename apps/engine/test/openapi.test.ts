import { describe, expect, it } from "vitest";
import { loadRules } from "@tug/core";
import { buildApi } from "../src/api.js";
import { OPENAPI } from "../src/openapi.js";
import { rebuildRecords } from "../src/records.js";
import { fixtureDb } from "./fixture-db.js";
import { check } from "./schema-check.js";

const { rules, sha256 } = loadRules("rules/tug-rules-v1.json");
const RECORD_START = Date.parse("2026-10-22T11:55:21Z");
const root = OPENAPI as unknown as { components: { schemas: Record<string, Record<string, unknown>> }; paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> }>> };

describe("public API replies validate against the OpenAPI document (real snapshots 4–15)", () => {
  const db = fixtureDb();
  rebuildRecords(db, rules, RECORD_START, "mainnet");
  const app = buildApi(db, { network: "mainnet", rulesSha256: sha256, rulesVersion: 1, recordStartMs: RECORD_START, revision: "test" });

  const cases: Array<[string, string, number]> = [
    ["/api/v1/tug", "/api/v1/tug", 200],
    ["/api/v1/tug/SOL-USD", "/api/v1/tug/{symbol}", 200],
    ["/api/v1/tug/FOO-USD", "/api/v1/tug/{symbol}", 404],
    ["/api/v1/tug/bad!", "/api/v1/tug/{symbol}", 400],
    ["/api/v1/crowds", "/api/v1/crowds", 200],
    ["/api/v1/record", "/api/v1/record", 200],
    ["/api/v1/record?network=testnet", "/api/v1/record", 200],
    ["/api/v1/record?network=moon", "/api/v1/record", 400],
    ["/api/v1/record/fills", "/api/v1/record/fills", 200],
    ["/api/v1/paper", "/api/v1/paper", 200],
    ["/api/v1/scoreboard", "/api/v1/scoreboard", 200],
    ["/api/v1/proof", "/api/v1/proof", 200],
    ["/api/v1/status", "/api/v1/status", 200],
  ];

  for (const [url, path, code] of cases) {
    it(`GET ${url} → ${code}, reply matches the document`, async () => {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(code);
      const schema = root.paths[path]!.get!.responses[String(code)]!.content["application/json"].schema;
      expect(check(r.json(), schema, root)).toEqual([]);
    });
  }

  it("every documented path is served, and the replies carry real numbers", async () => {
    const tug = (await app.inject({ url: "/api/v1/tug" })).json();
    expect(tug.markets.length).toBeGreaterThanOrEqual(31);
    expect(tug.snapshot.id).toBe(15);
    const paper = (await app.inject({ url: "/api/v1/paper" })).json();
    expect(paper.curve).toHaveLength(12);
    expect(paper.label).toBe("MODEL");
    const crowds = (await app.inject({ url: "/api/v1/crowds" })).json();
    expect(crowds.counts.copy.total + crowds.counts.fade.total).toBe(562);
  });

  it("/api/openapi.json and /llms.txt are served by the API itself", async () => {
    const o = await app.inject({ url: "/api/openapi.json" });
    expect(o.statusCode).toBe(200);
    expect(o.json().openapi).toBe("3.1.0");
    const l = await app.inject({ url: "/llms.txt" });
    expect(l.statusCode).toBe(200);
    expect(l.headers["content-type"]).toMatch(/text\/plain/);
    expect(l.body).toMatch(/^# TUG on Strike/);
  });
});
