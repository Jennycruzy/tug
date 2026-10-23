/** One minute's sample of a TUG order resting on Strike's book (depth_samples). */
export interface DepthSample {
  ts: number;
  symbol: string;
  side: string;
  tugSize: number;
  atBest: boolean;
  bestTotal: number;
  top5Total: number;
}

export interface DepthMarket {
  symbol: string;
  /** Minutes with a TUG order resting (one sample per minute). */
  minutesResting: number;
  /** Of those, minutes at the best price. */
  minutesAtBest: number;
  /** Average share of the size at the best price that was TUG's, over the minutes at the best price. */
  avgShareOfBest: number;
  /** Average share of the top 5 levels of that side that was TUG's, over all resting minutes. */
  avgShareOfTop5: number;
}

/**
 * Depth added (§9.6.6) from the minute samples: per market, how long TUG's orders rested, how often at the
 * best price, and TUG's average share of the best price and of the top 5 levels. Each sample is one minute, so
 * the averages are time-weighted. A share is capped at 1 (the book read can lag TUG's own order by a moment).
 */
export function depthSummary(samples: DepthSample[]): { markets: DepthMarket[]; minutesResting: number } {
  const by = new Map<string, DepthSample[]>();
  for (const s of samples) by.set(s.symbol, [...(by.get(s.symbol) ?? []), s]);
  const share = (part: number, total: number) => (total > 0 ? Math.min(1, part / total) : 0);
  const markets = [...by.entries()]
    .map(([symbol, xs]) => {
      const best = xs.filter((x) => x.atBest);
      return {
        symbol,
        minutesResting: new Set(xs.map((x) => x.ts)).size,
        minutesAtBest: new Set(best.map((x) => x.ts)).size,
        avgShareOfBest: best.length ? best.reduce((a, x) => a + share(x.tugSize, x.bestTotal), 0) / best.length : 0,
        avgShareOfTop5: xs.reduce((a, x) => a + share(x.tugSize, x.top5Total), 0) / xs.length,
      };
    })
    .sort((a, b) => b.minutesResting - a.minutesResting || (a.symbol < b.symbol ? -1 : 1));
  return { markets, minutesResting: markets.reduce((a, m) => a + m.minutesResting, 0) };
}
