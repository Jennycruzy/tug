import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { HL_DEXES, allMappedMarkets, checkMapping, type MappingCheck, type Rules } from "@tug/core";
import { allMids } from "@tug/hl";
import { discoverPage, markets as strikeMarkets, type DiscoverItem } from "@tug/strike";
import { logEvent, type Db } from "./db.js";

export interface Member {
  platform: "hyperliquid" | "strike";
  memberId: string;
  crowd: "copy" | "fade";
  copyScore: number | null;
  style: string | null;
  accountValue: number;
  pnl30d: number | null;
  raw: DiscoverItem;
}

export interface CrowdVersion {
  id: number;
  pulledAt: number;
  members: Member[];
  /** Hyperliquid coins whose mapping failed its price check at this refresh; skipped until the next. */
  disabledCoins: string[];
}

export interface MappingResult {
  checks: MappingCheck[];
  disabledCoins: string[];
  uncoveredStrikeMarkets: string[];
}

/**
 * Mapping checks run at every crowd refresh: (1) price match of every row against Strike's mark,
 * (2) every Strike market that Strike's own `top_assets` maps a Hyperliquid asset to is covered.
 */
export async function checkMappingLive(items: DiscoverItem[]): Promise<MappingResult> {
  const mids: Record<string, number> = {};
  for (const dex of HL_DEXES) Object.assign(mids, await allMids(dex));
  const { markets } = await strikeMarkets();
  const marks: Record<string, number> = {};
  for (const [sym, m] of Object.entries(markets)) if (m.mark_price) marks[sym] = m.mark_price;
  const checks = checkMapping(mids, marks);
  const covered = new Set(allMappedMarkets());
  const strikeMapped = new Set<string>();
  for (const it of items) for (const a of it.top_assets ?? []) if (a.symbol) strikeMapped.add(a.symbol);
  return {
    checks,
    disabledCoins: checks.filter((c) => !c.ok).map((c) => c.coin),
    // Only symbols that are Strike markets count: `top_assets` also carries labels such as "ALL".
    uncoveredStrikeMarkets: [...strikeMapped].filter((s) => s in markets && !covered.has(s)).sort(),
  };
}

const PLATFORMS = ["hyperliquid", "strike"] as const;

function pnl30(i: DiscoverItem): number | null {
  const v = i.pnl?.["30d"];
  return v === undefined || v === null ? null : Number(v);
}

function eligible(i: DiscoverItem, rules: Rules): boolean {
  if (i.style && rules.exclude_styles.includes(i.style)) return false;
  return Number(i.account_value ?? 0) >= rules.min_account_value_usd;
}

/**
 * Builds both crowds from Strike's own copy discovery.
 * Copy picks: walk each platform by copy score, highest first, until scores fall below the floor.
 * Fade picks: walk each platform by 30-day PnL, lowest first, until PnL turns positive
 * (Strike tags "counter" only among losing traders; observed 2026-10-22).
 */
