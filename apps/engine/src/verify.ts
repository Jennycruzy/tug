import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { depthSummary, feesSaved, MAPPING_EXCLUDED, paperRecord, scoreboard, snapshotInput, type CopyCrowd, type Rules, type SnapshotRows } from "@tug/core";
import { listFiles } from "./evidence.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Records {
  paper: Array<{ snapshot_id: number; ts: number; equity: number; turnover: number; fees: number; funding: number }>;
  scoreboard: { copy_pnl: number; fade_pnl: number; copy_up: number; copy_active: number; fade_up: number; fade_active: number; snapshots: number } | null;
  fees_saved: { saved: number; baseline: { fees: number; turnover: number; orders: number; subscriptions: number }; tug: { fees: number; turnover: number } } | null;
  fills: Array<{ network: string; fills: number; maker_fills: number; fees: number; realized: number }>;
  depth_added_mainnet: { minutesResting: number; markets: Array<{ symbol: string; minutesResting: number; minutesAtBest: number; avgShareOfBest: number; avgShareOfTop5: number }> };
}

interface FillRow {
  network: string;
  fill_id: number;
  order_id: number | null;
  symbol: string;
  side: string;
  role: string | null;
  price: number;
  size: number;
  fee: number;
  realized_pnl: number;
  ts: number;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const lines = <T>(buf: Buffer): T[] =>
  gunzipSync(buf)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

/**
 * `pnpm verify` (§16.2): checks the evidence bundle in `dir` against its manifest, then recomputes every record
 * the site shows from the recorded inputs with the same code the engine runs, and compares with the engine's own
 * numbers in records.json. With `strikeFills`, also re-reads TUG's live fills from Strike's public API and
 * compares each one. Any changed byte or number fails.
 */
export async function verifyBundle(
  dir: string,
  o: { rules: Rules; rulesFile: Buffer; rulesSha256: string; strikeFills?: () => Promise<Array<{ id: number; order_id: number; price: number; size: number; fee: number }>> },
): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  // 1. Every file matches its SHA-256, and every data file is listed.
  const manifest = new Map(
    readFileSync(join(dir, "MANIFEST.sha256"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(66), l.slice(0, 64)] as const),
  );
  const bad = [...manifest].filter(([p, h]) => !existsSync(join(dir, p)) || createHash("sha256").update(readFileSync(join(dir, p))).digest("hex") !== h).map(([p]) => p);
  const unlisted = listFiles(dir).filter((p) => p !== "MANIFEST.sha256" && p !== "README.md" && !manifest.has(p));
  add("hashes", bad.length === 0 && unlisted.length === 0, bad.length || unlisted.length ? `changed: ${bad.join(", ") || "none"}; not listed: ${unlisted.join(", ") || "none"}` : `${manifest.size} files match MANIFEST.sha256`);
  if (bad.length) return out;

  // 2. The rules file is the one published before the record started.
  const rulesSha = createHash("sha256").update(o.rulesFile).digest("hex");
  add("rules", rulesSha === o.rulesSha256, `rules file SHA-256 ${rulesSha.slice(0, 12)}… ${rulesSha === o.rulesSha256 ? "matches" : "does not match"} the published fingerprint`);

  const rec = JSON.parse(readFileSync(join(dir, "records.json"), "utf8")) as Records;
  const files = [...manifest.keys()];
  const snaps = files
    .filter((p) => p.startsWith("snapshots/"))
    .sort()
    .flatMap((p) => lines<SnapshotRows & { status: string }>(readFileSync(join(dir, p))))
    .filter((s) => s.status === "COMPLETE")
    .sort((a, b) => a.id - b.id);

  // 3. Paper record, scoreboard and fees saved, from the same snapshots the engine last used.
  const n = rec.scoreboard?.snapshots ?? rec.paper.length;
  const inputs = snaps.slice(0, n).map((s) => snapshotInput(s, MAPPING_EXCLUDED));
  const paper = paperRecord(inputs, o.rules);
  const want = new Map(rec.paper.map((p) => [p.snapshot_id, p]));
  const paperBad = paper.filter((p) => {
    const w = want.get(p.snapshotId);
    return !w || !close(w.equity, p.equity) || !close(w.turnover, p.turnover) || !close(w.fees, p.fees) || !close(w.funding, p.funding);
  });
  const last = paper.at(-1);
  add("paper record", paperBad.length === 0 && paper.length === rec.paper.length, last ? `${paper.length} points recomputed; equity ${last.equity.toFixed(2)} at snapshot ${last.snapshotId}${paperBad.length ? `; ${paperBad.length} differ (first: snapshot ${paperBad[0]!.snapshotId})` : ""}` : "no points");

