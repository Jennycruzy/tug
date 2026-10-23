import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublished, loadRules, setHttpEventSink, type Fingerprint } from "@tug/core";
import { startApi } from "./api.js";
import { API_PORT, BUSY_FILE, DB_FILE, NETWORK, RAW_DIR, REVISION, ROOT, RULES_FILE, STRIKE_TESTNET_URL } from "./config.js";
import { Connect, kekFrom } from "./connect.js";
import { buildCrowds, loadLatestCrowds, type CrowdVersion } from "./crowds.js";
import { logEvent, openDb } from "./db.js";
import { takeSnapshot } from "./recorder.js";
import { rebuildRecords } from "./records.js";

interface PublishedFingerprint extends Fingerprint {
  record_start?: string;
}

const loaded = loadRules(RULES_FILE);
const published = JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as PublishedFingerprint[];
const fp = assertPublished(loaded, published) as PublishedFingerprint;
const recordStartMs = Date.parse(fp.record_start ?? fp.frozen_at);
const { rules } = loaded;
const db = openDb(DB_FILE);

const log = (msg: string, data?: unknown) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(data ? { data } : {}) }));

const interrupted = db
  .prepare("UPDATE snapshots SET status='INTERRUPTED', finished_at=? WHERE status='RUNNING' AND network=?")
  .run(Date.now(), NETWORK).changes;
if (interrupted) logEvent(db, "engine", "warn", "snapshots left running by a restart were marked interrupted", "E-INTERRUPTED", { interrupted });

setHttpEventSink((e) => logEvent(db, "http", "warn", "A data source asked us to slow down.", e.code, e));

log("engine start", { rules: fp.sha256, version: fp.version, record_start: fp.record_start, network: NETWORK, revision: REVISION });
logEvent(db, "engine", "info", "engine start", undefined, { rules: fp.sha256, network: NETWORK, revision: REVISION });

rmSync(BUSY_FILE, { force: true });

let crowd: CrowdVersion | undefined = loadLatestCrowds(db);
let running = false;

async function ensureCrowds(): Promise<void> {
  const ageH = crowd ? (Date.now() - crowd.pulledAt) / 3_600_000 : Infinity;
  if (ageH < rules.crowd_refresh_every_hours) return;
  const t = Date.now();
  crowd = await buildCrowds(db, rules, loaded.sha256, RAW_DIR, NETWORK);
  log("crowds built", {
    id: crowd.id,
    copy: crowd.members.filter((m) => m.crowd === "copy").length,
    fade: crowd.members.filter((m) => m.crowd === "fade").length,
    disabledCoins: crowd.disabledCoins,
    ms: Date.now() - t,
  });
}

async function cycle(): Promise<void> {
  if (running) {
    logEvent(db, "engine", "warn", "previous cycle still running; skipped", "E-SKIPPED");
    return;
  }
  running = true;
  // The deploy script restarts the engine only while this file is absent (crowd refresh and snapshot both count).
  writeFileSync(BUSY_FILE, String(Date.now()));
  try {
    await ensureCrowds();
    const periodMs = rules.snapshot_every_minutes * 60_000;
    const deadline = Date.now() + periodMs - 30_000;
    const r = await takeSnapshot(db, rules, crowd!, RAW_DIR, deadline, NETWORK);
    const rec = rebuildRecords(db, rules, recordStartMs, NETWORK);
    log("snapshot", { ...r, recordSnapshots: rec.snapshots });
  } catch (e) {
    log("cycle failed", { error: (e as Error).message });
    logEvent(db, "engine", "error", (e as Error).message, (e as { code?: string }).code ?? "E-CYCLE");
  } finally {
    running = false;
    rmSync(BUSY_FILE, { force: true });
  }
}

/** Snapshots run only on the 5-minute grid, including after a restart. */
function scheduleAligned(): void {
  const period = rules.snapshot_every_minutes * 60_000;
  const wait = period - (Date.now() % period);
  setTimeout(() => {
    void cycle();
    setInterval(() => void cycle(), period);
  }, wait);
}

writeFileSync(BUSY_FILE, String(Date.now()));
try {
  await ensureCrowds();
} catch (e) {
  log("crowd refresh failed", { error: (e as Error).message });
} finally {
  rmSync(BUSY_FILE, { force: true });
}
rebuildRecords(db, rules, recordStartMs, NETWORK);
scheduleAligned();

// The mainnet instance serves the public API; the site reads only from it.
if (NETWORK === "mainnet") {
  const api = await startApi(db, {
      network: NETWORK,
      rulesSha256: fp.sha256,
      rulesVersion: fp.version,
      recordStartMs,
      revision: REVISION,
      liveStartEquity: process.env.TUG_START_EQUITY ? Number(process.env.TUG_START_EQUITY) : undefined,
      liveAccountId: process.env.TUG_ACCOUNT_ID,
      liveNickname: process.env.TUG_ACCOUNT_NICKNAME,
      evidenceDir: process.env.TUG_EVIDENCE_REPO_DIR ?? "/home/tug/tug-evidence",
      // TUG in your account opens on testnet once the key-encryption key is configured.
      connect: process.env.TUG_KEK
        ? new Connect(db, { kek: kekFrom(process.env.TUG_KEK), code: process.env.TUG_CONNECT_BUILDER_CODE ?? "tug", feeBps: Number(process.env.TUG_BUILDER_FEE_BPS ?? 1), strikeUrl: STRIKE_TESTNET_URL })
        : undefined,
    }, API_PORT);
  log("api listening", { port: API_PORT });
  process.on("exit", () => void api.close());
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("engine stop", { signal: sig });
    db.close();
    process.exit(0);
  });
}
