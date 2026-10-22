import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAPPING_FINGERPRINTS,
  MAPPING_VERSION,
  RulesSchema,
  WeightBucket,
  allMappedMarkets,
  assertPublished,
  checkMapping,
  computeLeans,
  loadRules,
  mappingTableFingerprint,
  rulesFingerprint,
  strikeMarketForHlCoin,
  type PositionRow,
} from "../src/index.js";

const rules = loadRules("rules/tug-rules-v1.json").rules;
const fps = JSON.parse(readFileSync("evidence/rules-fingerprints.json", "utf8"));

describe("rules", () => {
  it("T-RULES-1 the shipped rules file parses and is published", () => {
    const loaded = loadRules("rules/tug-rules-v1.json");
    expect(assertPublished(loaded, fps).version).toBe(1);
  });
  it("T-RULES-2 one changed byte is refused", () => {
    const bytes = readFileSync("rules/tug-rules-v1.json");
    const changed = Buffer.from(bytes.toString().replace('"copy_score_floor": 65', '"copy_score_floor": 66'));
    const loaded = { rules: RulesSchema.parse(JSON.parse(changed.toString())), sha256: rulesFingerprint(changed) };
    expect(() => assertPublished(loaded, fps)).toThrow(/not one of the published versions/);
  });
  it("T-RULES-3 unknown fields are refused", () => {
    expect(() => RulesSchema.parse({ ...rules, extra: 1 })).toThrow();
  });
});

describe("mapping", () => {
  it("T-MAP-1 renamed side-exchange coins map to Strike markets", () => {
    expect(strikeMarketForHlCoin("xyz:SKHX")).toBe("SKHYNIX-USD");
    expect(strikeMarketForHlCoin("xyz:GOLD")).toBe("XAU-USD");
    expect(strikeMarketForHlCoin("xyz:SILVER")).toBe("XAG-USD");
    expect(strikeMarketForHlCoin("xyz:XYZ100")).toBe("NAS100-USD");
    expect(strikeMarketForHlCoin("xyz:CL")).toBe("WTI-USD");
    expect(strikeMarketForHlCoin("cash:WTI")).toBeUndefined();
    expect(strikeMarketForHlCoin("io:SNDK")).toBe("SNDK-USD");
    expect(strikeMarketForHlCoin("io:DRAM")).toBe("DRAM-USD");
  });
  it("T-MAP-2 main-exchange coins map by name; unknown coins are ignored", () => {
    expect(strikeMarketForHlCoin("ETH")).toBe("ETH-USD");
    expect(strikeMarketForHlCoin("xyz:SKHY")).toBeUndefined();
    expect(strikeMarketForHlCoin("@107")).toBeUndefined();
    expect(strikeMarketForHlCoin("ARB")).toBeUndefined();
  });
  it("T-MAP-3 all 32 Strike markets are covered (31 mapped + NIGHT Strike-only)", () => {
    const strike = Object.keys(JSON.parse(readFileSync("packages/core/test/fixtures/strike-markets-2026-10-22.json", "utf8")).markets).sort();
    expect(allMappedMarkets()).toEqual(strike);
  });
  it("T-MAP-4 price check fails a wrong row", () => {
    const res = checkMapping({ "xyz:SKHX": 931.92 }, { "SKHYNIX-USD": 932.0 });
    expect(res.find((r) => r.coin === "xyz:SKHX")!.ok).toBe(true);
    const bad = checkMapping({ "xyz:SKHX": 137.5 }, { "SKHYNIX-USD": 932.0 });
    expect(bad.find((r) => r.coin === "xyz:SKHX")!.ok).toBe(false);
    const wti = checkMapping({ "xyz:CL": 99.416 }, { "WTI-USD": 99.467 });
    expect(wti.find((r) => r.coin === "xyz:CL")!.ok).toBe(true);
  });
});