  const board = scoreboard(inputs);
  if (rec.scoreboard && board) {
    const s = rec.scoreboard;
    const ok =
      close(s.copy_pnl, board.total.copy) &&
      close(s.fade_pnl, board.total.fade) &&
      s.copy_up === board.membersUp.copy &&
      s.copy_active === board.membersActive.copy &&
      s.fade_up === board.membersUp.fade &&
      s.fade_active === board.membersActive.fade;
    add("scoreboard", ok, `copy picks ${board.total.copy.toFixed(2)} (${board.membersUp.copy} of ${board.membersActive.copy} up), fade picks ${board.total.fade.toFixed(2)} (${board.membersUp.fade} of ${board.membersActive.fade} up)`);
  } else add("scoreboard", !rec.scoreboard && !board, "no scoreboard yet");

  const crowds: Record<number, CopyCrowd> = {};
  for (const v of new Set(inputs.map((i) => i.crowdVersion!))) {
    const c = JSON.parse(gunzipSync(readFileSync(join(dir, `crowds/crowd-v${v}.json.gz`))).toString("utf8")) as { members: Array<{ crowd: string; platform: string; member_id: string; account_value: number | null }> };
    const copy = c.members.filter((m) => m.crowd === "copy");
    crowds[v] = { copyCount: copy.length, accountValue: Object.fromEntries(copy.map((m) => [`${m.platform}:${m.member_id}`, m.account_value ?? 0])) };
  }
  const fees = feesSaved(inputs, crowds, paper);
  if (rec.fees_saved && fees) {
    const ok = close(rec.fees_saved.saved, fees.saved) && close(rec.fees_saved.baseline.fees, fees.baseline.fees) && close(rec.fees_saved.tug.fees, fees.tug.fees) && rec.fees_saved.baseline.orders === fees.baseline.orders;
    add("fees saved", ok, `copying one by one ${fees.baseline.fees.toFixed(2)} in fees (${fees.baseline.orders} orders) vs TUG ${fees.tug.fees.toFixed(2)}: saved ${fees.saved.toFixed(2)} on ${fees.capital}`);
  } else add("fees saved", !rec.fees_saved && !fees, "no fees-saved record yet");

  // 4. Fills and depth added.
  const fills = files.filter((p) => p.startsWith("fills/")).flatMap((p) => lines<FillRow>(readFileSync(join(dir, p))));
  const fillBad = rec.fills.filter((w) => {
    const xs = fills.filter((f) => f.network === w.network);
    return xs.length !== w.fills || xs.filter((f) => f.role === "maker").length !== w.maker_fills || !close(xs.reduce((a, f) => a + f.fee, 0), w.fees) || !close(xs.reduce((a, f) => a + f.realized_pnl, 0), w.realized);
  });
  add("fills", fillBad.length === 0, rec.fills.map((w) => `${w.network} ${w.fills} fills (${w.maker_fills} maker)`).join("; ") || "no fills");

  const depth = files
    .filter((p) => p.startsWith("depth/"))
    .flatMap((p) => lines<{ network: string; ts: number; symbol: string; side: string; tug_size: number; at_best: number; best_total: number; top5_total: number }>(readFileSync(join(dir, p))))
    .filter((x) => x.network === "mainnet");
  const d = depthSummary(depth.map((x) => ({ ts: x.ts, symbol: x.symbol, side: x.side, tugSize: x.tug_size, atBest: x.at_best === 1, bestTotal: x.best_total, top5Total: x.top5_total })));
  const w = rec.depth_added_mainnet;
  const depthOk = d.minutesResting === w.minutesResting && d.markets.length === w.markets.length && d.markets.every((m, i) => m.symbol === w.markets[i]!.symbol && m.minutesResting === w.markets[i]!.minutesResting && close(m.avgShareOfBest, w.markets[i]!.avgShareOfBest) && close(m.avgShareOfTop5, w.markets[i]!.avgShareOfTop5));
  add("depth added", depthOk, `${d.minutesResting} minutes resting across ${d.markets.length} markets`);

  // 5. Each live fill is on Strike's own public record, with the same price, size and fee.
  if (o.strikeFills) {
    const strike = new Map((await o.strikeFills()).map((f) => [f.id, f]));
    const live = fills.filter((f) => f.network === "mainnet");
    const missing = live.filter((f) => {
      const s = strike.get(f.fill_id);
      return !s || !close(s.price, f.price) || !close(s.size, f.size) || !close(s.fee, f.fee);
    });
    add("Strike re-read", missing.length === 0, `${live.length - missing.length} of ${live.length} live fills match Strike's public fill history${missing.length ? `; differ: ${missing.map((f) => f.fill_id).join(", ")}` : ""}`);
  }
  return out;
}
