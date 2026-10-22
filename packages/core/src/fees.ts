import { MAKER_FEE, TAKER_FEE, type PaperPoint, type SnapshotInput } from "./records.js";

/** One crowd version's copy picks: how many, and each member's account value (USD), keyed `${platform}:${id}`. */
export interface CopyCrowd {
  copyCount: number;
  accountValue: Record<string, number>;
}

export interface FeesSaved {
  fromTs: number;
  toTs: number;
  capital: number;
  baseline: {
    /** Strike copy subscriptions the baseline needs: one per copy pick (Strike's own rule). */
    subscriptions: number;
    perSubscriptionUsd: number;
    turnover: number;
    fees: number;
    orders: number;
  };
  tug: { turnover: number; fees: number };
  /** Baseline fees minus TUG's (TUG's fees are negative when the maker rebate is earned). */
  saved: number;
}

/**
 * Fees saved (§9.6.5), a lower bound: the baseline copies every copy pick one by one on `capital`, split
 * equally, each at a fixed ratio (share / the trader's account value), mirroring every position change
 * seen between snapshots as a market order at the taker fee. Only members in the crowd at both ends of a
 * step count, so joins and leaves add no cost. Snapshot changes undercount real fills, so the real
 * baseline costs more. TUG is the paper record's turnover at the maker fee.
 */
export function feesSaved(snaps: SnapshotInput[], crowds: Record<number, CopyCrowd>, paper: PaperPoint[], capital = 10_000): FeesSaved | undefined {
  if (snaps.length < 2 || paper.length === 0) return undefined;
  let turnover = 0;
  let orders = 0;
  let subscriptions = 0;
  for (let i = 0; i + 1 < snaps.length; i++) {
    const a = snaps[i]!;
    const b = snaps[i + 1]!;
    const ca = crowds[a.crowdVersion ?? -1];
    const cb = crowds[b.crowdVersion ?? -1];
    if (!ca || !cb || cb.copyCount === 0) continue;
    subscriptions = Math.max(subscriptions, cb.copyCount);
    const share = capital / cb.copyCount;
    const before = new Map<string, number>();
    const after = new Map<string, number>();
    for (const p of a.members) if (p.crowd === "copy") before.set(`${p.member}|${p.symbol}`, p.notional);
    for (const p of b.members) if (p.crowd === "copy") after.set(`${p.member}|${p.symbol}`, p.notional);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const member = key.slice(0, key.lastIndexOf("|"));
      const av = cb.accountValue[member];
      if (!(member in ca.accountValue) || !av || av <= 0) continue;
      const change = Math.abs((after.get(key) ?? 0) - (before.get(key) ?? 0));
      if (change === 0) continue;
      turnover += change * (share / av);
      orders++;
    }
  }
  const last = paper[paper.length - 1]!;
  const baselineFees = turnover * TAKER_FEE;
  const tugFees = last.turnover * MAKER_FEE;
  return {
    fromTs: snaps[0]!.ts,
    toTs: snaps[snaps.length - 1]!.ts,
    capital,
    baseline: { subscriptions, perSubscriptionUsd: subscriptions ? capital / subscriptions : 0, turnover, fees: baselineFees, orders },
    tug: { turnover: last.turnover, fees: tugFees },
    saved: baselineFees - tugFees,
  };
}
