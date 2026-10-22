import { describe, expect, it } from "vitest";
import { computeTargets, loadRules, paperRecord, scoreboard, type SnapshotInput } from "../src/index.js";

const rules = loadRules("rules/tug-rules-v1.json").rules;
const snap = (id: number, minute: number, mark: number, gaps: Record<string, number>, members: SnapshotInput["members"] = []): SnapshotInput => ({
  id,
  ts: Date.UTC(2026, 9, 22, 12, minute),
  marks: { "ETH-USD": { mark, funding: 0.0001 } },
  gaps,
  members,
});

describe("targets", () => {
  it("T-SIZE-1 weights follow the gaps and respect gross and per-market caps", () => {
    const t = computeTargets({ "ETH-USD": -1, "SOL-USD": 1, "BTC-USD": 0 }, 1000, rules, () => 5);
    expect(t["ETH-USD"]).toBe(-500);
    expect(t["SOL-USD"]).toBe(500);
    expect(t["BTC-USD"]).toBeUndefined();
    const sum = Object.values(computeTargets({ A: 0.9, B: 0.5, C: -0.4, D: 0.3 }, 1000, rules, () => 5)).reduce((a, v) => a + Math.abs(v), 0);
    expect(sum).toBeLessThanOrEqual(2000 + 1e-9);
  });
  it("T-SIZE-2 markets below the minimum notional are dropped and the rest renormalised", () => {
    const t = computeTargets({ A: 1, B: 0.01 }, 20, rules, () => 5);
    expect(Object.keys(t)).toEqual(["A"]);
    expect(t.A).toBe(10);
  });
});

describe("paper record", () => {
  it("follows targets at rebalances, earns the maker rebate and marks to market", () => {
    const pts = paperRecord([snap(1, 0, 2000, { "ETH-USD": -1 }), snap(2, 5, 1900, { "ETH-USD": -1 })], rules);
    expect(pts[0]!.turnover).toBe(5000);
    expect(pts[0]!.fees).toBeCloseTo(-0.25);
    expect(pts[0]!.positions["ETH-USD"]).toBeCloseTo(-5000);
    expect(pts[1]!.equity).toBeCloseTo(10_000 + 0.25 + 250);
    expect(pts[1]!.turnover).toBe(5000);
  });
  it("closes a position when its market stops being tradable at the next rebalance", () => {
    const pts = paperRecord([snap(1, 0, 2000, { "ETH-USD": 1 }), snap(2, 15, 2000, {})], rules);
    expect(pts[1]!.positions["ETH-USD"]).toBeUndefined();
    expect(pts[1]!.turnover).toBe(10_000);
  });
});

describe("paper fills", () => {
  it("fills at Strike's mid and books the mid-to-mark difference; uses each market's minimum", () => {
    const a: SnapshotInput = { id: 1, ts: Date.UTC(2026, 9, 22, 12, 0), marks: { "ETH-USD": { mark: 2000, funding: null, mid: 1990, minNotional: 10 } }, gaps: { "ETH-USD": 1 }, members: [] };
    const [p] = paperRecord([a], rules);
    expect(p!.positions["ETH-USD"]).toBeCloseTo((5000 / 1990) * 2000);
    expect(p!.equity).toBeCloseTo(10_000 + (5000 / 1990) * 10 + 0.25);
    expect(computeTargets({ A: 1, B: 0.3 }, 20, rules, (s) => (s === "B" ? 10 : 5))).toEqual({ A: 10 });
  });
});

describe("scoreboard", () => {
  it("marks each crowd's positions to Strike's next mark", () => {
    const m = (crowd: "copy" | "fade", member: string, notional: number) => ({ crowd, member, symbol: "ETH-USD", notional });
    const b = scoreboard([snap(1, 0, 2000, {}, [m("copy", "a", -1000), m("fade", "b", 2000)]), snap(2, 5, 1900, {})])!;
    expect(b.total.copy).toBeCloseTo(50);
    expect(b.total.fade).toBeCloseTo(-100);
    expect(b.membersUp).toEqual({ copy: 1, fade: 0 });
  });
});
