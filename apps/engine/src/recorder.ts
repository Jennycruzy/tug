import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  HL_DEXES,
  MAPPING_VERSION,
  STRIKE_ONLY_MARKETS,
  computeLeans,
  strikeMarketForHlCoin,
  type PositionRow,
  type Rules,
} from "@tug/core";
import { clearinghouseState } from "@tug/hl";
import { bookTickers, markets as strikeMarkets, publicPositions } from "@tug/strike";
import type { CrowdVersion, Member } from "./crowds.js";
import { logEvent, type Db } from "./db.js";

export interface SnapshotResult {
  id: number;
  status: "COMPLETE" | "PARTIAL";
  readCopy: number;
  readFade: number;
  positions: number;
  ms: number;
}

const CONCURRENCY = 6;

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        await fn(item);
      }
    }),
  );
}

/**
 * One snapshot: every crowd member's open positions, mapped to Strike markets,
 * Strike marks at the same time, leans per market. Raw replies are kept gzip-compressed on
 * the server with their SHA-256 stored in the database.
 */
export async function takeSnapshot(
  db: Db,
  rules: Rules,
  crowd: CrowdVersion,
  rawDir: string,
  deadlineMs: number,
  network: string,
): Promise<SnapshotResult> {
  const started = Date.now();
  const snapId = Number(
    db.prepare("INSERT INTO snapshots (crowd_version, started_at, status, network, mapping_version) VALUES (?,?,'RUNNING',?,?)").run(crowd.id, started, network, MAPPING_VERSION)
      .lastInsertRowid,
  );

  const { markets } = await strikeMarkets();
  const books = await bookTickers().catch(() => ({}) as Record<string, { bid: number; ask: number }>);
  const marks: Record<string, number> = {};
  for (const [sym, m] of Object.entries(markets)) if (m.mark_price && m.mark_price > 0) marks[sym] = m.mark_price;

  const rows: PositionRow[] = [];
  const raws: string[] = [];
  const read = { copy: 0, fade: 0 };
  const acct = new Map<string, number>();
  const disabled = new Set(crowd.disabledCoins);
  let errors = 0;

  const readMember = async (m: Member) => {
    if (Date.now() > deadlineMs) return;
    try {
      if (m.platform === "hyperliquid") {
        for (const dex of HL_DEXES) {
          const s = await clearinghouseState(m.memberId, dex);
          raws.push(`${m.memberId}|${dex}|${s.raw}`);
          for (const p of s.positions) {
            const symbol = strikeMarketForHlCoin(p.coin);
            if (!symbol || p.size === 0 || disabled.has(p.coin)) continue;
            rows.push({ memberId: `hl:${m.memberId}`, crowd: m.crowd, symbol, signedNotional: Math.sign(p.size) * p.value });
            acct.set(`hl:${m.memberId}`, m.accountValue);
          }
        }
      } else {
        const s = await publicPositions(m.memberId);
        raws.push(`${m.memberId}|strike|${s.raw}`);
        for (const p of s.positions) {
          const mark = marks[p.symbol];
          if (!mark || p.size === 0) continue;
          rows.push({ memberId: `strike:${m.memberId}`, crowd: m.crowd, symbol: p.symbol, signedNotional: p.size * mark });
          acct.set(`strike:${m.memberId}`, m.accountValue);
        }
      }
      read[m.crowd]++;
    } catch (e) {
      errors++;
      if (errors <= 5) logEvent(db, "recorder", "warn", `member read failed: ${(e as Error).message}`, "E-READ", { member: m.memberId });
    }
  };

  await pool(crowd.members, CONCURRENCY, readMember);

  const nCopy = crowd.members.filter((m) => m.crowd === "copy").length;
  const nFade = crowd.members.filter((m) => m.crowd === "fade").length;
  const readCopy = nCopy ? read.copy / nCopy : 0;
  const readFade = nFade ? read.fade / nFade : 0;
  const status = readCopy >= rules.snapshot_min_read_share && readFade >= rules.snapshot_min_read_share ? "COMPLETE" : "PARTIAL";

  raws.sort();
  const rawText = raws.join("\n");
  const rawSha = createHash("sha256").update(rawText).digest("hex");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, `snapshot-${snapId}.txt.gz`), gzipSync(rawText));

  const leans = status === "COMPLETE" ? computeLeans(rows, rules) : [];
  const finished = Date.now();

  db.transaction(() => {
    const insPos = db.prepare(
      "INSERT INTO positions (snapshot_id, platform, member_id, crowd, symbol, signed_notional, account_value) VALUES (?,?,?,?,?,?,?)",
    );
    for (const r of rows) {
      const [platform, ...rest] = r.memberId.split(":");
      insPos.run(snapId, platform === "hl" ? "hyperliquid" : "strike", rest.join(":"), r.crowd, r.symbol, r.signedNotional, acct.get(r.memberId) ?? null);
    }
    const insMark = db.prepare("INSERT INTO marks (snapshot_id, symbol, mark, funding_rate, bid, ask, min_notional) VALUES (?,?,?,?,?,?,?)");
    for (const [sym, m] of Object.entries(markets)) {
      const b = books[sym];
      if (m.mark_price && m.mark_price > 0) insMark.run(snapId, sym, m.mark_price, m.funding_rate ?? null, b?.bid ?? null, b?.ask ?? null, m.order_min_notional ?? null);
    }
    const insLean = db.prepare(
      "INSERT INTO leans (snapshot_id, symbol, long_copy, short_copy, lean_copy, n_copy, long_fade, short_fade, lean_fade, n_fade, gap, tradable, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const l of leans) {
      insLean.run(snapId, l.symbol, l.copy.long, l.copy.short, l.copy.lean, l.copy.n, l.fade.long, l.fade.short, l.fade.lean, l.fade.n, l.gap, l.tradable ? 1 : 0, l.reason);
    }
    db.prepare(
      "UPDATE snapshots SET finished_at=?, read_copy=?, read_fade=?, status=?, raw_sha256=?, errors=? WHERE id=?",
    ).run(finished, readCopy, readFade, status, rawSha, errors, snapId);
  })();

  if (status === "PARTIAL") {
    logEvent(db, "recorder", "warn", "This snapshot read fewer than 90% of a crowd.", "E-PARTIAL", { snapId, readCopy, readFade });
  }
  return { id: snapId, status, readCopy, readFade, positions: rows.length, ms: finished - started };
}

/** Markets the recorder can cover: every mapped Hyperliquid market plus Strike-only ones. */
export const COVERED_STRIKE_ONLY = STRIKE_ONLY_MARKETS;
