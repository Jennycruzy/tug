// Replays the stored record: recomputes every complete snapshot's leans from its stored positions, and
// the paper record and its targets from all stored inputs, on a copy of the database, then compares each
// with what the engine stored, byte for byte. `pnpm replay`; exits 1 on any difference.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLeans, loadRules, type PositionRow } from "@tug/core";
import Database from "better-sqlite3";
import { DB_FILE, NETWORK, RULES_FILE } from "../config.js";
import { openDb } from "../db.js";
import { rebuildRecords } from "../records.js";
import { saveRun } from "./shared.js";

const { rules } = loadRules(RULES_FILE);
const recordStart = Date.parse(process.env.TUG_RECORD_START ?? "2026-10-22T11:55:21Z");
const dir = mkdtempSync(join(tmpdir(), "tug-replay-"));
const copyFile = join(dir, "copy.db");
await new Database(DB_FILE, { readonly: true }).backup(copyFile);
const db = openDb(copyFile);

const snaps = db.prepare("SELECT id FROM snapshots WHERE network=? AND status='COMPLETE' ORDER BY id").all(NETWORK) as Array<{ id: number }>;
const posQ = db.prepare("SELECT platform, member_id, crowd, symbol, signed_notional FROM positions WHERE snapshot_id=? ORDER BY rowid");
const leanQ = db.prepare(
  "SELECT symbol, long_copy, short_copy, lean_copy, n_copy, long_fade, short_fade, lean_fade, n_fade, gap, tradable, reason FROM leans WHERE snapshot_id=? ORDER BY symbol",
);
const leanDiffs: number[] = [];
for (const { id } of snaps) {
  const rows: PositionRow[] = (posQ.all(id) as Array<{ platform: string; member_id: string; crowd: "copy" | "fade"; symbol: string; signed_notional: number }>).map((p) => ({
    memberId: `${p.platform}:${p.member_id}`,
    crowd: p.crowd,
    symbol: p.symbol,
    signedNotional: p.signed_notional,
  }));
  const again = computeLeans(rows, rules).map((l) => ({
    symbol: l.symbol,
    long_copy: l.copy.long,
    short_copy: l.copy.short,
    lean_copy: l.copy.lean,
    n_copy: l.copy.n,
    long_fade: l.fade.long,
    short_fade: l.fade.short,
    lean_fade: l.fade.lean,
    n_fade: l.fade.n,
    gap: l.gap,
    tradable: l.tradable ? 1 : 0,
    reason: l.reason,
  }));
  if (JSON.stringify(again) !== JSON.stringify(leanQ.all(id))) leanDiffs.push(id);
}

const storedPaper = JSON.stringify(db.prepare("SELECT * FROM paper ORDER BY snapshot_id").all());
const storedTargets = JSON.stringify(db.prepare("SELECT * FROM targets ORDER BY snapshot_id, symbol").all());
const lastStored = (db.prepare("SELECT MAX(snapshot_id) AS id FROM paper").get() as { id: number | null }).id;
// Replay only the snapshots the stored records covered, so a snapshot finished after them does not count as a difference.
db.prepare("UPDATE snapshots SET status='REPLAY-LATER' WHERE network=? AND status='COMPLETE' AND id > ?").run(NETWORK, lastStored ?? 0);
rebuildRecords(db, rules, recordStart, NETWORK);
const paperSame = JSON.stringify(db.prepare("SELECT * FROM paper ORDER BY snapshot_id").all()) === storedPaper;
const targetsSame = JSON.stringify(db.prepare("SELECT * FROM targets ORDER BY snapshot_id, symbol").all()) === storedTargets;
const counts = {
  snapshots: snaps.length,
  paper_rows: (JSON.parse(storedPaper) as unknown[]).length,
  target_rows: (JSON.parse(storedTargets) as unknown[]).length,
  last_snapshot_in_records: lastStored,
};
db.close();
rmSync(dir, { recursive: true, force: true });

const result = { at: new Date().toISOString(), network: NETWORK, ...counts, leans_identical: leanDiffs.length === 0, lean_differences: leanDiffs, paper_identical: paperSame, targets_identical: targetsSame };
const file = saveRun("replay", result);
console.log(JSON.stringify({ ...result, file }, null, 1));
if (leanDiffs.length || !paperSame || !targetsSame) process.exitCode = 1;
