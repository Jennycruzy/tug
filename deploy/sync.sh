#!/usr/bin/env bash
# Copy the committed tree to the server, record the commit, install, test, build the site, wait for an idle engine,
# restart, then publish the site.
set -euo pipefail
HOST=${TUG_HOST:-root@38.49.216.59}
KEY=${TUG_KEY:-$HOME/.ssh/zec_vps}
cd "$(git rev-parse --show-toplevel)"
test -z "$(git status --porcelain)" || { echo "commit first"; exit 1; }
rev=$(git rev-parse --short HEAD)
tmp=$(mktemp -d); git archive HEAD | tar -x -C "$tmp"; echo "$rev" > "$tmp/REVISION"
rsync -az --delete --exclude node_modules --exclude data -e "ssh -i $KEY -o BatchMode=yes" "$tmp/" "$HOST:/home/tug/tug/"
rm -rf "$tmp"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "chown -R tug:tug /home/tug/tug && sudo -u tug -H bash -lc 'set -o pipefail; cd ~/tug && nice -n 10 pnpm install --frozen-lockfile >/dev/null && pnpm typecheck && pnpm test 2>&1 | tail -4 && nice -n 10 pnpm web:build >/dev/null && bash deploy/wait-idle.sh' && systemctl restart tug@mainnet && sleep 3 && systemctl is-active tug@mainnet && install -m 644 /home/tug/tug/deploy/tug-trader@.service /etc/systemd/system/tug-trader@.service && install -m 644 /home/tug/tug/deploy/tug-connect.service /home/tug/tug/deploy/tug-evidence.service /home/tug/tug/deploy/tug-evidence.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl try-restart tug-trader@testnet tug-trader@mainnet tug-trader@vault tug-connect"
# The site: static files nginx can read, then the nginx site itself once its certificate exists.
ssh -i "$KEY" -o BatchMode=yes "$HOST" "set -e; mkdir -p /var/www/tug && rsync -a --delete /home/tug/tug/apps/web/dist/ /var/www/tug/ && chown -R root:root /var/www/tug && chmod -R a+rX /var/www/tug
if [ -f /etc/letsencrypt/live/tug.38-49-216-59.sslip.io/fullchain.pem ]; then
  cp /home/tug/tug/deploy/nginx/tug.conf /etc/nginx/sites-available/tug && ln -sf /etc/nginx/sites-available/tug /etc/nginx/sites-enabled/tug && nginx -t -q && systemctl reload nginx && echo 'site live'
else echo 'site files published; nginx site waits for its certificate'; fi"
echo "deployed $rev"
