import { depthSummary } from "./depth.js";
import { feesSaved, type CopyCrowd } from "./fees.js";
import { MAPPING_EXCLUDED } from "./mapping.js";
import { paperRecord, scoreboard, snapshotInput, type SnapshotRows } from "./records.js";
import type { Rules } from "./rules.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Strike fills newer than this before the export may not be synced yet (the trader reads fills every minute). */
export const FILL_SYNC_MARGIN_MS = 10 * 60_000;

interface Records {
  /** When the bundle was written (ms): every Strike fill of the live account up to it, less the sync margin, is in it. */
  exported_at?: number;
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
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** The bundle's own copy of the rules file. */
export const RULES_IN_BUNDLE = "rules/tug-rules-v1.json";

/**
 * Checks an evidence bundle (§16.2): every file against MANIFEST.sha256, then recomputes every record the site
 * shows from the recorded inputs with the engine's own code, and compares with the engine's numbers in
 * records.json. With `strikeFills`, also compares each live fill with Strike's public fill history. Any changed
 * byte or number fails. Runs the same in Node (`pnpm verify`) and in the browser (`/check`): file access, SHA-256
 * and gunzip are passed in.
 */
export async function verifyEvidence(
  files: Map<string, Uint8Array>,
  o: {
    rulesSha256: string;
    sha256: (b: Uint8Array) => Promise<string>;
    gunzip: (b: Uint8Array) => Promise<Uint8Array>;
    strikeFills?: () => Promise<Array<{ id: number; order_id: number; price: number; size: number; fee: number; ts: number }>>;
    progress?: (step: string) => void;
  },
): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    out.push({ name, ok, detail });
    o.progress?.(name);
  };
  const lines = async <T>(path: string): Promise<T[]> =>
    text(await o.gunzip(files.get(path)!))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);

  // 1. Every file matches its SHA-256, and every data file is listed.
  const manifestFile = files.get("MANIFEST.sha256");
  if (!manifestFile) {
    add("hashes", false, "MANIFEST.sha256 is missing");
    return out;
  }
  const manifest = new Map(
    text(manifestFile)
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(66), l.slice(0, 64)] as const),
  );
  const bad: string[] = [];
  for (const [p, h] of manifest) {
    const b = files.get(p);
    if (!b || (await o.sha256(b)) !== h) bad.push(p);
  }
  const unlisted = [...files.keys()].filter((p) => p !== "MANIFEST.sha256" && p !== "README.md" && !manifest.has(p));
  add("hashes", bad.length === 0 && unlisted.length === 0, bad.length || unlisted.length ? `changed: ${bad.join(", ") || "none"}; not listed: ${unlisted.join(", ") || "none"}` : `${manifest.size} files match MANIFEST.sha256`);
  if (bad.length) return out;

  // 2. The rules file is the one published before the record started; the records below run under it.
  const rulesFile = files.get(RULES_IN_BUNDLE);
  const rulesSha = rulesFile ? await o.sha256(rulesFile) : "";
  add("rules", rulesSha === o.rulesSha256, rulesFile ? `rules file SHA-256 ${rulesSha.slice(0, 12)}… ${rulesSha === o.rulesSha256 ? "matches" : "does not match"} the published fingerprint` : "the bundle has no rules file");
  if (!rulesFile) return out;
  const rules = JSON.parse(text(rulesFile)) as Rules;

  const rec = JSON.parse(text(files.get("records.json")!)) as Records;
  const paths = [...manifest.keys()].sort();
  const snaps = (await Promise.all(paths.filter((p) => p.startsWith("snapshots/")).map((p) => lines<SnapshotRows & { status: string; id: number }>(p))))
    .flat()
    .filter((s) => s.status === "COMPLETE")
    .sort((a, b) => a.id - b.id);

  // 3. Paper record, scoreboard and fees saved, from the same snapshots the engine last used.
  const n = rec.scoreboard?.snapshots ?? rec.paper.length;
  const inputs = snaps.slice(0, n).map((s) => snapshotInput(s, MAPPING_EXCLUDED));
  const paper = paperRecord(inputs, rules);
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
    const c = JSON.parse(text(await o.gunzip(files.get(`crowds/crowd-v${v}.json.gz`)!))) as { members: Array<{ crowd: string; platform: string; member_id: string; account_value: number | null }> };
    const copy = c.members.filter((m) => m.crowd === "copy");
    crowds[v] = { copyCount: copy.length, accountValue: Object.fromEntries(copy.map((m) => [`${m.platform}:${m.member_id}`, m.account_value ?? 0])) };
  }
  const fees = feesSaved(inputs, crowds, paper);
  if (rec.fees_saved && fees) {
    const ok = close(rec.fees_saved.saved, fees.saved) && close(rec.fees_saved.baseline.fees, fees.baseline.fees) && close(rec.fees_saved.tug.fees, fees.tug.fees) && rec.fees_saved.baseline.orders === fees.baseline.orders;
    add("fees saved", ok, `copying one by one ${fees.baseline.fees.toFixed(2)} in fees (${fees.baseline.orders} orders) vs TUG ${fees.tug.fees.toFixed(2)}: saved ${fees.saved.toFixed(2)} on ${fees.capital}`);
  } else add("fees saved", !rec.fees_saved && !fees, "no fees-saved record yet");

  // 4. Fills and depth added.
  const fills = (await Promise.all(paths.filter((p) => p.startsWith("fills/")).map((p) => lines<FillRow>(p)))).flat();
  const fillBad = rec.fills.filter((w) => {
    const xs = fills.filter((f) => f.network === w.network);
    return xs.length !== w.fills || xs.filter((f) => f.role === "maker").length !== w.maker_fills || !close(xs.reduce((a, f) => a + f.fee, 0), w.fees) || !close(xs.reduce((a, f) => a + f.realized_pnl, 0), w.realized);
  });
  add("fills", fillBad.length === 0, rec.fills.map((w) => `${w.network} ${w.fills} fills (${w.maker_fills} maker)`).join("; ") || "no fills");

  const depth = (await Promise.all(paths.filter((p) => p.startsWith("depth/")).map((p) => lines<{ network: string; ts: number; symbol: string; side: string; tug_size: number; at_best: number; best_total: number; top5_total: number }>(p))))
    .flat()
    .filter((x) => x.network === "mainnet");
  const d = depthSummary(depth.map((x) => ({ ts: x.ts, symbol: x.symbol, side: x.side, tugSize: x.tug_size, atBest: x.at_best === 1, bestTotal: x.best_total, top5Total: x.top5_total })));
  const w = rec.depth_added_mainnet;
  const depthOk = d.minutesResting === w.minutesResting && d.markets.length === w.markets.length && d.markets.every((m, i) => m.symbol === w.markets[i]!.symbol && m.minutesResting === w.markets[i]!.minutesResting && close(m.avgShareOfBest, w.markets[i]!.avgShareOfBest) && close(m.avgShareOfTop5, w.markets[i]!.avgShareOfTop5));
  add("depth added", depthOk, `${d.minutesResting} minutes resting across ${d.markets.length} markets`);

  // 5. Both ways: each live fill in the bundle is on Strike's public record with the same price, size and fee,
  // and each fill Strike shows for the account up to the export time (less the sync margin) is in the bundle, so
  // no fill (a losing one, say) can be left out.
  if (o.strikeFills) {
    const fromStrike = await o.strikeFills();
    const strike = new Map(fromStrike.map((f) => [f.id, f]));
    const live = fills.filter((f) => f.network === "mainnet");
    const inBundle = new Set(live.map((f) => f.fill_id));
    const differ = live.filter((f) => {
      const s = strike.get(f.fill_id);
      return !s || !close(s.price, f.price) || !close(s.size, f.size) || !close(s.fee, f.fee);
    });
    const cutoff = (rec.exported_at ?? 0) - FILL_SYNC_MARGIN_MS;
    const leftOut = fromStrike.filter((f) => f.ts <= cutoff && !inBundle.has(f.id));
    const ok = differ.length === 0 && leftOut.length === 0 && rec.exported_at !== undefined;
    add(
      "Strike re-read",
      ok,
      `${live.length - differ.length} of ${live.length} live fills match Strike's public fill history; ${fromStrike.filter((f) => f.ts <= cutoff).length - leftOut.length} of ${fromStrike.filter((f) => f.ts <= cutoff).length} Strike fills before the export are in the bundle` +
        (differ.length ? `; differ: ${differ.map((f) => f.fill_id).join(", ")}` : "") +
        (leftOut.length ? `; left out: ${leftOut.map((f) => f.id).join(", ")}` : "") +
        (rec.exported_at === undefined ? "; the bundle has no export time" : ""),
    );
  }
  return out;
}
