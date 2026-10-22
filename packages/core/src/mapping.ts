import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
/**
 * Hyperliquid coin → Strike market. One table, checked at every crowd refresh against
 * Strike's own `top_assets` mapping and a price match (see `checkMapping`).
 * Names that differ were matched by price on 2026-10-22 (SKHX ≈ SKHYNIX, GOLD ≈ XAU, CL ≈ WTI ...).
 * `cash:WTI` is a different contract (69.4 vs Strike WTI 99.5 on 2026-10-22) and is not used.
 */
export const HL_DEXES = ["", "xyz", "io"] as const;
export type HlDex = (typeof HL_DEXES)[number];

// LIT added in mapping v4: Strike listed LIT-USD on 2026-10-22 (14:34:59Z); Hyperliquid main LIT 3.558 vs Strike mark 3.555.
const MAIN = ["ADA", "BNB", "BTC", "DOGE", "ETH", "HYPE", "LIT", "NEAR", "PUMP", "SOL", "XRP", "ZEC"];
const XYZ_SAME = [
  "AAOI", "COIN", "CRCL", "CXMT", "DRAM", "GOOGL", "MINIMAX", "MU", "NVDA",
  "SNDK", "SP500", "SPCX", "TSLA", "UNITREE", "ZHIPU",
];
const XYZ_RENAMED: Record<string, string> = {
  SKHX: "SKHYNIX",
  GOLD: "XAU",
  SILVER: "XAG",
  XYZ100: "NAS100",
  CL: "WTI",
};

const TABLE = new Map<string, string>();
for (const c of MAIN) TABLE.set(c, `${c}-USD`);
for (const c of XYZ_SAME) TABLE.set(`xyz:${c}`, `${c}-USD`);
for (const [c, s] of Object.entries(XYZ_RENAMED)) TABLE.set(`xyz:${c}`, `${s}-USD`);
// The `io` exchange held 13.5% of the crowds' SNDK exposure on 2026-10-22 (above the 10% rule); price-matched.
TABLE.set("io:SNDK", "SNDK-USD");
TABLE.set("io:DRAM", "DRAM-USD");

/**
 * Mapping versions, recorded on every snapshot so old snapshots replay with the table they used.
 * v1 (record start → snapshot 11): main, xyz, cash; WTI from cash:WTI (a different contract).
 * v2 (snapshots 12–22): main, xyz; WTI from xyz:CL.
 * v3 (snapshots 23 → the v4 deploy): main, xyz, io; adds io:SNDK and io:DRAM.
 * v4 (from the deploy that adds it): adds LIT (main) → LIT-USD, Strike's 33rd market.
 */
export const MAPPING_VERSION = 4;
/** The table fingerprint each mapping version shipped with; a test fails if the table changes without a new version. */
export const MAPPING_FINGERPRINTS: Record<number, string> = {
  3: "7cb7d57affd526a3108f14706df91aa232178c7e7d8d61b6ab3efb0e598d72e0",
  4: "d3df429195bb0f22e706b630376f1af0a18556da2e40551ce7cd9b52b62ddcc2",
};

/** SHA-256 of the exchanges read and every coin → market row, in a fixed order. */
export function mappingTableFingerprint(): string {
  const rows = [...TABLE.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ dexes: HL_DEXES, rows, strikeOnly: STRIKE_ONLY_MARKETS }))));
}

/**
 * Markets whose source changed when each mapping version started: across that step their positions are
 * not comparable (a market newly read, or read from another contract), so a change there is not a trade.
 */
export const MAPPING_CHANGES: Record<number, string[]> = { 2: ["WTI-USD"], 3: ["SNDK-USD", "DRAM-USD"], 4: ["LIT-USD"] };

/** Markets whose source changed between two mapping versions (both included in the span). */
export function marketsRemapped(fromVersion: number, toVersion: number): Set<string> {
  const out = new Set<string>();
  for (let v = Math.min(fromVersion, toVersion) + 1; v <= Math.max(fromVersion, toVersion); v++) for (const m of MAPPING_CHANGES[v] ?? []) out.add(m);
  return out;
}

/** Markets whose rows are not comparable under a given mapping version and are left out of records. */
export const MAPPING_EXCLUDED: Record<number, string[]> = { 1: ["WTI-USD"], 2: [], 3: [], 4: [] };

/** Markets with no Hyperliquid source; their crowds come from Strike traders only. */
export const STRIKE_ONLY_MARKETS = ["NIGHT-USD"];

/** Hyperliquid coin names arrive as `ETH` on the main exchange and `xyz:NVDA` on side exchanges. */
export function strikeMarketForHlCoin(coin: string): string | undefined {
  return TABLE.get(coin);
}

export function mappedHlCoins(): Array<[string, string]> {
  return [...TABLE.entries()];
}

export function allMappedMarkets(): string[] {
  return [...new Set([...TABLE.values(), ...STRIKE_ONLY_MARKETS])].sort();
}

export interface MappingCheck {
  coin: string;
  market: string;
  hlMid: number;
  strikeMark: number;
  ok: boolean;
}

/** A mapping row passes when Hyperliquid's mid is within `tolerance` of Strike's mark. */
export function checkMapping(
  hlMids: Record<string, number>,
  strikeMarks: Record<string, number>,
  tolerance = 0.02,
): MappingCheck[] {
  const out: MappingCheck[] = [];
  for (const [coin, market] of TABLE) {
    const hlMid = hlMids[coin];
    const strikeMark = strikeMarks[market];
    if (hlMid === undefined || strikeMark === undefined || strikeMark <= 0) {
      out.push({ coin, market, hlMid: hlMid ?? NaN, strikeMark: strikeMark ?? NaN, ok: false });
      continue;
    }
    out.push({ coin, market, hlMid, strikeMark, ok: Math.abs(hlMid / strikeMark - 1) < tolerance });
  }
  return out;
}
