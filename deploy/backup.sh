#!/usr/bin/env bash
# Snapshot the production SQLite database.
#
#   ./deploy/backup.sh [destination-dir]     # defaults to ./backups
#
# Uses sqlite3's .backup, which takes a consistent snapshot while the app is
# still writing. Copying the file with `cp` is NOT safe: it can capture a
# half-written page and produce a corrupt restore.
#
# Schedule it from the host crontab, e.g. daily at 03:15:
#   15 3 * * * cd /srv/shopify-app && ./deploy/backup.sh >> /var/log/shopify-app-backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

DEST=${1:-./backups}
KEEP=${KEEP:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/prod-$STAMP.sqlite"

mkdir -p "$DEST"

docker compose exec -T app sqlite3 /data/prod.sqlite ".backup '/data/.backup-tmp.sqlite'"
docker compose exec -T app cat /data/.backup-tmp.sqlite > "$OUT"
docker compose exec -T app rm -f /data/.backup-tmp.sqlite

gzip -f "$OUT"
echo "Wrote $OUT.gz"

# Retain the most recent $KEEP snapshots.
ls -1t "$DEST"/prod-*.sqlite.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
