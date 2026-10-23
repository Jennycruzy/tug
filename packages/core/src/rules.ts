import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { z } from "zod";

export const RulesSchema = z
  .object({
    version: z.number().int().positive(),
    copy_tag: z.literal("copy"),
    copy_score_floor: z.number().min(0).max(100),
    copy_max_members: z.number().int().positive(),
    fade_tag: z.literal("counter"),
    fade_max_members: z.number().int().positive(),
    exclude_styles: z.array(z.string()),
    min_account_value_usd: z.number().nonnegative(),
    per_trader_cap_usd: z.number().positive(),
    min_members_copy: z.number().int().positive(),
    min_members_fade: z.number().int().positive(),
    gap_threshold_two_crowds: z.number().min(0).max(1),
    one_crowd_threshold: z.number().min(0).max(1),
    one_crowd_min_members: z.number().int().positive(),
    gross_exposure_cap: z.number().positive(),
    per_market_cap: z.number().positive(),
    leverage_setting: z.number().int().positive(),
    margin_mode: z.enum(["cross", "isolated"]),
    rebalance_every_minutes: z.number().int().positive(),
    rebalance_band_fraction: z.number().min(0).max(1),
    reprice_every_seconds: z.number().int().positive(),
    drawdown_stop_fraction: z.number().min(0).max(1),
    margin_ratio_reduce: z.number().min(0).max(1),
    stale_data_limit_minutes: z.number().int().positive(),
    snapshot_every_minutes: z.number().int().positive(),
    crowd_refresh_every_hours: z.number().int().positive(),
    snapshot_min_read_share: z.number().min(0).max(1),
    testnet_markets: z.array(z.string()),
  })
  .strict();

export type Rules = z.infer<typeof RulesSchema>;

export interface LoadedRules {
  rules: Rules;
  sha256: string;
}

/** Hash of the exact file bytes; this is the published fingerprint. */
export function rulesFingerprint(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export interface Fingerprint {
  version: number;
  file: string;
  sha256: string;
  frozen_at: string;
}

/** The engine trades only under a rules file whose fingerprint was published. */
export function assertPublished(loaded: LoadedRules, published: Fingerprint[]): Fingerprint {
  const hit = published.find((f) => f.sha256 === loaded.sha256 && f.version === loaded.rules.version);
  if (!hit) {
    throw new TugError("E-RULES", "The rules file is not one of the published versions.");
  }
  return hit;
}

export class TugError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TugError";
  }
}
