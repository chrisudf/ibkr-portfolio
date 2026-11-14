#!/usr/bin/env bash
# Read-only pull of the live account files from the droplet into uploads/.
# Only runs `cat` inside the app container; never touches IBKR Flex quota.
# See scripts/README.md section 2 for why this beats pressing "刷新 IBKR" locally.
set -euo pipefail

HOST="${DROPLET_HOST:-root@167.71.193.42}"   # no 'deploy' user exists on the droplet
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/uploads"
BACKUP="$DEST/.backup-before-pull"
FILES=(U17456181.json U17456181.snapshots.jsonl
       U22846783.json U22846783.snapshots.jsonl
       .position_settings.json .risk_settings.json)

mkdir -p "$BACKUP"
for f in "${FILES[@]}"; do
  tmp="$(mktemp)"
  if ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
       "cd /opt/ibkr-portfolio/deploy && docker compose exec -T app cat /app/uploads/$f" > "$tmp" \
     && [ -s "$tmp" ]; then
    [ -f "$DEST/$f" ] && cp -p "$DEST/$f" "$BACKUP/$f"
    mv "$tmp" "$DEST/$f"
    echo "ok   $f ($(wc -c < "$DEST/$f") bytes)"
  else
    rm -f "$tmp"
    echo "skip $f (not found or ssh failed; local copy kept)"
  fi
done