const pos = (memberId: string, crowd: "copy" | "fade", symbol: string, n: number): PositionRow => ({ memberId, crowd, symbol, signedNotional: n });
const many = (crowd: "copy" | "fade", symbol: string, k: number, n: number) =>
  Array.from({ length: k }, (_, i) => pos(`${crowd}${i}`, crowd, symbol, n));

describe("leans", () => {
  it("T-LEAN-1 opposite crowds above the threshold are tradable on the copy side", () => {
    const [row] = computeLeans([...many("copy", "ETH-USD", 6, -100), ...many("fade", "ETH-USD", 4, 300)], rules);
    expect(row!.copy.lean).toBe(-1);
    expect(row!.fade.lean).toBe(1);
    expect(row!.gap).toBe(-1);
    expect(row!.reason).toBe("two_crowds");
  });
  it("T-LEAN-2 same-sign crowds are not tradable", () => {
    const [row] = computeLeans([...many("copy", "BTC-USD", 6, 100), ...many("fade", "BTC-USD", 4, 100)], rules);
    expect(row!.tradable).toBe(false);
  });
  it("T-LEAN-3 each position counts at most the per-trader cap", () => {
    const rows = [pos("w", "fade", "SOL-USD", 50_000_000), ...many("fade", "SOL-USD", 2, -600_000), ...many("copy", "SOL-USD", 5, -1)];
    const [row] = computeLeans(rows, rules);
    expect(row!.fade.long).toBe(1_000_000);
    expect(row!.fade.short).toBe(1_200_000);
  });
  it("T-LEAN-4 one crowd needs 10 members and a 0.6 lean", () => {
    expect(computeLeans(many("copy", "NVDA-USD", 9, 100), rules)[0]!.tradable).toBe(false);
    const ok = computeLeans(many("copy", "NVDA-USD", 10, 100), rules)[0]!;
    expect(ok.reason).toBe("copy_only");
    expect(ok.gap).toBe(1);
    const fade = computeLeans(many("fade", "PUMP-USD", 10, 100), rules)[0]!;
    expect(fade.reason).toBe("fade_only");
    expect(fade.gap).toBe(-1);
  });
  it("T-LEAN-5 opposite crowds with a gap below the threshold are not tradable", () => {
    const rows = [...many("copy", "ETH-USD", 5, -7), pos("c9", "copy", "ETH-USD", 15), ...many("fade", "ETH-USD", 3, 11), pos("f9", "fade", "ETH-USD", -27)];
    const [row] = computeLeans(rows, rules);
    expect(row!.copy.lean).toBeCloseTo(-0.4);
    expect(row!.fade.lean).toBeCloseTo(0.1);
    expect(row!.tradable).toBe(false);
  });
  it("T-LEAN-6 output is sorted and deterministic", () => {
    const rows = [...many("copy", "ZEC-USD", 5, 1), ...many("copy", "ADA-USD", 5, 1)];
    expect(computeLeans(rows, rules).map((r) => r.symbol)).toEqual(["ADA-USD", "ZEC-USD"]);
    expect(computeLeans(rows, rules)).toEqual(computeLeans([...rows].reverse(), rules));
  });
});

describe("bucket", () => {
  it("waits for refill instead of exceeding the budget", async () => {
    let t = 0;
    const waits: number[] = [];
    const b = new WeightBucket(60, () => t, async (ms) => { waits.push(ms); t += ms; });
    await b.take(60);
    await b.take(30);
    expect(waits.reduce((a, c) => a + c, 0)).toBeGreaterThanOrEqual(30_000);
  });
});

describe("mapping version", () => {
  it("the mapping table matches the fingerprint recorded for the current MAPPING_VERSION", () => {
    // A changed table needs a new MAPPING_VERSION (stored on every snapshot) and its fingerprint here.
    expect(mappingTableFingerprint(), "mapping table changed: bump MAPPING_VERSION and record its fingerprint").toBe(
      MAPPING_FINGERPRINTS[MAPPING_VERSION],
    );
  });
});
