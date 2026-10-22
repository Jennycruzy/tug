import { paperRecord, scoreboard, type Rules, type SnapshotInput } from "@tug/core";
import type { Db } from "./db.js";

/** Rebuilds the paper record and scoreboard from every complete snapshot since the record start. */
export function rebuildRecords(db: Db, rules: Rules, recordStartMs: number, network: string): { snapshots: number } {
  const snaps = db
    .prepare("SELECT id, started_at FROM snapshots WHERE status='COMPLETE' AND network=? AND started_at >= ? ORDER BY id")
    .all(network, recordStartMs) as Array<{ id: number; started_at: number }>;
  const marksQ = db.prepare("SELECT symbol, mark, funding_rate FROM marks WHERE snapshot_id=?");
  const gapsQ = db.prepare("SELECT symbol, gap FROM leans WHERE snapshot_id=? AND tradable=1");
  const posQ = db.prepare("SELECT crowd, platform, member_id, symbol, signed_notional FROM positions WHERE snapshot_id=?");

  const inputs: SnapshotInput[] = snaps.map((s) => ({
    id: s.id,
    ts: s.started_at,
    marks: Object.fromEntries(
      (marksQ.all(s.id) as Array<{ symbol: string; mark: number; funding_rate: number | null }>).map((m) => [
        m.symbol,
        { mark: m.mark, funding: m.funding_rate },
      ]),
    ),
    gaps: Object.fromEntries((gapsQ.all(s.id) as Array<{ symbol: string; gap: number }>).map((g) => [g.symbol, g.gap])),
    members: (posQ.all(s.id) as Array<{ crowd: "copy" | "fade"; platform: string; member_id: string; symbol: string; signed_notional: number }>).map(
      (p) => ({ crowd: p.crowd, member: `${p.platform}:${p.member_id}`, symbol: p.symbol, notional: p.signed_notional }),
    ),
  }));

  const paper = paperRecord(inputs, rules);
  const board = scoreboard(inputs);

  db.transaction(() => {
    db.exec("DELETE FROM paper; DELETE FROM scoreboard; DELETE FROM scoreboard_summary;");
    const ins = db.prepare("INSERT INTO paper (snapshot_id, ts, equity, turnover, fees, funding, positions_json) VALUES (?,?,?,?,?,?,?)");
    for (const p of paper) ins.run(p.snapshotId, p.ts, p.equity, p.turnover, p.fees, p.funding, JSON.stringify(p.positions));
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
