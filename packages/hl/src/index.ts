import { WeightBucket, fetchJson } from "@tug/core";
import { z } from "zod";

const INFO_URL = process.env.HL_INFO_URL ?? "https://api.hyperliquid.xyz/info";

/** Hyperliquid allows 1,200 weight per minute per IP; we keep a margin. */
export const hlBucket = new WeightBucket(Number(process.env.HL_WEIGHT_BUDGET ?? 1_100));

const PositionSchema = z.object({
  coin: z.string(),
  szi: z.string(),
  positionValue: z.string(),
  entryPx: z.string().nullable().optional(),
});

const ClearinghouseSchema = z.object({
  assetPositions: z.array(z.object({ position: PositionSchema })),
  marginSummary: z.object({ accountValue: z.string() }).passthrough(),
});

export interface HlPosition {
  coin: string;
  /** Signed size: positive long, negative short. */
  size: number;
  /** Absolute USD value of the position at Hyperliquid's mark. */
  value: number;
}

export interface HlState {
  positions: HlPosition[];
  accountValue: number;
  raw: string;
}

async function info(body: Record<string, unknown>, weight: number) {
  return fetchJson(INFO_URL, { method: "POST", body, weight, bucket: hlBucket });
}

/** Open positions on one Hyperliquid exchange (`""` = main). Weight 2. */
export async function clearinghouseState(user: string, dex: string): Promise<HlState> {
  const { json, raw } = await info({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) }, 2);
  const s = ClearinghouseSchema.parse(json);
  return {
    positions: s.assetPositions.map(({ position: p }) => ({
      coin: p.coin,
      size: Number(p.szi),
      value: Math.abs(Number(p.positionValue)),
    })),
    accountValue: Number(s.marginSummary.accountValue),
    raw,
  };
}

/** Mid prices on one exchange. Weight 2. */
export async function allMids(dex: string): Promise<Record<string, number>> {
  const { json } = await info({ type: "allMids", ...(dex ? { dex } : {}) }, 2);
  const m = z.record(z.string()).parse(json);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)]));
}
