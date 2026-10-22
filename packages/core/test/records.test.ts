import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeTargets, loadRules, marketRulesFrom, paperRecord, planOrders, scoreboard, type SnapshotInput } from "../src/index.js";

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

describe("order sizing against Strike's real market rules (captured /v2/markets, 33 markets)", () => {
  const reply = JSON.parse(readFileSync("packages/core/test/fixtures/strike-markets-2026-10-22-33.json", "utf8")).markets as Record<string, Record<string, unknown>>;
  const mr = marketRulesFrom(reply);
  const books = Object.fromEntries(Object.entries(reply).map(([s, m]) => [s, { bid: Number(m.bid1_price), ask: Number(m.ask1_price) }]));
  const marks = Object.fromEntries(Object.entries(reply).map(([s, m]) => [s, Number(m.mark_price)]));
  const decimals = (v: string) => (v.includes(".") ? v.split(".")[1]!.length : 0);
  const onGrid = (v: string, step: string) => {
    const d = Math.max(decimals(v), decimals(step));
    return Math.round(Number(v) * 10 ** d) % Math.round(Number(step) * 10 ** d) === 0;
  };

  it("T-SIZE-3 every market: sizes on the step, prices on the tick, buys at the bid and sells at the ask", () => {
    const usable = Object.keys(reply).filter((s) => books[s]!.ask > books[s]!.bid && books[s]!.bid > 0);
    expect(usable.length).toBeGreaterThanOrEqual(30);
    for (const sign of [1, -1]) {
      const targets = Object.fromEntries(usable.map((s) => [s, sign * 250]));
      const { orders } = planOrders(targets, {}, books, mr, rules.rebalance_band_fraction);
      for (const o of orders) {
        const r = mr[o.symbol]!;
        expect(onGrid(o.size, r.step), `${o.symbol} size ${o.size} step ${r.step}`).toBe(true);
        expect(onGrid(o.price, r.tick), `${o.symbol} price ${o.price} tick ${r.tick}`).toBe(true);
        if (o.side === "buy") expect(Number(o.price)).toBeLessThanOrEqual(books[o.symbol]!.bid);
        else expect(Number(o.price)).toBeGreaterThanOrEqual(books[o.symbol]!.ask);
        expect(Number(o.size)).toBeLessThanOrEqual(Number(r.maxSize));
        expect(o.notional).toBeGreaterThanOrEqual(r.minNotional);
        expect(o.notional).toBeLessThanOrEqual(250 * 1.0001);
      }
    }
  });
  it("T-SIZE-4 a change inside the rebalance band places no order", () => {
    const px = marks["ETH-USD"]!;
    const held = { "ETH-USD": { size: (500 / px).toFixed(4), mark: px } };
    const { orders, skipped } = planOrders({ "ETH-USD": 540 }, held, books, mr, rules.rebalance_band_fraction);
    expect(orders).toEqual([]);
    expect(skipped[0]!.why).toMatch(/band/);
  });
  it("T-SIZE-5 a target of zero closes the exact position, even below the minimum order value", () => {
    const { orders } = planOrders({}, { "ZHIPU-USD": { size: "0.03", mark: marks["ZHIPU-USD"]! } }, books, mr, rules.rebalance_band_fraction);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ symbol: "ZHIPU-USD", side: "sell", size: "0.03", reduces: true });
  });
  it("T-SIZE-6 changes below the minimum are skipped; sizes never exceed the market's maximum", () => {
    const tiny = planOrders({ "ETH-USD": 6 }, {}, books, mr, rules.rebalance_band_fraction);
    expect(tiny.orders).toEqual([]);
    const huge = planOrders({ "ADA-USD": 1e12 }, {}, books, mr, rules.rebalance_band_fraction);
    expect(huge.orders[0]!.size).toBe(mr["ADA-USD"]!.maxSize);
  });
});
