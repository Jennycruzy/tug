import { feesSaved, MAPPING_EXCLUDED, paperRecord, scoreboard, snapshotInput, type CopyCrowd, type Rules, type SnapshotInput, type SnapshotRows } from "@tug/core";
import type { Db } from "./db.js";

/** Rebuilds the paper record, its targets, the scoreboard and fees saved from every complete snapshot since the record start. */
export function rebuildRecords(db: Db, rules: Rules, recordStartMs: number, network: string): { snapshots: number } {
  const snaps = db
    .prepare("SELECT id, started_at, mapping_version, crowd_version FROM snapshots WHERE status='COMPLETE' AND network=? AND started_at >= ? ORDER BY id")
    .all(network, recordStartMs) as Array<{ id: number; started_at: number; mapping_version: number | null; crowd_version: number }>;

  const inputs: SnapshotInput[] = snapshotRows(db, snaps).map((s) => snapshotInput(s, MAPPING_EXCLUDED));

  const paper = paperRecord(inputs, rules);
  const board = scoreboard(inputs);
  const crowds: Record<number, CopyCrowd> = {};
  const membersQ = db.prepare("SELECT platform, member_id, account_value FROM crowd_members WHERE version_id=? AND crowd='copy'");
  for (const v of new Set(inputs.map((i) => i.crowdVersion!))) {
    const rows = membersQ.all(v) as Array<{ platform: string; member_id: string; account_value: number | null }>;
    crowds[v] = { copyCount: rows.length, accountValue: Object.fromEntries(rows.map((r) => [`${r.platform}:${r.member_id}`, r.account_value ?? 0])) };
  }
  const fees = feesSaved(inputs, crowds, paper);

  db.transaction(() => {
    db.exec("DELETE FROM paper; DELETE FROM targets; DELETE FROM scoreboard; DELETE FROM scoreboard_summary;");
    const ins = db.prepare("INSERT INTO paper (snapshot_id, ts, equity, turnover, fees, funding, positions_json) VALUES (?,?,?,?,?,?,?)");
    const insT = db.prepare("INSERT INTO targets (snapshot_id, symbol, target_usd) VALUES (?,?,?)");
    for (const p of paper) {
      ins.run(p.snapshotId, p.ts, p.equity, p.turnover, p.fees, p.funding, JSON.stringify(p.positions));
      for (const [sym, t] of Object.entries(p.targets ?? {})) insT.run(p.snapshotId, sym, t);
    }
    db.prepare("INSERT OR REPLACE INTO records_json (name, computed_at, json) VALUES ('fees_saved', ?, ?)").run(Date.now(), JSON.stringify(fees ?? null));
    if (board) {
      const insB = db.prepare("INSERT INTO scoreboard (crowd, symbol, pnl_usd) VALUES (?,?,?)");
      for (const r of board.bySymbol) insB.run(r.crowd, r.symbol, r.pnl);
      db.prepare(
        "INSERT INTO scoreboard_summary (id, from_ts, to_ts, copy_pnl, fade_pnl, copy_up, copy_active, fade_up, fade_active, snapshots) VALUES (1,?,?,?,?,?,?,?,?,?)",
      ).run(
        board.fromTs,
        board.toTs,
        board.total.copy,
        board.total.fade,
        board.membersUp.copy,
        board.membersActive.copy,
        board.membersUp.fade,
        board.membersActive.fade,
        inputs.length,
      );
    }
  })();
  return { snapshots: inputs.length };
}

/** Each snapshot's stored rows: marks, tradable leans and every crowd member's position. */
export function snapshotRows(db: Db, snaps: Array<{ id: number; started_at: number; mapping_version: number | null; crowd_version: number }>): SnapshotRows[] {
  const marksQ = db.prepare("SELECT symbol, mark, funding_rate, bid, ask, min_notional FROM marks WHERE snapshot_id=?");
  const gapsQ = db.prepare("SELECT symbol, gap FROM leans WHERE snapshot_id=? AND tradable=1");
  const posQ = db.prepare("SELECT crowd, platform, member_id, symbol, signed_notional, size FROM positions WHERE snapshot_id=?");
  return snaps.map((s) => ({
    id: s.id,
    started_at: s.started_at,
    crowd_version: s.crowd_version,
    mapping_version: s.mapping_version,
    marks: marksQ.all(s.id) as SnapshotRows["marks"],
    leans: gapsQ.all(s.id) as SnapshotRows["leans"],
    positions: posQ.all(s.id) as SnapshotRows["positions"],
  }));
}
