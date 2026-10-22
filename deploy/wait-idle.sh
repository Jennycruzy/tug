#!/usr/bin/env bash
# Waits until the engine is idle so a restart never cuts a cycle: no cycle running (crowd refresh or
# snapshot), no snapshot row marked RUNNING, and at least 40 s before the next 5-minute slot.
set -euo pipefail
cd "$(dirname "$0")/.."
for _ in $(seq 1 120); do
  sec=$(( $(date -u +%s) % 300 ))
  if [ ! -e data/BUSY-mainnet ] && [ "$sec" -le 260 ] && node -e '
    const db = new (require("better-sqlite3"))("data/tug.db", { readonly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE status = ?").get("RUNNING").n;
    process.exit(n === 0 ? 0 : 1);'; then
    echo "engine idle at second $sec of the cycle"
    exit 0
  fi
  sleep 5
done
echo "engine stayed busy for 10 minutes; not restarting" >&2
exit 1
