#!/usr/bin/env bash
# Copy the committed tree to the server, record the commit, install, test, restart.
set -euo pipefail
HOST=${TUG_HOST:-root@38.49.216.59}
KEY=${TUG_KEY:-$HOME/.ssh/zec_vps}
cd "$(git rev-parse --show-toplevel)"
test -z "$(git status --porcelain)" || { echo "commit first"; exit 1; }
rev=$(git rev-parse --short HEAD)
# Restart only in the quiet part of the 5-minute cycle (snapshots run from :00 to about :02).
while :; do sec=$(( $(date -u +%s) % 300 )); [ "$sec" -ge 170 ] && [ "$sec" -le 270 ] && break; sleep 5; done
tmp=$(mktemp -d); git archive HEAD | tar -x -C "$tmp"; echo "$rev" > "$tmp/REVISION"
rsync -az --delete --exclude node_modules --exclude data -e "ssh -i $KEY -o BatchMode=yes" "$tmp/" "$HOST:/home/tug/tug/"
rm -rf "$tmp"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "chown -R tug:tug /home/tug/tug && sudo -u tug -H bash -lc 'set -o pipefail; cd ~/tug && nice -n 10 pnpm install --frozen-lockfile >/dev/null && pnpm typecheck && pnpm test 2>&1 | tail -4' && systemctl restart tug@mainnet && sleep 3 && systemctl is-active tug@mainnet"
echo "deployed $rev"
