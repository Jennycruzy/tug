import { createHash } from "node:crypto";
import type { Rules } from "@tug/core";
import { discoverPage, type DiscoverItem } from "@tug/strike";
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
export async function buildCrowds(db: Db, rules: Rules, rulesSha: string): Promise<CrowdVersion> {
  const raws: string[] = [];
  let pages = 0;
  const copy = new Map<string, DiscoverItem>();
  const fade = new Map<string, DiscoverItem>();

  for (const platform of PLATFORMS) {
    let cursor: string | undefined;
    for (;;) {
      const page = await discoverPage({ platform, sort: "copy_score", order: "desc", cursor });
      raws.push(page.raw);
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
  const rawSha = createHash("sha256").update(raws.join("\n")).digest("hex");
  const pulledAt = Date.now();

  const id = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO crowd_versions (pulled_at, rules_sha256, copy_count, fade_count, member_hash, raw_sha256, pages) VALUES (?,?,?,?,?,?,?)",
      )
      .run(pulledAt, rulesSha, copyMembers.length, fadeMembers.length, memberHash, rawSha, pages);
    const vid = Number(info.lastInsertRowid);
    const ins = db.prepare(
      "INSERT INTO crowd_members (version_id, platform, member_id, crowd, copy_score, style, account_value, pnl_30d, raw_json) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    for (const m of members) {
      ins.run(vid, m.platform, m.memberId, m.crowd, m.copyScore, m.style, m.accountValue, m.pnl30d, JSON.stringify(m.raw));
    }
    return vid;
  })();

  logEvent(db, "crowds", "info", "crowds built", undefined, {
    id,
    pages,
    copy: copyMembers.length,
    fade: fadeMembers.length,
    copyStrike: copyMembers.filter((m) => m.platform === "strike").length,
    fadeStrike: fadeMembers.filter((m) => m.platform === "strike").length,
  });
  return { id, pulledAt, members };
}

export function loadLatestCrowds(db: Db): CrowdVersion | undefined {
  const v = db.prepare("SELECT id, pulled_at FROM crowd_versions ORDER BY id DESC LIMIT 1").get() as
    | { id: number; pulled_at: number }
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
  return {
    id: v.id,
    pulledAt: v.pulled_at,
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
