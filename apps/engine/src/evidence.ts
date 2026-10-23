import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { depthSummary } from "@tug/core";
import type { Db } from "./db.js";
import { snapshotRows } from "./records.js";

/**
 * The evidence bundle (§16.1) written into a checkout of the tug-evidence repository: the recorded inputs per UTC
 * day, the engine's own records, and MANIFEST.sha256 over every file. `pnpm verify` recomputes the records from
 * the inputs and compares. Files are deterministic (sorted, gzip without a timestamp), so an unchanged day is
 * byte-identical on every export.
 *
 * Strike account ids in crowds and positions are replaced by a salted pseudonym (the same member gets the same
 * pseudonym everywhere, so every record still recomputes): Strike traders are never listed one by one (§12, T-PRIV).
 */
export function exportEvidence(db: Db, dir: string, o: { recordStartMs: number; salt: string; now?: number }): { written: string[]; files: number } {
  const pseudo = (platform: string, id: string) => (platform === "strike" ? `s-${createHmac("sha256", o.salt).update(id).digest("hex").slice(0, 16)}` : id);
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const files = new Map<string, Buffer>();
  const jsonl = (rows: unknown[]) => gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")), { level: 9 });
  const byDay = <T>(rows: T[], ts: (r: T) => number) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(day(ts(r)), [...(m.get(day(ts(r))) ?? []), r]);
    return m;
  };

  // One read transaction: every file sees the same moment of the database.
  db.transaction(() => {
    const snaps = db
      .prepare("SELECT id, started_at, finished_at, status, crowd_version, mapping_version, raw_sha256, read_copy, read_fade FROM snapshots WHERE network='mainnet' AND started_at >= ? ORDER BY id")
      .all(o.recordStartMs) as Array<{ id: number; started_at: number; finished_at: number | null; status: string; crowd_version: number; mapping_version: number | null; raw_sha256: string | null; read_copy: number | null; read_fade: number | null }>;
    const complete = snaps.filter((s) => s.status === "COMPLETE");
    const rows = new Map(snapshotRows(db, complete).map((r) => [r.id, r]));
    const snapLines = snaps.map((s) => {
      const r = rows.get(s.id);
      return {
        ...s,
        marks: r?.marks ?? [],
        leans: r?.leans ?? [],
        positions: (r?.positions ?? []).map((p) => ({ ...p, member_id: pseudo(p.platform, p.member_id) })),
      };
    });
    for (const [d, xs] of byDay(snapLines, (s) => s.started_at)) files.set(`snapshots/snapshots-${d}.jsonl.gz`, jsonl(xs));

    for (const v of new Set(snaps.map((s) => s.crowd_version))) {
      const members = db
        .prepare("SELECT crowd, platform, member_id, account_value FROM crowd_members WHERE version_id=? ORDER BY crowd, platform, member_id")
        .all(v) as Array<{ crowd: string; platform: string; member_id: string; account_value: number | null }>;
      const out = members.map((m) => ({ ...m, member_id: pseudo(m.platform, m.member_id) })).sort((a, b) => (a.crowd + a.platform + a.member_id < b.crowd + b.platform + b.member_id ? -1 : 1));
      files.set(`crowds/crowd-v${v}.json.gz`, gzipSync(Buffer.from(JSON.stringify({ version: v, members: out })), { level: 9 }));
    }

    const fills = db
      .prepare("SELECT network, fill_id, trade_id, order_id, client_order_id, symbol, side, role, price, size, fee, realized_pnl, ts FROM fills ORDER BY ts, network, fill_id")
      .all() as Array<{ ts: number }>;
    for (const [d, xs] of byDay(fills, (f) => f.ts)) files.set(`fills/fills-${d}.jsonl.gz`, jsonl(xs));
    const equity = db.prepare("SELECT network, ts, equity FROM live_equity ORDER BY ts, network").all() as Array<{ ts: number }>;
    for (const [d, xs] of byDay(equity, (e) => e.ts)) files.set(`equity/equity-${d}.jsonl.gz`, jsonl(xs));
    const depth = db
      .prepare("SELECT network, ts, symbol, side, price, tug_size, at_best, best_total, top5_total FROM depth_samples ORDER BY ts, network, symbol, side")
      .all() as Array<{ ts: number; network: string; symbol: string; side: string; tug_size: number; at_best: number; best_total: number; top5_total: number }>;
    for (const [d, xs] of byDay(depth, (e) => e.ts)) files.set(`depth/depth-${d}.jsonl.gz`, jsonl(xs));
    const vaultPts = db.prepare("SELECT vault_id, ts, share_price, equity, total_shares FROM vault_points ORDER BY ts").all() as Array<{ ts: number }>;
    for (const [d, xs] of byDay(vaultPts, (e) => e.ts)) files.set(`vault/vault-points-${d}.jsonl.gz`, jsonl(xs));
    const moves = db.prepare("SELECT vault_id, id, type, status, ts, usd, shares, share_price, execute_at, executed_at FROM vault_moves ORDER BY ts, id").all();
    files.set("vault/vault-moves.json", Buffer.from(JSON.stringify(moves, null, 1) + "\n"));

    // The engine's own records, as the site shows them: verify recomputes each from the inputs above.
    const paper = db.prepare("SELECT snapshot_id, ts, equity, turnover, fees, funding FROM paper ORDER BY snapshot_id").all();
    const board = db.prepare("SELECT from_ts, to_ts, copy_pnl, fade_pnl, copy_up, copy_active, fade_up, fade_active, snapshots FROM scoreboard_summary WHERE id=1").get() ?? null;
    const fees = db.prepare("SELECT json FROM records_json WHERE name='fees_saved'").get() as { json: string } | undefined;
    const fillSummary = db
      .prepare("SELECT network, COUNT(*) AS fills, COALESCE(SUM(role='maker'),0) AS maker_fills, COALESCE(SUM(fee),0) AS fees, COALESCE(SUM(realized_pnl),0) AS realized FROM fills GROUP BY network ORDER BY network")
      .all();
    const d = depthSummary(depth.filter((x) => x.network === "mainnet").map((x) => ({ ts: x.ts, symbol: x.symbol, side: x.side, tugSize: x.tug_size, atBest: x.at_best === 1, bestTotal: x.best_total, top5Total: x.top5_total })));
    const records = {
      record_start: new Date(o.recordStartMs).toISOString(),
      snapshots: { complete: complete.length, partial: snaps.filter((s) => s.status === "PARTIAL").length, last_complete_id: complete.at(-1)?.id ?? null },
      paper,
      scoreboard: board,
      fees_saved: fees ? (JSON.parse(fees.json) as unknown) : null,
      fills: fillSummary,
      depth_added_mainnet: d,
    };
    files.set("records.json", Buffer.from(JSON.stringify(records, null, 1) + "\n"));
  })();

  const written: string[] = [];
  for (const [path, buf] of files) {
    const full = join(dir, path);
    if (existsSync(full) && readFileSync(full).equals(buf)) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buf);
    written.push(path);
  }
  // The manifest covers every data file in the bundle (pre-record files included), sorted by path.
  const all = listFiles(dir).filter((p) => p !== "MANIFEST.sha256" && p !== "README.md" && !p.startsWith(".git/") && p !== ".git");
  const manifest = all.map((p) => `${createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")}  ${p}`).join("\n") + "\n";
  const mPath = join(dir, "MANIFEST.sha256");
  if (!existsSync(mPath) || readFileSync(mPath, "utf8") !== manifest) {
    writeFileSync(mPath, manifest);
    written.push("MANIFEST.sha256");
  }
  return { written, files: all.length };
}

/** Every file under `dir`, as sorted paths relative to it. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Removes a file the bundle no longer writes (not used by the hourly export; kept for tests). */
export function removeEvidence(dir: string, path: string): void {
  rmSync(join(dir, path), { force: true });
}
