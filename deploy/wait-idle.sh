#!/usr/bin/env bash
# Waits until the engine is idle so a restart never cuts a cycle: no cycle running (crowd refresh or
# snapshot), no snapshot row marked RUNNING, and at least 40 s before the next 5-minute slot.
# Reads the database path from the engine's env file, as the engine itself does.
set -euo pipefail
cd "$(dirname "$0")/.."
NET=${TUG_NETWORK:-mainnet}
ENV_FILE=${TUG_ENV_FILE:-$HOME/tug-private/env/$NET.env}
DB=$(sed -n 's/^TUG_DB=//p' "$ENV_FILE" | tail -1)
test -n "$DB" && test -f "$DB" || { echo "no database found from $ENV_FILE" >&2; exit 1; }
BUSY="$(dirname "$DB")/BUSY-$NET"
for _ in $(seq 1 120); do
  sec=$(( $(date -u +%s) % 300 ))
  if [ ! -e "$BUSY" ] && [ "$sec" -le 260 ] && (cd apps/engine && TUG_DB="$DB" node -e '
    const db = new (require("better-sqlite3"))(process.env.TUG_DB, { readonly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE status = ?").get("RUNNING").n;
    process.exit(n === 0 ? 0 : 1);'); then
    echo "engine idle at second $sec of the cycle"
    exit 0
  fi
  sleep 5
done
echo "engine stayed busy for 10 minutes; not restarting" >&2
exit 1
