import type { Rules } from "./rules.js";

export interface SnapshotInput {
  id: number;
  ts: number;
  /** Strike mark and hourly funding rate per market at this snapshot. */
  marks: Record<string, { mark: number; funding: number | null; mid?: number | null; minNotional?: number | null }>;
  /** Tradable gaps only (gap ≠ 0). */
  gaps: Record<string, number>;
  /** The crowd version the snapshot read (fees saved needs each member's account value). */
  crowdVersion?: number;
  /** Signed notional per member and market: key `${crowd}|${member}|${symbol}`. */
  members: Array<{ crowd: "copy" | "fade"; member: string; symbol: string; notional: number; size?: number | null }>;
}

export const MAKER_FEE = -0.00005;
export const TAKER_FEE = 0.0005;

/** Target notional per market for a given equity (§9.5 steps 1–2). */
export function computeTargets(
  gaps: Record<string, number>,
  equity: number,
  rules: Rules,
  minNotional: (symbol: string) => number,
): Record<string, number> {
  let live = Object.entries(gaps).filter(([, g]) => g !== 0);
  for (let pass = 0; pass < 2; pass++) {
    const sum = live.reduce((a, [, g]) => a + Math.abs(g), 0);
    if (sum === 0) return {};
    const out: Record<string, number> = {};
    for (const [s, g] of live) {
      const raw = (g / sum) * rules.gross_exposure_cap * equity;
      const cap = rules.per_market_cap * equity;
      out[s] = Math.max(-cap, Math.min(cap, raw));
    }
    const kept = live.filter(([s]) => Math.abs(out[s]!) >= minNotional(s));
    if (kept.length === live.length || pass === 1) {
      return Object.fromEntries(Object.entries(out).filter(([s]) => Math.abs(out[s]!) >= minNotional(s)));
    }
    live = kept;
  }
  return {};
}

export interface PaperPoint {
  snapshotId: number;
  ts: number;
  equity: number;
  turnover: number;
  fees: number;
  funding: number;
  positions: Record<string, number>;
  /** Target notionals computed at this snapshot when it was a rebalance; absent otherwise. */
  targets?: Record<string, number>;
}

/**
 * The paper record (labelled MODEL): $10,000 following the targets at every rebalance, filled at
 * Strike's mid (best bid and ask stored with the snapshot; the mark when no book was stored) with the
 * maker fee, marked to Strike's mark, plus Strike's hourly funding. Each market's own minimum notional
 * applies. Deterministic replay of stored snapshots.
 */
export function paperRecord(snaps: SnapshotInput[], rules: Rules, startEquity = 10_000): PaperPoint[] {
  const out: PaperPoint[] = [];
  const units: Record<string, number> = {};
  let equity = startEquity;
  let turnover = 0;
  let fees = 0;
  let funding = 0;
  let prev: SnapshotInput | undefined;
  const every = rules.rebalance_every_minutes * 60_000;
  for (const s of snaps) {
    if (prev) {
      for (const [sym, u] of Object.entries(units)) {
        const a = prev.marks[sym]?.mark;
        const b = s.marks[sym]?.mark;
        if (a && b) equity += u * (b - a);
      }
      if (Math.floor(s.ts / 3_600_000) > Math.floor(prev.ts / 3_600_000)) {
        for (const [sym, u] of Object.entries(units)) {
          const m = s.marks[sym];
          if (m?.funding) {
            const f = -u * m.mark * m.funding;
            equity += f;
            funding += f;
          }
        }
      }
    }
    const isRebalance = !prev || Math.floor(s.ts / every) > Math.floor(prev.ts / every);
    let rebalanceTargets: Record<string, number> | undefined;
    if (isRebalance) {
      const targets = computeTargets(s.gaps, equity, rules, (sym) => s.marks[sym]?.minNotional ?? 5);
      rebalanceTargets = targets;
      const symbols = new Set([...Object.keys(units), ...Object.keys(targets)]);
      for (const sym of symbols) {
        const mark = s.marks[sym]?.mark;
        if (!mark) continue;
        // Fills at Strike's mid when the snapshot stored a book; snapshots before 2026-10-22 13:40 UTC used the mark.
        const fillPx = s.marks[sym]?.mid ?? mark;
        const cur = (units[sym] ?? 0) * mark;
        const tgt = targets[sym] ?? 0;
        const delta = tgt - cur;
        const band = Math.max(s.marks[sym]?.minNotional ?? 5, rules.rebalance_band_fraction * Math.abs(tgt));
        if (Math.abs(delta) < band && tgt !== 0) continue;
        if (delta === 0) continue;
        units[sym] = (units[sym] ?? 0) + delta / fillPx;
        equity += (delta / fillPx) * (mark - fillPx);
        if (Math.abs(units[sym]!) < 1e-12) delete units[sym];
        turnover += Math.abs(delta);
        const fee = Math.abs(delta) * MAKER_FEE;
        equity -= fee;
        fees += fee;
      }
    }
    const positions: Record<string, number> = {};
    for (const [sym, u] of Object.entries(units)) positions[sym] = u * (s.marks[sym]?.mark ?? 0);
    out.push({ snapshotId: s.id, ts: s.ts, equity, turnover, fees, funding, positions, ...(rebalanceTargets ? { targets: rebalanceTargets } : {}) });
    prev = s;
  }
  return out;
}

export interface ScoreRow {
  crowd: "copy" | "fade";
  symbol: string;
  pnl: number;
}

export interface Scoreboard {
  fromTs: number;
  toTs: number;
  bySymbol: ScoreRow[];
  total: Record<"copy" | "fade", number>;
  membersUp: Record<"copy" | "fade", number>;
  membersActive: Record<"copy" | "fade", number>;
}

/**
 * Mark-to-market result of each crowd's positions on Strike markets between consecutive
 * snapshots, using Strike's marks: Σ notional_t × (mark_{t+1}/mark_t − 1).
 */
export function scoreboard(snaps: SnapshotInput[]): Scoreboard | undefined {
  if (snaps.length < 2) return undefined;
  const bySym = new Map<string, number>();
  const byMember = new Map<string, number>();
  for (let i = 0; i + 1 < snaps.length; i++) {
    const a = snaps[i]!;
    const b = snaps[i + 1]!;
    for (const p of a.members) {
      const ma = a.marks[p.symbol]?.mark;
      const mb = b.marks[p.symbol]?.mark;
      if (!ma || !mb) continue;
      const pnl = p.notional * (mb / ma - 1);
      const k = `${p.crowd}|${p.symbol}`;
      bySym.set(k, (bySym.get(k) ?? 0) + pnl);
      const mk = `${p.crowd}|${p.member}`;
      byMember.set(mk, (byMember.get(mk) ?? 0) + pnl);
    }
  }
  const total = { copy: 0, fade: 0 };
  const bySymbol: ScoreRow[] = [];
  for (const [k, pnl] of [...bySym.entries()].sort()) {
    const [crowd, symbol] = k.split("|") as ["copy" | "fade", string];
    bySymbol.push({ crowd, symbol, pnl });
    total[crowd] += pnl;
  }
  const membersUp = { copy: 0, fade: 0 };
  const membersActive = { copy: 0, fade: 0 };
  for (const [k, pnl] of byMember) {
    const crowd = k.split("|")[0] as "copy" | "fade";
    membersActive[crowd]++;
    if (pnl > 0) membersUp[crowd]++;
  }
  return { fromTs: snaps[0]!.ts, toTs: snaps[snaps.length - 1]!.ts, bySymbol, total, membersUp, membersActive };
}
