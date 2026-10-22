import { describe, expect, it } from "vitest";
import { feesSaved, loadRules, MAPPING_EXCLUDED, marketsRemapped, type CopyCrowd, type SnapshotInput } from "@tug/core";
import { rebuildRecords } from "../src/records.js";
import { FIXTURE, fixtureDb } from "./fixture-db.js";

const { rules } = loadRules("rules/tug-rules-v1.json");
const RECORD_START = Date.parse("2026-10-22T11:55:21Z");

type Pos = { snapshot_id: number; platform: string; member_id: string; crowd: "copy" | "fade"; symbol: string; signed_notional: number; size: number | null };
const positions = FIXTURE.positions as unknown as Pos[];
const marks = FIXTURE.marks as unknown as Array<{ snapshot_id: number; symbol: string; mark: number; funding_rate: number | null }>;
const snapTs = new Map((FIXTURE.snapshots as unknown as Array<{ id: number; started_at: number }>).map((s) => [s.id, s.started_at]));
const crowd: CopyCrowd = {
  copyCount: (FIXTURE.crowd_members as unknown as Array<{ crowd: string }>).filter((m) => m.crowd === "copy").length,
  accountValue: Object.fromEntries(
    (FIXTURE.crowd_members as unknown as Array<{ platform: string; member_id: string; crowd: string; account_value: number }>)
      .filter((m) => m.crowd === "copy")
      .map((m) => [`${m.platform}:${m.member_id}`, m.account_value]),
  ),
};
const input = (id: number, keep: (p: Pos) => boolean = () => true): SnapshotInput => ({
  id,
  ts: snapTs.get(id)!,
  crowdVersion: 1,
  marks: Object.fromEntries(marks.filter((m) => m.snapshot_id === id).map((m) => [m.symbol, { mark: m.mark, funding: m.funding_rate }])),
  gaps: {},
  members: positions
    .filter((p) => p.snapshot_id === id && keep(p))
    .map((p) => ({ crowd: p.crowd, member: `${p.platform}:${p.member_id}`, symbol: p.symbol, notional: p.signed_notional, size: p.size })),
});
const paperPoint = { snapshotId: 15, ts: snapTs.get(15)!, equity: 10_000, turnover: 0, fees: 0, funding: 0, positions: {} };

describe("fees saved counts trades, not price moves (real snapshots 14 → 15)", () => {
  it("a copy pick whose size did not change while the price moved adds no order and no turnover", () => {
    const member = (p: Pos) => p.member_id === "0x00620ada30d98ffcf8e3c91e65283127d11c64ce" && p.symbol === "BTC-USD";
    const a = input(14, member);
    const b = input(15, member);
    expect(a.members[0]!.size).toBe(-1.92252);
    expect(b.members[0]!.size).toBe(-1.92252);
    expect(a.members[0]!.notional).not.toBe(b.members[0]!.notional);
    const f = feesSaved([a, b], { 1: crowd }, [paperPoint])!;
    expect(f.baseline.orders).toBe(0);
    expect(f.baseline.turnover).toBe(0);
  });

  it("over the hour, orders equal the copy picks' real size changes, far fewer than value changes", () => {
    const db = fixtureDb();
    rebuildRecords(db, rules, RECORD_START, "mainnet");
    const fees = JSON.parse((db.prepare("SELECT json FROM records_json WHERE name='fees_saved'").get() as { json: string }).json);
    // Count independently: (member, market) pairs whose summed size changed between consecutive snapshots,
    // leaving out each snapshot's excluded markets and any market whose mapping changed across the step.
    const ids = [...snapTs.keys()].sort((x, y) => x - y);
    const version = new Map((FIXTURE.snapshots as unknown as Array<{ id: number; mapping_version: number }>).map((s) => [s.id, s.mapping_version]));
    const kept = (p: Pos) => !(MAPPING_EXCLUDED[version.get(p.snapshot_id)!] ?? []).includes(p.symbol);
    const sizeAt = (id: number) => {
      const m = new Map<string, number>();
      for (const p of positions) if (p.snapshot_id === id && p.crowd === "copy" && kept(p)) m.set(`${p.platform}:${p.member_id}|${p.symbol}`, (m.get(`${p.platform}:${p.member_id}|${p.symbol}`) ?? 0) + p.size!);
      return m;
    };
    let sizeChanges = 0;
    let valueChanges = 0;
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = sizeAt(ids[i]!);
      const b = sizeAt(ids[i + 1]!);
      const remapped = marketsRemapped(version.get(ids[i]!)!, version.get(ids[i + 1]!)!);
      for (const k of new Set([...a.keys(), ...b.keys()])) if (!remapped.has(k.split("|")[1]!) && (a.get(k) ?? 0) !== (b.get(k) ?? 0)) sizeChanges++;
      const va = new Map<string, number>();
      const vb = new Map<string, number>();
      for (const p of positions) {
        if (p.crowd !== "copy" || !kept(p)) continue;
        const k = `${p.platform}:${p.member_id}|${p.symbol}`;
        if (p.snapshot_id === ids[i]) va.set(k, (va.get(k) ?? 0) + p.signed_notional);
        if (p.snapshot_id === ids[i + 1]) vb.set(k, (vb.get(k) ?? 0) + p.signed_notional);
      }
      for (const k of new Set([...va.keys(), ...vb.keys()])) if ((va.get(k) ?? 0) !== (vb.get(k) ?? 0)) valueChanges++;
    }
    expect(fees.baseline.unsized).toBe(0);
    expect(fees.baseline.orders).toBe(sizeChanges);
    expect(fees.baseline.orders * 5).toBeLessThan(valueChanges);
  });
});
