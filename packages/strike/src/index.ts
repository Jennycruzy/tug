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

const VaultSchema = z
  .object({ vault_id: z.string(), name: z.string(), status: z.string(), share_price: num, equity: num, total_shares: num })
  .passthrough();
export type StrikeVault = z.infer<typeof VaultSchema>;

/** One vault as Strike publishes it (no auth): share price, equity, total shares (Strike's vault skill). */
export async function vault(vaultId: string): Promise<{ vault: StrikeVault; raw: string }> {
  const { json, raw } = await fetchJson(`${STRIKE_API_URL}/v2/vault/${encodeURIComponent(vaultId)}`, { weight: READ_WEIGHT, bucket: strikeBucket });
  return { vault: VaultSchema.parse(json), raw };
}

const VaultMoveSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    account_id: z.string().optional(),
    status: z.string(),
    timestamp: z.number(),
    usd_amount: num.optional(),
    actual_usd: num.optional(),
    estimated_usd: num.optional(),
    shares_minted: num.optional(),
    shares_burned: num.optional(),
    share_price: num.optional(),
    execute_at_timestamp: z.number().optional(),
    executed_timestamp: z.number().optional(),
  })
  .passthrough();
export type StrikeVaultMove = z.infer<typeof VaultMoveSchema>;

/** Every deposit and withdrawal in a vault, newest first (no auth; follows next_cursor to the end). */
export async function vaultHistory(vaultId: string): Promise<StrikeVaultMove[]> {
  const out: StrikeVaultMove[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url = `${STRIKE_API_URL}/v2/vault/${encodeURIComponent(vaultId)}/history?limit=500${cursor ? `&pagination=${encodeURIComponent(cursor)}` : ""}`;
    const { json } = await fetchJson(url, { weight: READ_WEIGHT, bucket: strikeBucket });
    const r = z.object({ history: z.array(VaultMoveSchema).nullable().optional(), next_cursor: z.string().nullable().optional() }).parse(json);
    out.push(...(r.history ?? []));
    cursor = r.next_cursor ?? null;
    if (!cursor || (r.history ?? []).length === 0) break;
  }
  return out;
}

export * from "./signed.js";
export * from "./userFrames.js";
export * from "./userStream.js";
