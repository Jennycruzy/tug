import type { Rules } from "./rules.js";

export type Crowd = "copy" | "fade";

export interface PositionRow {
  memberId: string;
  crowd: Crowd;
  symbol: string;
  /** Signed USD notional: positive long, negative short. */
  signedNotional: number;
}

export interface CrowdSide {
  long: number;
  short: number;
  lean: number;
  n: number;
}

export interface LeanRow {
  symbol: string;
  copy: CrowdSide;
  fade: CrowdSide;
  gap: number;
  tradable: boolean;
  reason: "two_crowds" | "copy_only" | "fade_only" | "none";
}

function side(rows: PositionRow[], cap: number): CrowdSide {
  let long = 0;
  let short = 0;
  const members = new Set<string>();
  for (const r of rows) {
    if (r.signedNotional === 0) continue;
    const clipped = Math.max(-cap, Math.min(cap, r.signedNotional));
    if (clipped > 0) long += clipped;
    else short += -clipped;
    members.add(r.memberId);
  }
  const total = long + short;
  return { long, short, lean: total > 0 ? (long - short) / total : 0, n: members.size };
}

/**
 * Leans and the gap per market. Pure: the same positions and rules always give
 * the same rows, so every stored snapshot can be replayed.
 */
export function computeLeans(positions: PositionRow[], rules: Rules): LeanRow[] {
  const bySymbol = new Map<string, PositionRow[]>();
  for (const p of positions) {
    const list = bySymbol.get(p.symbol);
    if (list) list.push(p);
    else bySymbol.set(p.symbol, [p]);
  }
  const rows: LeanRow[] = [];
  for (const symbol of [...bySymbol.keys()].sort()) {
    const all = bySymbol.get(symbol)!;
    const copy = side(all.filter((p) => p.crowd === "copy"), rules.per_trader_cap_usd);
    const fade = side(all.filter((p) => p.crowd === "fade"), rules.per_trader_cap_usd);
    let gap = 0;
    let reason: LeanRow["reason"] = "none";
    const copyOk = copy.n >= rules.min_members_copy;
    const fadeOk = fade.n >= rules.min_members_fade;
    if (copyOk && fadeOk) {
      const disagree = Math.sign(copy.lean) !== 0 && Math.sign(copy.lean) === -Math.sign(fade.lean);
      const g = (copy.lean - fade.lean) / 2;
      if (disagree && Math.abs(g) >= rules.gap_threshold_two_crowds) {
        gap = g;
        reason = "two_crowds";
      }
    } else if (copy.n >= rules.one_crowd_min_members && !fadeOk) {
      if (Math.abs(copy.lean) >= rules.one_crowd_threshold) {
        gap = copy.lean;
        reason = "copy_only";
      }
    } else if (fade.n >= rules.one_crowd_min_members && !copyOk) {
      if (Math.abs(fade.lean) >= rules.one_crowd_threshold) {
        gap = -fade.lean;
        reason = "fade_only";
      }
    }
    rows.push({ symbol, copy, fade, gap, tradable: gap !== 0, reason });
  }
  return rows;
}
