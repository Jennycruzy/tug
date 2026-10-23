import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadRules } from "@tug/core";
import { exportEvidence, listFiles } from "../src/evidence.js";
import { rebuildRecords } from "../src/records.js";
import { verifyBundle } from "../src/verify.js";
import { FIXTURE, fixtureDb } from "./fixture-db.js";

const RULES_FILE = "rules/tug-rules-v1.json";
const loaded = loadRules(RULES_FILE);
const opts = { rules: loaded.rules, rulesFile: readFileSync(RULES_FILE), rulesSha256: loaded.sha256 };
// Real fills of the live account (23 Oct), with Strike's fill ids, as stored by the trader.
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/live-mainnet-2026-10-23.json", import.meta.url), "utf8")) as { fills: Array<Record<string, string | number | null>> };

/** The fixture's real snapshots with their records rebuilt, two real live fills and a few depth samples, exported. */
function bundle() {
  const db = fixtureDb();
  rebuildRecords(db, loaded.rules, 0, "mainnet");
  const f = db.prepare(
    "INSERT INTO fills (network, fill_id, trade_id, order_id, client_order_id, symbol, side, role, price, size, fee, realized_pnl, ts, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'null')",
  );
  for (const x of LIVE.fills) f.run(x.network, x.fill_id, x.trade_id, x.order_id, x.client_order_id, x.symbol, x.side, x.role, x.price, x.size, x.fee, x.realized_pnl, x.ts);
  const d = db.prepare("INSERT INTO depth_samples (network, ts, symbol, side, price, tug_size, at_best, best_total, top5_total) VALUES (?,?,?,?,?,?,?,?,?)");
  d.run("mainnet", 1792721000000, "CXMT-USD", "sell", 5.8361, 1.6, 1, 4.8, 20.1);
  d.run("mainnet", 1792721060000, "CXMT-USD", "sell", 5.8361, 1.6, 0, 3.2, 18.4);
  const dir = mkdtempSync(join(tmpdir(), "tug-ev-"));
  const first = exportEvidence(db, dir, { recordStartMs: 0, salt: "test-salt" });
  return { db, dir, first };
}

const strikeFromFixture = async () => LIVE.fills.map((x) => ({ id: Number(x.fill_id), order_id: Number(x.order_id), price: Number(x.price), size: Number(x.size), fee: Number(x.fee) }));

describe("evidence bundle and pnpm verify (real recorded snapshots)", () => {
  it("T-VERIFY-1 every check passes on an untouched bundle, the Strike re-read included", async () => {
    const { dir } = bundle();
    const checks = await verifyBundle(dir, { ...opts, strikeFills: strikeFromFixture });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(["hashes", "rules", "paper record", "scoreboard", "fees saved", "fills", "depth added", "Strike re-read"]);
  });

  it("T-VERIFY-2 one changed byte in any file fails the hashes", async () => {
    const { dir } = bundle();
    const target = listFiles(dir).find((p) => p.startsWith("snapshots/"))!;
    const buf = readFileSync(join(dir, target));
    buf[buf.length - 5] = buf[buf.length - 5]! ^ 1;
    writeFileSync(join(dir, target), buf);
    const checks = await verifyBundle(dir, opts);
    expect(checks[0]).toMatchObject({ name: "hashes", ok: false });
    expect(checks[0]!.detail).toContain(target);
  });

  it("T-VERIFY-3 a changed number with a re-made manifest still fails: the record is recomputed from the inputs", async () => {
    const { dir } = bundle();
    const rec = JSON.parse(readFileSync(join(dir, "records.json"), "utf8")) as { paper: Array<{ equity: number }> };
    rec.paper.at(-1)!.equity += 1;
    writeFileSync(join(dir, "records.json"), JSON.stringify(rec, null, 1) + "\n");
    const manifest = listFiles(dir)
      .filter((p) => p !== "MANIFEST.sha256")
      .map((p) => `${createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")}  ${p}`)
      .join("\n");
    writeFileSync(join(dir, "MANIFEST.sha256"), manifest + "\n");
    const checks = await verifyBundle(dir, opts);
    expect(checks.find((c) => c.name === "hashes")!.ok).toBe(true);
    expect(checks.find((c) => c.name === "paper record")!.ok).toBe(false);
  });

  it("a live fill missing from Strike's public history fails the re-read", async () => {
    const { dir } = bundle();
    const checks = await verifyBundle(dir, { ...opts, strikeFills: async () => (await strikeFromFixture()).slice(1) });
    expect(checks.find((c) => c.name === "Strike re-read")!.ok).toBe(false);
  });

  it("an unchanged database exports byte-identical files (nothing to commit)", () => {
    const { db, dir, first } = bundle();
    expect(first.written.length).toBeGreaterThan(3);
    expect(exportEvidence(db, dir, { recordStartMs: 0, salt: "test-salt" }).written).toEqual([]);
  });

  it("no Strike account id appears in the bundle: Strike members are pseudonyms", () => {
    const { dir } = bundle();
    const strikeIds = (FIXTURE.crowd_members as Array<{ platform: string; member_id: string }>).filter((m) => m.platform === "strike").map((m) => m.member_id);
    expect(strikeIds.length).toBeGreaterThan(0);
    const text = listFiles(dir)
      .map((p) => {
        const b = readFileSync(join(dir, p));
        return p.endsWith(".gz") ? gunzipSync(b).toString("utf8") : b.toString("utf8");
      })
      .join("\n");
    for (const id of strikeIds) expect(text).not.toContain(id);
  });
});
