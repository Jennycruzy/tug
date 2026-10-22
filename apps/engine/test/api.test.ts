import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_SENTENCES } from "@tug/core";
import { buildApi } from "../src/api.js";
import { logEvent, openDb } from "../src/db.js";

const ctx = { network: "mainnet", rulesSha256: "0".repeat(64), rulesVersion: 1, recordStartMs: 0, revision: "test" };

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith(".ts") ? [readFileSync(join(dir, d.name), "utf8")] : [],
  );
}

describe("public status", () => {
  it("shows each event code's fixed sentence, never the event's own text", async () => {
    const db = openDb(":memory:");
    logEvent(db, "executor", "warn", "kill switch on: secret words typed by hand", "E-KILLED");
    logEvent(db, "http", "warn", "429 from host with a body", "E-RATE");
    logEvent(db, "engine", "error", "free text with no code");
    const app = buildApi(db, ctx);
    const r = await app.inject({ url: "/api/v1/status" });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("secret words");
    expect(r.body).not.toContain("429 from host");
    expect(r.body).not.toContain("free text");
    const recent = r.json().errors_24h.recent as Array<{ code: string | null; message: string }>;
    expect(recent.map((e) => e.message).sort()).toEqual(
      [PUBLIC_SENTENCES["E-KILLED"], PUBLIC_SENTENCES["E-RATE"], "The engine logged a warning."].sort(),
    );
    await app.close();
  });

  it("every event code the engine and packages use has a fixed sentence", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const text = [join(root, "apps/engine/src"), join(root, "packages/core/src"), join(root, "packages/strike/src"), join(root, "packages/hl/src")]
      .flatMap(sources)
      .join("\n");
    const used = new Set([...text.matchAll(/"(E-[A-Z][A-Z-]*)"/g)].map((m) => m[1]!));
    // Codes that only ever answer an API request (never stored as events).
    for (const c of ["E-NO-DATA", "E-SYMBOL", "E-NETWORK"]) used.delete(c);
    const missing = [...used].filter((c) => !PUBLIC_SENTENCES[c]);
    expect(missing).toEqual([]);
  });
});

describe("privacy of Strike's own traders", () => {
  it("T-PRIV-1 a Strike fade pick appears only as a count and a net size, never by id", async () => {
    const { loadRules } = await import("@tug/core");
    const { fixtureDb } = await import("./fixture-db.js");
    const db = fixtureDb();
    // A real Strike copy member's row from snapshot 15, relabelled as a fade member for this check.
    const row = db.prepare("SELECT * FROM positions WHERE snapshot_id=15 AND platform='strike' LIMIT 1").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    db.prepare("INSERT INTO positions (snapshot_id, platform, member_id, crowd, symbol, signed_notional, account_value) VALUES (?,?,?,?,?,?,?)").run(
      15, "strike", "fade-check-member-0000-0000-0000", "fade", row.symbol, row.signed_notional, row.account_value,
    );
    db.prepare("INSERT INTO crowd_members (version_id, platform, member_id, crowd, copy_score, style, account_value, pnl_30d, raw_json) VALUES (1,'strike','fade-check-member-0000-0000-0000','fade',40,'swing',5000,-10,'null')").run();
    const app = buildApi(db, { ...ctx, rulesSha256: loadRules("rules/tug-rules-v1.json").sha256 });
    const market = await app.inject({ url: `/api/v1/tug/${row.symbol}` });
    const crowds = await app.inject({ url: "/api/v1/crowds" });
    for (const r of [market, crowds]) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("fade-check-member");
      expect(r.body).not.toContain("fade-c");
    }
    expect(market.json().strike.fade.n).toBe(1);
    expect(crowds.json().members.strike_fade).toEqual({ n: 1 });
    await app.close();
  });

  it("T-PRIV-2 Strike copy picks appear only by shortened id; full Strike account ids never leave the API", async () => {
    const { fixtureDb } = await import("./fixture-db.js");
    const db = fixtureDb();
    const ids = (db.prepare("SELECT member_id FROM crowd_members WHERE version_id=1 AND platform='strike'").all() as Array<{ member_id: string }>).map((r) => r.member_id);
    expect(ids.length).toBeGreaterThan(0);
    const app = buildApi(db, ctx);
    for (const url of ["/api/v1/crowds", "/api/v1/tug", ...["SOL-USD", "ETH-USD", "BTC-USD"].map((s) => `/api/v1/tug/${s}`)]) {
      const body = (await app.inject({ url })).body;
      for (const id of ids) expect(body, `${url} shows ${id}`).not.toContain(id);
    }
    await app.close();
  });
});
