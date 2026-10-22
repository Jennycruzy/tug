import { WeightBucket, fetchJson } from "@tug/core";
import { z } from "zod";

export const STRIKE_API_URL = process.env.STRIKE_API_URL ?? "https://api.strikefinance.org";
export const STRIKE_PRICE_URL = process.env.STRIKE_PRICE_URL ?? `${STRIKE_API_URL}/price`;

/** Strike allows 2,400 weight per minute; public reads share this budget with trading. */
export const strikeBucket = new WeightBucket(Number(process.env.STRIKE_WEIGHT_BUDGET ?? 2_000));

/** Request weights are not published per endpoint; 5 is a conservative default until measured. */
const READ_WEIGHT = 5;

const num = z.union([z.string(), z.number()]).transform((v) => Number(v));

export const DiscoverItemSchema = z
  .object({
    address: z.string(),
    platform: z.enum(["hyperliquid", "strike"]),
    account_value: num.optional(),
    copy_score: num.optional().nullable(),
    recommended_direction: z.string().optional().nullable(),
    style: z.string().optional().nullable(),
    pnl: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
    top_assets: z.array(z.object({ asset: z.string(), symbol: z.string() })).optional().nullable(),
    stats_updated_at_ms: z.number().optional().nullable(),
  })
  .passthrough();
export type DiscoverItem = z.infer<typeof DiscoverItemSchema>;

const DiscoverPageSchema = z.object({
  items: z.array(DiscoverItemSchema),
  next_cursor: z.string().optional().nullable(),
  total: z.number().optional(),
});

export interface DiscoverQuery {
  platform: "hyperliquid" | "strike";
  sort: string;
  order: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export async function discoverPage(q: DiscoverQuery) {
  const p = new URLSearchParams({
    platform: q.platform,
    sort: q.sort,
    order: q.order,
    limit: String(q.limit ?? 200),
  });
  if (q.cursor) p.set("cursor", q.cursor);
  const { json, raw } = await fetchJson(`${STRIKE_API_URL}/v2/copy/discover?${p}`, {
    weight: READ_WEIGHT,
    bucket: strikeBucket,
  });
  return { ...DiscoverPageSchema.parse(json), raw };
}

const StrikePositionSchema = z
  .object({ symbol: z.string(), size: num, entry_price: num.optional() })
  .passthrough();

/** Public open positions of any Strike account (no auth). */
export async function publicPositions(accountId: string) {
  const { json, raw } = await fetchJson(
    `${STRIKE_API_URL}/v2/positions?account_id=${encodeURIComponent(accountId)}`,
    { weight: READ_WEIGHT, bucket: strikeBucket },
  );
  const parsed = z.object({ positions: z.array(StrikePositionSchema).nullable().optional() }).parse(json);
  return { positions: parsed.positions ?? [], raw };
}

const MarketSchema = z
  .object({
    symbol: z.string(),
    status: z.string(),
    mark_price: num.optional(),
    index_price: num.optional(),
    funding_rate: num.optional(),
    order_min_notional: num.optional(),
    /** Kept as strings: rounding needs the exact decimals Strike publishes. */
    order_tick_price: z.string().optional(),
    order_limit_step_size: z.string().optional(),
    order_limit_price_bound: num.optional(),
    bid1_price: num.optional(),
    ask1_price: num.optional(),
  })
  .passthrough();
export type StrikeMarket = z.infer<typeof MarketSchema>;

export async function markets(): Promise<{ markets: Record<string, StrikeMarket>; raw: string }> {
  const { json, raw } = await fetchJson(`${STRIKE_API_URL}/v2/markets`, { weight: READ_WEIGHT, bucket: strikeBucket });
  return { markets: z.object({ markets: z.record(MarketSchema) }).parse(json).markets, raw };
}

const BookTickerSchema = z.array(z.object({ symbol: z.string(), bidPrice: num, askPrice: num }).passthrough());

/** Best bid and ask for every market in one public call. */
export async function bookTickers(): Promise<Record<string, { bid: number; ask: number }>> {
  const { json } = await fetchJson(`${STRIKE_PRICE_URL}/v2/ticker/bookTicker`, { weight: READ_WEIGHT, bucket: strikeBucket });
  const rows = BookTickerSchema.parse(json);
  return Object.fromEntries(rows.map((r) => [r.symbol, { bid: r.bidPrice, ask: r.askPrice }]));
}

export * from "./signed.js";
export * from "./userFrames.js";
export * from "./userStream.js";
