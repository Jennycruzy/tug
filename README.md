# TUG

**Strike already scores which traders to copy and which to fade. TUG trades the gap.**

Strike scores thousands of traders and labels each one worth copying or worth betting against. TUG adds up what
both groups hold in every Strike market, every five minutes. Where they pull in opposite directions, TUG takes
the side of the traders Strike says to copy, with orders that wait in the book. It trades live on Strike with real
money, and anyone can copy it on Strike in one tap.

**[Live site](https://tug.38-49-216-59.sslip.io)** ·
**[Demo video (2:25)](https://github.com/Jennycruzy/tug/releases/download/demo-2026-10-23/TUG-demo.mp4)** ·
**[TUG on Strike](https://app.strikefinance.org/public-portfolio/@tug-mainnet)** ·
**[Check it yourself](https://tug.38-49-216-59.sslip.io/check)** ·
**[API](https://tug.38-49-216-59.sslip.io/api)** ·
**[Evidence](https://github.com/Jennycruzy/tug-evidence)** ·
**[Judge it in 3 minutes](docs/judge.md)**

![TUG's home page: one rope per Strike market, the copy picks pulling one way, the fade picks the other, and TUG's side](docs/img/home.png)

## What is already running

| | |
|---|---|
| **Live on Strike mainnet, real money** | TUG's own account trades Strike's crypto and stock markets. Every fill is on [Strike's public page for the account](https://app.strikefinance.org/public-portfolio/@tug-mainnet). |
| **Copied on Strike** | TUG is a lead trader in Strike's own copy trading. A second wallet copies it: when TUG bought CRCL at 12:17 UTC on 23 Oct, Strike copied the trade into that wallet's account a tenth of a second later ([TUG's fill and the copy](docs/proof.md#copied-on-strike)). |
| **Every fill a maker fill** | 10 of 10 live fills were orders that waited in the book, and each one earned Strike's maker rebate instead of paying a fee. |
| **Cheaper than copying one by one** | Copying all 300 of Strike's copy picks with $10,000 since the record began would have meant 300 subscriptions ($6,000 in minimums) and **$9.37 in taker fees over 8,506 orders**. TUG's model account on the same $10,000 **earned $6.25** in rebates. |
| **Strike's scores, read every 5 minutes** | 300 copy picks and 285 fade picks, on Strike and Hyperliquid, across all 33 Strike markets: 262 complete snapshots since 22 Oct. |
| **The idea, measured before launch** | In the 7 days before TUG started, 71 of 93 of Strike's top copy picks gained and 74 of 100 of its fade picks lost, on Strike-listed markets ([script and data](https://github.com/Jennycruzy/tug-evidence/tree/main/pre-record)). |
| **A Strike vault on testnet** | The same rules trading a [Strike vault](https://testnet.strikefinance.org/vaults/d7e255eb-509f-5cd7-8e15-ab95ef639c3f) with a second account's deposit and a withdrawal in progress. |
| **TUG in your account, on mainnet** | Connect a wallet (Cardano, Ethereum or Solana) and TUG trades your own Strike account with the same rules, within a budget you set (up to $1,000 of real money), through Strike's builder codes. Testnet too, for trying it with test money. |
| **Check every number yourself** | One command or one browser page downloads the evidence, checks every file's fingerprint, recomputes every record and matches each live fill against Strike's own records. |

Figures as of 23 Oct 2026, 09:45 UTC. The live versions are on the [site](https://tug.38-49-216-59.sslip.io/record)
and in the [API](https://tug.38-49-216-59.sslip.io/api/v1/proof).

## Why it matters for Strike

**Strike's order books are thin, and TUG only adds to them.** Every TUG order is a maker order: it waits at the best
bid or ask until someone trades with it, so it adds depth instead of taking it. All 10 of the live account's fills
were filled that way, and every account connected to TUG trades the same way. TUG measures its share of Strike's best price
every minute its orders wait ([Proof](https://tug.38-49-216-59.sslip.io/proof)).

**It turns Strike's own scores into one position per market.** Strike already tells its users which traders to copy
and which to bet against, but betting against a trader is not something Strike's copy trading can do, and copying
many traders one by one runs into $20 minimums, a 40-follower cap per trader and a taker fee on every copied order.
TUG nets both groups into a position anyone can follow with a single copy.

## How it works

1. **Read Strike's scores.** Every six hours TUG takes Strike's copy picks (high copy score) and fade picks
   (Strike's "counter" label) from Strike's own trader discovery, on Strike and on Hyperliquid.
2. **Add up what they hold.** Every five minutes it reads each trader's open positions and works out, market by
   market, which way each group leans and how hard.
3. **Trade the gap.** Where the copy picks lean one way and the fade picks the other, TUG holds the copy picks'
   side, sized by how far apart they are. Orders join the best bid or ask and wait to be filled.

One market, live: Strike's copy picks are 100% short CXMT (the memory-chip maker), and the one fade pick holding
it is long. TUG is short CXMT: it posted a sell at the best ask, the order waited in the book, a buyer took it, and
Strike paid TUG a rebate. The fill is on Strike's public record with its order id, and on the
[Record page](https://tug.38-49-216-59.sslip.io/record).

```
every 6 h    Strike trader discovery ──► copy picks and fade picks
every 5 min  their open positions (Strike and Hyperliquid) ──► which way each group leans, per market
every 15 min targets ──► orders that wait at the best price on Strike ──► fills, rebates
always       Strike's live account stream ──► record; risk guard (stops at a 25% loss)
every hour   evidence ──► github.com/Jennycruzy/tug-evidence
```

## Use it

- **Copy TUG on Strike:** open [TUG's page on Strike](https://app.strikefinance.org/public-portfolio/@tug-mainnet),
  press Copy, choose Fixed Ratio, enter $20 or more.
- **TUG in your account (mainnet or testnet):** on the [Join page](https://tug.38-49-216-59.sslip.io/join), choose
  mainnet or testnet, connect a wallet, set a budget, start. TUG uses the key Strike gives it only to place and cancel
  orders, and charges a 0.01% builder fee. Stop cancels TUG's orders and deletes its copy of the key.
- **The testnet vault:** deposit on [Strike testnet](https://testnet.strikefinance.org/vaults/d7e255eb-509f-5cd7-8e15-ab95ef639c3f)
  and watch the share price.
- **The data:** a free API and a one-line widget for any page. See [docs/integration.md](docs/integration.md).

```html
<script src="https://tug.38-49-216-59.sslip.io/embed.js" data-symbol="all"></script>
```

## Check it yourself in 60 seconds

With Node 22 and pnpm 10 (`nvm use` reads `.nvmrc`):

```
git clone https://github.com/Jennycruzy/tug && cd tug
pnpm i --frozen-lockfile
pnpm verify
```

`pnpm verify` downloads the evidence, checks every file against its SHA-256, recomputes the model account, the
scoreboard, fees saved and depth added with the same code the engine runs, and checks TUG's live fills against
Strike's public history in both directions. One changed byte fails it. The same check runs in the browser at
[/check](https://tug.38-49-216-59.sslip.io/check). Details in [docs/proof.md](docs/proof.md).

## Rules fixed before the record

TUG's rules are one file, [`rules/tug-rules-v1.json`](rules/tug-rules-v1.json), published before the record
started (22 Oct 2026, 11:55 UTC). Its SHA-256 is
`7848d207256e872230594112e2aa1e1af30d45d3331d068c4a082d2c4a1edcd6`, and the engine refuses to trade under any
other file. Nothing in it has been tuned since. How every number is computed: [docs/method.md](docs/method.md).

The site labels every record for what it is: **LIVE** is TUG's real Strike account, **TESTNET** is test money,
and **MODEL** is a $10,000 calculation from real Strike prices that shows the strategy across every market at once.

## Built on Strike

TUG uses Strike's trader discovery and scores, public positions, market data and order books, signed trading API,
maker rebates, the live account stream, leverage settings, copy trading, vaults and builder codes. Each one, with
the code and a live link: [docs/proof.md](docs/proof.md#strike-capabilities-used).

## What we had to solve

- **Orders Strike refuses or fills at once disappear from its order lookup.** On mainnet the lookup answers 404 for
  both. TUG reads the outcome from Strike's live account stream instead, so it never re-sends a filled order.
- **Strike's fill history can leave out the order's own id.** TUG matches fills by Strike's order id.
- **A top-up is not a profit.** Money put in comes from Strike's own deposit records, so the result line stays flat
  when the owner adds funds.
- **During a short Strike outage the account stream connected but never answered.** TUG now gives up after 15
  seconds and reconnects.
- **Proof that holds up.** The evidence records the inputs, not just the results, so anyone can recompute every
  number, and a removed losing trade is caught because Strike's own history must match the bundle.

## Engineering

TypeScript throughout: an engine (Node, SQLite) with a recorder, a trader per account, a risk guard and a public
API; a small Preact site; 132 passing tests and CI on every commit. The engine runs on one server under systemd. Keys are
never in the repository; trading keys for connected accounts are stored encrypted and deleted on Stop.

## Built in public

- TUG on X: [building it](https://x.com/jennyoliver57/status/2113455863729979900) · [what it does](https://x.com/jennyoliver57/status/2113627494540517760)
- The four findings filed with Strike: [strike-finance/strike-finance-skills issues #1–#4](https://github.com/strike-finance/strike-finance-skills/issues)

## Licence and notice

MIT, see [LICENSE](LICENSE). Built on Strike's public API; not affiliated with Strike. Not investment advice.
Perpetual futures can lose all deposited funds.
