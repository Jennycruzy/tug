// Fills `positions.size` for snapshots recorded before the column existed, from each snapshot's stored raw
// replies (data/raw/snapshot-<id>.txt.gz). A size is written only when the raw position reproduces the stored
// signed notional exactly, computed the way the recorder computed it; anything else is counted, never guessed.
// `pnpm backfill:sizes`; prints a summary and exits 1 if any row is left without a size.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DB_FILE, NETWORK, RAW_DIR } from "../config.js";
import { openDb } from "../db.js";
import { saveRun } from "./shared.js";

const db = openDb(DB_FILE);
const snaps = db
  .prepare("SELECT DISTINCT p.snapshot_id AS id FROM positions p JOIN snapshots s ON s.id = p.snapshot_id WHERE p.size IS NULL AND s.network=? ORDER BY 1")
  .all(NETWORK) as Array<{ id: number }>;
const rowsQ = db.prepare("SELECT rowid, platform, member_id, symbol, signed_notional FROM positions WHERE snapshot_id=? AND size IS NULL");
const marksQ = db.prepare("SELECT symbol, mark FROM marks WHERE snapshot_id=?");
const setSize = db.prepare("UPDATE positions SET size=? WHERE rowid=?");

let filled = 0;
const unmatched: Array<{ snapshot: number; member: string; symbol: string }> = [];
for (const { id } of snaps) {
  const marks = new Map((marksQ.all(id) as Array<{ symbol: string; mark: number }>).map((m) => [m.symbol, m.mark]));
  // Candidate (signed notional → size) pairs per member, recomputed exactly as the recorder did.
  const candidates = new Map<string, Array<{ notional: number; size: number; symbol?: string }>>();
  const text = gunzipSync(readFileSync(join(RAW_DIR, `snapshot-${id}.txt.gz`))).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const a = line.indexOf("|");
    const b = line.indexOf("|", a + 1);
    const member = line.slice(0, a);
    const source = line.slice(a + 1, b);
    const json = JSON.parse(line.slice(b + 1)) as Record<string, unknown>;
    const list = candidates.get(member) ?? [];
    if (source === "strike") {
      for (const p of (json.positions as Array<{ symbol: string; size: string | number }> | null) ?? []) {
        const size = Number(p.size);
        const mark = marks.get(p.symbol);
        if (mark) list.push({ notional: size * mark, size, symbol: p.symbol });
      }
    } else {
      for (const { position: p } of (json.assetPositions as Array<{ position: { szi: string; positionValue: string } }> | undefined) ?? []) {
        const size = Number(p.szi);
        list.push({ notional: Math.sign(size) * Math.abs(Number(p.positionValue)), size });
      }
    }
    candidates.set(member, list);
  }
  db.transaction(() => {
    for (const r of rowsQ.all(id) as Array<{ rowid: number; platform: string; member_id: string; symbol: string; signed_notional: number }>) {
      const list = candidates.get(r.member_id) ?? [];
      const i = list.findIndex((c) => c.notional === r.signed_notional && (c.symbol === undefined || c.symbol === r.symbol));
      if (i < 0) {
        unmatched.push({ snapshot: id, member: r.member_id, symbol: r.symbol });
        continue;
      }
      setSize.run(list[i]!.size, r.rowid);
      list.splice(i, 1);
      filled++;
    }
  })();
}
const left = (db.prepare("SELECT COUNT(*) AS n FROM positions WHERE size IS NULL").get() as { n: number }).n;
db.close();
const result = { at: new Date().toISOString(), network: NETWORK, snapshots: snaps.length, filled, unmatched: unmatched.length, unmatched_first: unmatched.slice(0, 20), rows_still_without_size: left };
console.log(JSON.stringify({ ...result, file: saveRun("backfill-sizes", result) }, null, 1));
if (left > 0) process.exitCode = 1;
