#!/bin/sh
# Daily backup of the database. Run from the server folder (where docker-compose.yml is), for example from cron:
#   30 3 * * *  cd /opt/hpos/server && ./scripts/backup.sh
set -e
mkdir -p backups
f="backups/hpos-$(date +%Y-%m-%d).sql.gz"
docker compose exec -T db pg_dump -U hpos hpos | gzip > "$f"
# keep the last 30 backups
ls -1t backups/hpos-*.sql.gz | tail -n +31 | xargs -r rm --
echo "saved $f"
