import { describe, expect, it } from "vitest";
import { loadRules, riskCheck, type RiskState } from "../src/index.js";

const { rules } = loadRules("rules/tug-rules-v1.json");
const NOW = Date.parse("2026-10-23T10:00:00Z");
const base: RiskState = {
  now: NOW,
  startEquity: 20,
  equity: 20,
  marginRatio: 0.1,
  positions: { "ETH-USD": -12, "ZHIPU-USD": 8 },
  lastSnapshotAt: NOW - 2 * 60_000,
  lastMarksAt: NOW - 10_000,
  // Strike's own status word for a normal market (captured /v2/markets, 2026-10-22).
  accountStatus: "trading",
  marketStatus: { "ETH-USD": "trading", "ZHIPU-USD": "trading" },
  tradingOn: true,
  paused: false,
};

describe("risk guard", () => {
  it("T-RISK-1 a healthy account keeps trading", () => {
    expect(riskCheck(base, rules)).toEqual([]);
  });
  it("T-RISK-2 equity below 75% of the start cancels everything, flattens and pauses", () => {
    expect(riskCheck({ ...base, equity: 14.99 }, rules)).toEqual([
      { kind: "cancel_all", code: "E-STOP" },
      { kind: "flatten_all", code: "E-STOP" },
      { kind: "pause", code: "E-STOP" },
    ]);
    expect(riskCheck({ ...base, equity: 15 }, rules)).toEqual([]);
  });
  it("T-RISK-3 once paused, nothing restarts until the owner clears it, even if equity recovers; open positions keep being closed", () => {
    expect(riskCheck({ ...base, equity: 30, paused: true, positions: {} }, rules)).toEqual([
      { kind: "cancel_all", code: "E-STOP" },
      { kind: "no_new_orders", code: "E-STOP" },
    ]);
    expect(riskCheck({ ...base, equity: 30, paused: true }, rules)).toEqual([
      { kind: "cancel_all", code: "E-STOP" },
      { kind: "flatten_all", code: "E-STOP" },
      { kind: "no_new_orders", code: "E-STOP" },
    ]);
  });
  it("T-RISK-4 margin use above 60% halves the largest position", () => {
    expect(riskCheck({ ...base, marginRatio: 0.61 }, rules)).toEqual([{ kind: "reduce_half", symbol: "ETH-USD", code: "E-MARGIN" }]);
    expect(riskCheck({ ...base, marginRatio: 0.6 }, rules)).toEqual([]);
  });
  it("T-RISK-5 trading off (kill switch) cancels all orders; a halted market stops new orders", () => {
    expect(riskCheck({ ...base, tradingOn: false }, rules)).toEqual([
      { kind: "cancel_all", code: "E-KILLED" },
      { kind: "no_new_orders", code: "E-KILLED" },
    ]);
    expect(riskCheck({ ...base, marketStatus: { ...base.marketStatus, "ZHIPU-USD": "circuit_breaker" } }, rules)).toEqual([
      { kind: "no_new_orders", code: "E-HALT" },
    ]);
  });
});

describe("stale data", () => {
  it("T-STALE-1 no complete snapshot for over 15 minutes cancels resting orders and holds positions", () => {
    const a = riskCheck({ ...base, lastSnapshotAt: NOW - 15 * 60_000 - 1 }, rules);
    expect(a).toEqual([
      { kind: "cancel_all", code: "E-STALE" },
      { kind: "no_new_orders", code: "E-STALE" },
    ]);
    expect(a.some((x) => x.kind === "flatten_all")).toBe(false);
    expect(riskCheck({ ...base, lastSnapshotAt: NOW - 15 * 60_000 }, rules)).toEqual([]);
  });
  it("T-STALE-2 Strike marks older than 2 minutes, or never read, count as stale", () => {
    expect(riskCheck({ ...base, lastMarksAt: NOW - 2 * 60_000 - 1 }, rules)[0]).toEqual({ kind: "cancel_all", code: "E-STALE" });
    expect(riskCheck({ ...base, lastMarksAt: null }, rules)[0]).toEqual({ kind: "cancel_all", code: "E-STALE" });
  });
});
