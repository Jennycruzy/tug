import type { Rules } from "./rules.js";

export interface RiskState {
  now: number;
  /** The record's starting equity and the account's equity now (USD). */
  startEquity: number;
  equity: number;
  /** Maintenance margin / account value, 0–1. */
  marginRatio: number;
  /** Signed position notional per market (USD). */
  positions: Record<string, number>;
  /** When the last complete snapshot started, and when Strike's marks were last read. */
  lastSnapshotAt: number | null;
  lastMarksAt: number | null;
  /** Strike's status for the account and each market TUG holds or quotes. */
  accountStatus: string;
  marketStatus: Record<string, string>;
  /** TUG_TRADING=on and no kill file / pause. */
  tradingOn: boolean;
  /** Set after an equity stop; only the owner's go clears it. */
  paused: boolean;
}

export type RiskAction =
  | { kind: "cancel_all"; code: string }
  | { kind: "flatten_all"; code: string }
  | { kind: "reduce_half"; symbol: string; code: string }
  | { kind: "pause"; code: string }
  | { kind: "no_new_orders"; code: string };

export const MARKS_STALE_MS = 2 * 60_000;
const HALTED = new Set(["liquidation", "circuit_breaker", "halted"]);

/**
 * The risk guard's decision for one moment (§9.7), as a pure function of the state: the engine runs it
 * every 10 s and on every account event, and carries out the actions in order. An empty list means
 * normal trading continues.
 */
export function riskCheck(s: RiskState, rules: Rules): RiskAction[] {
  const out: RiskAction[] = [];
  if (!s.tradingOn) return [{ kind: "cancel_all", code: "E-KILLED" }, { kind: "no_new_orders", code: "E-KILLED" }];
  if (s.paused) return [{ kind: "cancel_all", code: "E-STOP" }, { kind: "no_new_orders", code: "E-STOP" }];

  if (s.equity < (1 - rules.drawdown_stop_fraction) * s.startEquity) {
    return [
      { kind: "cancel_all", code: "E-STOP" },
      { kind: "flatten_all", code: "E-STOP" },
      { kind: "pause", code: "E-STOP" },
    ];
  }

  const halted = HALTED.has(s.accountStatus) || Object.values(s.marketStatus).some((m) => HALTED.has(m));
  if (halted) out.push({ kind: "no_new_orders", code: "E-HALT" });

  const snapshotStale = s.lastSnapshotAt === null || s.now - s.lastSnapshotAt > rules.stale_data_limit_minutes * 60_000;
  const marksStale = s.lastMarksAt === null || s.now - s.lastMarksAt > MARKS_STALE_MS;
  if (snapshotStale || marksStale) out.push({ kind: "cancel_all", code: "E-STALE" }, { kind: "no_new_orders", code: "E-STALE" });

  if (s.marginRatio > rules.margin_ratio_reduce) {
    const largest = Object.entries(s.positions)
      .filter(([, v]) => v !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1))[0];
    if (largest) out.push({ kind: "reduce_half", symbol: largest[0], code: "E-MARGIN" });
  }
  return out;
}