export async function buildCrowds(
  db: Db,
  rules: Rules,
  rulesSha: string,
  rawDir: string,
  network: string,
): Promise<CrowdVersion> {
  const raws: string[] = [];
  const allItems: DiscoverItem[] = [];
  let pages = 0;
  const copy = new Map<string, DiscoverItem>();
  const fade = new Map<string, DiscoverItem>();

  for (const platform of PLATFORMS) {
    let cursor: string | undefined;
    for (;;) {
      const page = await discoverPage({ platform, sort: "copy_score", order: "desc", cursor });
      raws.push(page.raw);
      allItems.push(...page.items);
      pages++;
      let below = false;
      for (const it of page.items) {
        const score = it.copy_score ?? 0;
        if (score < rules.copy_score_floor) {
          below = true;
          continue;
        }
        if (it.recommended_direction === rules.copy_tag && eligible(it, rules)) copy.set(`${platform}:${it.address}`, it);
      }
      if (below || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    cursor = undefined;
    for (;;) {
      const page = await discoverPage({ platform, sort: "pnl_30d", order: "asc", cursor });
      raws.push(page.raw);
      allItems.push(...page.items);
      pages++;
      let positive = false;
      for (const it of page.items) {
        const p = pnl30(it);
        if (p !== null && p > 0) {
          positive = true;
          continue;
        }
        if (it.recommended_direction === rules.fade_tag && eligible(it, rules)) fade.set(`${platform}:${it.address}`, it);
      }
      if (positive || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
  }

  const toMember = (crowd: "copy" | "fade") => (it: DiscoverItem): Member => ({
    platform: it.platform,
    memberId: it.platform === "hyperliquid" ? it.address.toLowerCase() : it.address,
    crowd,
    copyScore: it.copy_score ?? null,
    style: it.style ?? null,
    accountValue: Number(it.account_value ?? 0),
    pnl30d: pnl30(it),
    raw: it,
  });

  const copyMembers = [...copy.values()]
    .sort((a, b) => (b.copy_score ?? 0) - (a.copy_score ?? 0))
    .slice(0, rules.copy_max_members)
    .map(toMember("copy"));
  const copyIds = new Set(copyMembers.map((m) => `${m.platform}:${m.memberId}`));
  const fadeMembers = [...fade.values()]
    .sort((a, b) => (pnl30(a) ?? 0) - (pnl30(b) ?? 0))
    .slice(0, rules.fade_max_members)
    .map(toMember("fade"))
    .filter((m) => !copyIds.has(`${m.platform}:${m.memberId}`));
  const members = [...copyMembers, ...fadeMembers];

  const memberHash = createHash("sha256")
    .update(members.map((m) => `${m.crowd}:${m.platform}:${m.memberId}`).sort().join("\n"))
    .digest("hex");
  const rawText = raws.join("\n");
  const rawSha = createHash("sha256").update(rawText).digest("hex");
  const pulledAt = Date.now();
  const mapping = await checkMappingLive(allItems);

  const id = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO crowd_versions (pulled_at, rules_sha256, copy_count, fade_count, member_hash, raw_sha256, pages, network, mapping_json) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(pulledAt, rulesSha, copyMembers.length, fadeMembers.length, memberHash, rawSha, pages, network, JSON.stringify(mapping));
    const vid = Number(info.lastInsertRowid);
    const ins = db.prepare(
      "INSERT INTO crowd_members (version_id, platform, member_id, crowd, copy_score, style, account_value, pnl_30d, raw_json) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    for (const m of members) {
      ins.run(vid, m.platform, m.memberId, m.crowd, m.copyScore, m.style, m.accountValue, m.pnl30d, JSON.stringify(m.raw));
    }
    return vid;
  })();

  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, `crowds-${id}.txt.gz`), gzipSync(rawText));
  for (const c of mapping.checks.filter((x) => !x.ok)) {
    logEvent(db, "crowds", "warn", "A market's mapping failed its price check.", "E-MAP", c);
  }
  if (mapping.uncoveredStrikeMarkets.length) {
    logEvent(db, "crowds", "warn", "Strike maps assets to markets TUG does not cover.", "E-UNMAPPED", mapping.uncoveredStrikeMarkets);
  }
  logEvent(db, "crowds", "info", "crowds built", undefined, {
    id,
    pages,
    copy: copyMembers.length,
    fade: fadeMembers.length,
    copyStrike: copyMembers.filter((m) => m.platform === "strike").length,
    fadeStrike: fadeMembers.filter((m) => m.platform === "strike").length,
  });
  return { id, pulledAt, members, disabledCoins: mapping.disabledCoins };
}

export function loadLatestCrowds(db: Db): CrowdVersion | undefined {
  const v = db.prepare("SELECT id, pulled_at, mapping_json FROM crowd_versions ORDER BY id DESC LIMIT 1").get() as
    | { id: number; pulled_at: number; mapping_json: string | null }
    | undefined;
  if (!v) return undefined;
  const rows = db
    .prepare("SELECT platform, member_id, crowd, copy_score, style, account_value, pnl_30d, raw_json FROM crowd_members WHERE version_id = ?")
    .all(v.id) as Array<{
    platform: "hyperliquid" | "strike";
    member_id: string;
    crowd: "copy" | "fade";
    copy_score: number | null;
    style: string | null;
    account_value: number;
    pnl_30d: number | null;
    raw_json: string;
  }>;
  const disabledCoins = v.mapping_json ? (JSON.parse(v.mapping_json) as MappingResult).disabledCoins : [];
  return {
    id: v.id,
    pulledAt: v.pulled_at,
    disabledCoins,
    members: rows.map((r) => ({
      platform: r.platform,
      memberId: r.member_id,
      crowd: r.crowd,
      copyScore: r.copy_score,
      style: r.style,
      accountValue: r.account_value,
      pnl30d: r.pnl_30d,
      raw: JSON.parse(r.raw_json),
    })),
  };
}
