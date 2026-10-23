# Running TUG

TUG runs on one server under systemd, as the `tug` user. State (the database, kill files, logs) lives in
`/home/tug/tug-private/`, never in the code checkout.

## Services

| Service | What it does |
|---|---|
| `tug@mainnet` | Recorder (Strike's scores every 6 h, positions every 5 min), records, public API on 127.0.0.1:8790 |
| `tug-trader@mainnet` | TUG's live Strike account |
| `tug-trader@testnet` | TUG's testnet account |
| `tug-trader@vault` | TUG's Strike vault on testnet |
| `tug-connect` | Accounts people connected on /join, testnet |
| `tug-connect-mainnet` | Accounts people connected on /join, mainnet (runs only with `TUG_CONNECT_MAINNET=on`) |
| `tug-evidence.timer` | Writes the evidence bundle and pushes it to tug-evidence at 20 past every hour |

nginx serves the site and forwards `/api/` to the API.

## Stopping trading

Every switch cancels resting orders within about 10 seconds and blocks new ones until it is cleared. Positions are
kept; the drawdown stop is the only automatic close.

| To stop | Do this (as `tug`) | To undo |
|---|---|---|
| TUG's live account, at once | `curl -X POST http://127.0.0.1:8793/admin/pause` | `rm /home/tug/tug-private/data/KILL-mainnet` |
| TUG's live account, by hand | `cd ~/tug && set -a && . ~/tug-private/env/mainnet.env && pnpm kill "reason"` | `pnpm kill --clear` |
| The testnet account / the vault | `curl -X POST http://127.0.0.1:8792/admin/pause` / `…:8794/admin/pause` | `rm …/data/KILL-testnet` / `…/KILL-vault` |
| Every connected mainnet account | `touch /home/tug/tug-private/data/KILL-connect-mainnet` | `rm /home/tug/tug-private/data/KILL-connect-mainnet` |
| Every connected testnet account | `touch /home/tug/tug-private/data/KILL-connect` | `rm /home/tug/tug-private/data/KILL-connect` |
| New mainnet connections | set `TUG_CONNECT_MAINNET=off` in `env/mainnet.env` and `env/connect-mainnet.env`, restart `tug@mainnet`, stop `tug-connect-mainnet` | set it back to `on` |

A connected person can always press Stop on /join themselves: TUG cancels its orders on their account, closes its
positions if they ask, and deletes its copy of their key once nothing is left open.

## After the drawdown stop

If an account falls 25% below the money put in, TUG closes its positions and writes `data/PAUSED-<network>`. It stays
paused until the owner removes that file.

## Deploying

`bash deploy/sync.sh` from a clean, pushed checkout: it installs, type-checks and tests on the server, waits until the
recorder is between snapshots, restarts the services and publishes the site.

## Checking

- `https://tug.38-49-216-59.sslip.io/status`: heartbeats, snapshots, orders and errors.
- `pnpm verify`: the evidence, recomputed and compared, and TUG's fills against Strike's.
- Logs: `/home/tug/tug-private/logs/`.
