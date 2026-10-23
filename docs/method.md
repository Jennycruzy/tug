# How TUG works, number by number

Every number below comes from [`rules/tug-rules-v1.json`](../rules/tug-rules-v1.json), fixed before the record
started on 22 Oct 2026 at 11:55 UTC (SHA-256 `7848d207…edcd6`). The code that applies each step is named so you
can read it.

## 1. Who is in each group (every 6 hours)

From Strike's trader discovery (`/v2/copy/discover`), on Strike and on Hyperliquid:

- **Copy picks:** traders Strike tags "copy", with a copy score of 65 or more, at least $1,000 in their account,
  not market makers or inactive accounts. The 300 with the highest scores.
- **Fade picks:** traders Strike tags "counter" (Strike's own label for traders worth betting against), with the
  same account and style filters: the 400 with the worst 30-day results. A trader on both lists counts only as a
  copy pick.

Code: `apps/engine/src/crowds.ts`. Each list is fixed until the next refresh, and its hash is stored.

## 2. Which way each group leans (every 5 minutes)

TUG reads every member's open positions: Strike accounts from Strike's public positions, Hyperliquid wallets from
Hyperliquid's public account state. Coins are matched to Strike's markets with Strike's own coin mapping.

For each market and each group, it adds up the long and short dollar size (any one trader counts for at most $1M)
and works out the lean:

> lean = (long − short) / (long + short), from −1 (everyone short) to +1 (everyone long)

Code: `packages/core/src/leans.ts`.

## 3. When TUG takes a side

- **Both groups hold the market** (at least 5 copy picks and 3 fade picks) and they lean opposite ways: the gap
  is half the difference of the two leans. TUG trades it if the gap is at least 0.3.
- **Only the copy picks hold enough** (10 or more, too few fade picks): TUG follows them if their lean is at least
  0.6 either way.
- **Only the fade picks hold enough** (10 or more): TUG takes the other side if their lean is at least 0.6.

In every case TUG ends up on the copy picks' side, or against the fade picks. Code: `packages/core/src/leans.ts`.

## 4. How much (every 15 minutes)

- Each market's share is its gap divided by the sum of all gaps.
- Total size is at most 2× the account's equity, and no market more than 0.5× equity.
- Markets below Strike's minimum order are dropped and the rest scaled up once.
- Sizes round down to the market's step, prices to its tick. A change smaller than 20% of the target is skipped.

Code: `packages/core/src/records.ts` (`computeTargets`), `packages/core/src/sizing.ts`.

## 5. How it trades

- One order per market at the best bid (to buy) or best ask (to sell), sent as **post-only**: it can only wait in
  the book, never take. If Strike says it would take, TUG moves it one tick away.
- Every 60 seconds an order that is no longer at the best price is replaced.
- Leverage is set to 5× (cross margin) before the first order on a market, and read back.
- Every order is confirmed by Strike's live account stream or a read within 30 seconds.

Code: `apps/engine/src/executor.ts`, `apps/engine/src/trader.ts`.

## 6. When it stops

- **Equity 25% below what was put in:** cancel everything, close every position (the only orders that take), and
  pause until the owner says go.
- **Margin use above 60%:** halve the largest position.
- **Data older than 15 minutes** (or Strike prices older than 2 minutes): cancel waiting orders, hold positions.
- **Kill switch:** stops new orders and cancels within seconds.

Code: `packages/core/src/risk.ts`.

## 7. The records, and what each label means

- **LIVE:** TUG's real Strike account. Equity each minute, every fill with its fee and Strike order id, and money
  put in taken from Strike's own deposit records, so a top-up never shows as a gain.
- **TESTNET:** TUG's Strike vault and connected accounts, on test money.
- **MODEL:** a $10,000 account that follows the targets exactly at each rebalance, filled at Strike's mid price
  with the maker rebate and charged Strike's funding. It shows the strategy across every market at once, which a
  small live account cannot hold. It is a calculation from real prices, not trades.
- **Scoreboard:** how each group's own Strike-market positions did between snapshots, valued at Strike's prices.
- **Fees saved:** what copying every copy pick one by one with $10,000 would cost (a market order at Strike's taker
  fee for every position change seen), against the model account's rebates. Snapshots every five minutes miss
  some real trades, so the one-by-one cost is a lower bound.
- **Depth added:** each minute a TUG order waits on Strike's book, its share of the size at the best price and in
  the top five price levels.

Code: `packages/core/src/records.ts`, `packages/core/src/fees.ts`, `packages/core/src/depth.ts`. Every record is
recomputed from the stored inputs and checked by `pnpm verify` ([docs/proof.md](proof.md)).

## 8. Testnet

Strike's testnet has a usable book only on ETH-USD, so the vault and connected accounts trade ETH-USD with the
same targets, labelled TESTNET.
