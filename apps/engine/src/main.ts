import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublished, loadRules, type Fingerprint } from "@tug/core";
import { buildCrowds, loadLatestCrowds, type CrowdVersion } from "./crowds.js";
import { logEvent, openDb } from "./db.js";
import { takeSnapshot } from "./recorder.js";

const ROOT = process.env.TUG_ROOT ?? process.cwd();
const RULES_FILE = process.env.TUG_RULES_FILE ?? join(ROOT, "rules/tug-rules-v1.json");
const DB_FILE = process.env.TUG_DB ?? join(ROOT, "data/tug.db");
const RAW_DIR = process.env.TUG_RAW_DIR ?? join(ROOT, "data/raw");

const loaded = loadRules(RULES_FILE);
const published = JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Fingerprint[];
const fp = assertPublished(loaded, published);
const { rules } = loaded;
const db = openDb(DB_FILE);

const log = (msg: string, data?: unknown) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(data ? { data } : {}) }));

log("engine start", { rules: fp.sha256, version: fp.version, frozen_at: fp.frozen_at, network: process.env.TUG_NETWORK ?? "mainnet" });
logEvent(db, "engine", "info", "engine start", undefined, { rules: fp.sha256 });

let crowd: CrowdVersion | undefined = loadLatestCrowds(db);
let running = false;

async function ensureCrowds(): Promise<void> {
  const ageH = crowd ? (Date.now() - crowd.pulledAt) / 3_600_000 : Infinity;
  if (ageH < rules.crowd_refresh_every_hours) return;
  const t = Date.now();
  crowd = await buildCrowds(db, rules, loaded.sha256);
  log("crowds built", {
    id: crowd.id,
    copy: crowd.members.filter((m) => m.crowd === "copy").length,
    fade: crowd.members.filter((m) => m.crowd === "fade").length,
    ms: Date.now() - t,
  });
}

async function cycle(): Promise<void> {
  if (running) {
    logEvent(db, "engine", "warn", "previous cycle still running; skipped");
    return;
  }
  running = true;
  try {
    await ensureCrowds();
    const periodMs = rules.snapshot_every_minutes * 60_000;
    const deadline = Date.now() + periodMs - 30_000;
    const r = await takeSnapshot(db, rules, crowd!, RAW_DIR, deadline);
    log("snapshot", r);
  } catch (e) {
    log("cycle failed", { error: (e as Error).message });
    logEvent(db, "engine", "error", (e as Error).message, (e as { code?: string }).code ?? "E-CYCLE");
  } finally {
    running = false;
  }
}

function scheduleAligned(): void {
  const period = rules.snapshot_every_minutes * 60_000;
  const wait = period - (Date.now() % period);
  setTimeout(() => {
    void cycle();
    setInterval(() => void cycle(), period);
  }, wait);
}

await cycle();
scheduleAligned();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("engine stop", { signal: sig });
    db.close();
    process.exit(0);
  });
}
