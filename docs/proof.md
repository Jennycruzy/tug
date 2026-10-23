# Proof

Every number TUG shows is computed from recorded data with the code in this repository. This page lists what TUG
promises and where each promise is kept, every Strike capability TUG uses with a live link, and how to check it all
yourself.

## Check it yourself

In a browser: open [/check](https://tug.38-49-216-59.sslip.io/check) and press "Run the check". On your machine,
with no key:

```
git clone https://github.com/Jennycruzy/tug && cd tug
pnpm i --frozen-lockfile
pnpm verify
```

Both run the same code (`packages/core/src/verify.ts`):

1. **hashes**: every file of the evidence bundle against `MANIFEST.sha256`.
2. **rules**: the bundle's rules file against the fingerprint published before the record started.
3. **paper record, scoreboard, fees saved**: recomputed from the recorded snapshots with the engine's own
   functions, then compared with the engine's numbers in `records.json`.
4. **fills, depth added**: recomputed from the recorded fills and book samples.
5. **Strike re-read**: each live fill compared with Strike's public fill history for TUG's account.

One changed byte fails step 1. A changed number with a re-made manifest still fails step 3 (tests T-VERIFY-1..3).

The evidence bundle is the [tug-evidence](https://github.com/Jennycruzy/tug-evidence) repository, written every
hour by `apps/engine/src/evidence.ts`: recorded inputs per UTC day (snapshots with their marks, leans and crowd
positions; fills; equity; depth samples; the testnet vault), the crowd lists, and the engine's records. Strike
traders appear under a salted pseudonym, the same everywhere, so every record still recomputes but no Strike
account is listed.

## Copied on Strike

TUG's live account is a lead trader in Strike's own copy trading. The first copied trade, on 23 Oct 2026:

| | Account | Strike fill id | Trade | Fee |
|---|---|---|---|---|
| TUG | `01a166…50aa` (tug-mainnet) | 4525254 | maker buy 0.18 CRCL-USD at 86.539, 12:17:18 UTC | −0.00078 (rebate) |
| The copier | `01a167…856d` | 4525255 | buy 0.11 CRCL-USD at 86.524, 0.1 s later, `client_order_id` `copy:01a167e8-…:4525254` | 0.00476 |

Strike sized the copy to the copier's $20 against TUG's equity, and its `client_order_id` names TUG's fill. Check it:
`curl "https://api.strikefinance.org/v2/history/fill?account_id=01a16637-81cb-7682-b614-4728271550aa&limit=20"` and
`curl "https://api.strikefinance.org/v2/copy/orders?account_id=01a167e0-4c48-7bec-9fdf-1818a5d9856d"`.

## What TUG promises, and where it is kept

| Promise | Kept in | Test |
|---|---|---|
| Trades only under a rules file whose fingerprint was published first | `packages/core/src/rules.ts` (`assertPublished`), checked at start in `apps/engine/src/trader-main.ts` | T-RULES-1..3 |
| Every order waits in the book (post-only); only labelled risk exits take | `apps/engine/src/executor.ts` (`placePostOnly`, `riskExit`) | T-EXEC-1..4 |
| Never exceeds the gross or per-market caps | `packages/core/src/records.ts` (`computeTargets`), `packages/core/src/sizing.ts` | T-SIZE-1..6 |
| Closes everything and pauses at a 25% drawdown; restarts only on the owner's go | `packages/core/src/risk.ts` (`riskCheck`), `apps/engine/src/trader.ts` | T-RISK-1..5 |
| Holds and cancels when data is stale | `packages/core/src/risk.ts` | T-STALE-1..2 |
| Every number regenerates from the evidence | `packages/core/src/verify.ts`, `apps/engine/src/evidence.ts` | T-VERIFY-1..3 |
| Strike fade picks are never shown one by one | `apps/engine/src/api.ts`, `apps/web/src/pages/market.tsx` | T-PRIV-1..2 |
| The vault runs on Strike testnet only | `apps/engine/src/config.ts` (`vaultNetworkError`) | vault tests |
| A connected account is never traded past its budget (× the gross cap); mainnet budgets are at most $1,000 | `apps/engine/src/trader.ts` (`withinBudget`), `apps/engine/src/connect.ts` | T-CONN-1..4 |
| Stop keeps the key until no TUG order or position is left, then deletes TUG's copy | `apps/engine/src/connectRunner.ts` (`wind`) | Stop tests |

## Strike capabilities used

| Strike capability | Used for | Code | Live proof |
|---|---|---|---|
| Copy discovery: copy score, copy and counter tags, asset mapping | Building both crowds | `apps/engine/src/crowds.ts` | [/api/v1/crowds](https://tug.38-49-216-59.sslip.io/api/v1/crowds) |
| Public positions of Strike accounts | Strike traders in both crowds | `packages/strike/src/index.ts` (`publicPositions`) | [/m/ETH-USD](https://tug.38-49-216-59.sslip.io/m/ETH-USD) |
| Markets, marks, funding, tick and step, best prices | Sizing, rounding, records | `packages/strike/src/index.ts` (`markets`, `bookTickers`) | [/status](https://tug.38-49-216-59.sslip.io/status) |
| Public order book depth | Depth added | `packages/strike/src/index.ts` (`depth`), `apps/engine/src/trader.ts` (`sampleDepth`) | [/proof](https://tug.38-49-216-59.sslip.io/proof) |
| Signed trading API: post-only orders, cancels, read-back | Maker execution | `packages/strike/src/signed.ts`, `apps/engine/src/executor.ts` | [TUG's fills on Strike](https://api.strikefinance.org/v2/history/fill?account_id=01a16637-81cb-7682-b614-4728271550aa) |
| Maker rebate | Rebates earned | `apps/engine/src/trader.ts` (`syncFills`) | [/record](https://tug.38-49-216-59.sslip.io/record) |
| Leverage and margin mode, read back | Account setup (5x cross) | `apps/engine/src/executor.ts` (`ensureLeverage`) | [/record](https://tug.38-49-216-59.sslip.io/record) |
| User stream | Orders, fills, refusals within milliseconds | `packages/strike/src/userStream.ts` | [/status](https://tug.38-49-216-59.sslip.io/status) |
| Deposit history | Money put in, from Strike's own records | `apps/engine/src/trader.ts` (`syncTransfers`) | [TUG's deposits on Strike](https://api.strikefinance.org/v2/history/transaction?account_id=01a16637-81cb-7682-b614-4728271550aa&type=deposit,withdraw) |
| Copy trading: TUG is a lead trader | One tap to follow TUG | Strike's own copy trading | [TUG on Strike](https://app.strikefinance.org/public-portfolio/@tug-mainnet) |
| Builder codes and builder connect (mainnet code `tug`, 0.01%) | TUG in your account: a person's wallet signs Strike's message, TUG trades their account within their budget, with the builder fee on each order | `apps/engine/src/connect.ts`, `apps/engine/src/connectRunner.ts` | [/join](https://tug.38-49-216-59.sslip.io/join) |
| Vault-leader API (testnet) | TUG as a Strike vault | `apps/engine/src/executor.ts` (`vault_id`), `apps/engine/src/trader.ts` (`syncVault`) | [TUG vault on Strike testnet](https://testnet.strikefinance.org/vaults/d7e255eb-509f-5cd7-8e15-ab95ef639c3f) |
| Public fill history | Check it yourself | `packages/core/src/verify.ts` | [/check](https://tug.38-49-216-59.sslip.io/check) |
