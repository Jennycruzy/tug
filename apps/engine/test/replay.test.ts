import { describe, expect, it } from "vitest";
import { computeLeans, loadRules, type PositionRow } from "@tug/core";
import { rebuildRecords } from "../src/records.js";
import { FIXTURE, fixtureDb } from "./fixture-db.js";

const { rules } = loadRules("rules/tug-rules-v1.json");
const RECORD_START = Date.parse("2026-10-22T11:55:21Z");

describe("replay of real stored snapshots (4–15, 2026-10-22)", () => {
  it("recomputing every snapshot's leans from its stored positions gives the stored leans exactly", () => {
    const leanCols = ["symbol", "long_copy", "short_copy", "lean_copy", "n_copy", "long_fade", "short_fade", "lean_fade", "n_fade", "gap", "tradable", "reason"];
    for (const s of FIXTURE.snapshots!) {
      const id = s.id as number;
      const positions: PositionRow[] = FIXTURE.positions!.filter((p) => p.snapshot_id === id).map((p) => ({
        memberId: `${p.platform}:${p.member_id}`,
        crowd: p.crowd as "copy" | "fade",
        symbol: p.symbol as string,
        signedNotional: p.signed_notional as number,
      }));
      const recomputed = computeLeans(positions, rules).map((l) => ({
        symbol: l.symbol,
        long_copy: l.copy.long,
        short_copy: l.copy.short,
        lean_copy: l.copy.lean,
        n_copy: l.copy.n,
        long_fade: l.fade.long,
        short_fade: l.fade.short,
        lean_fade: l.fade.lean,
        n_fade: l.fade.n,
        gap: l.gap,
        tradable: l.tradable ? 1 : 0,
        reason: l.reason,
      }));
      const stored = FIXTURE.leans!.filter((l) => l.snapshot_id === id).map((l) => Object.fromEntries(leanCols.map((c) => [c, l[c]])));
      expect(JSON.stringify(recomputed), `snapshot ${id}`).toBe(JSON.stringify(stored));
    }
  });

  it("rebuilding the records from the stored inputs gives the stored paper record byte for byte", () => {
    const db = fixtureDb();
    rebuildRecords(db, rules, RECORD_START, "mainnet");
    const rebuilt = db.prepare("SELECT * FROM paper ORDER BY snapshot_id").all();
    expect(rebuilt).toHaveLength(FIXTURE.paper!.length);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(FIXTURE.paper));
  });

  it("targets are stored at every rebalance and rebuild identically", () => {
    const a = fixtureDb();
    const b = fixtureDb();
    rebuildRecords(a, rules, RECORD_START, "mainnet");
    rebuildRecords(b, rules, RECORD_START, "mainnet");
    const q = "SELECT * FROM targets ORDER BY snapshot_id, symbol";
    const ta = a.prepare(q).all() as Array<{ snapshot_id: number; target_usd: number }>;
    expect(ta.length).toBeGreaterThan(0);
    // Rebalances every 15 minutes: the hour of snapshots 4–15 holds at least four.
    expect(new Set(ta.map((t) => t.snapshot_id)).size).toBeGreaterThanOrEqual(4);
    // No target above the per-market cap of the model account's equity.
    for (const t of ta) expect(Math.abs(t.target_usd)).toBeLessThanOrEqual(rules.per_market_cap * 10_500);
    expect(JSON.stringify(b.prepare(q).all())).toBe(JSON.stringify(ta));
  });
});
