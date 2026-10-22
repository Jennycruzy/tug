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
    for (const c of ["E-NO-DATA", "E-SYMBOL"]) used.delete(c);
    const missing = [...used].filter((c) => !PUBLIC_SENTENCES[c]);
    expect(missing).toEqual([]);
  });
});
