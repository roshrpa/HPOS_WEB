#!/bin/sh
# Bring the materials back to what one device (your laptop) had before the bad overwrite.
# Run from the server folder (where docker-compose.yml is):
#   cd /opt/hpos/server && git pull && sh scripts/restore-materials.sh
# Optional: sh scripts/restore-materials.sh "DEVICE NAME" "2026-11-23 11:59 +04"
# It only ADDS new "material saved / deleted" events. Sales, bills, cash and the rest are not touched.
DEV="${1:-Web POS 7fad}"
UNTIL="${2:-2026-11-23 11:59 +04}"
PSQL="${PSQL:-docker compose exec -T db psql -U hpos -d hpos -v ON_ERROR_STOP=1}"
q() { printf %s "$1" | sed "s/'/''/g"; }
D="$(q "$DEV")"; U="$(q "$UNTIL")"
LOG="restore-materials-$(date +%F-%H%M).log"
run() { echo "$1" | $PSQL -At 2>&1; }
{
echo "== restore materials: device '$DEV', changes before '$UNTIL'"
echo "-- 1. backup"
sh scripts/backup.sh || { echo "BACKUP FAILED, stopping"; exit 1; }
echo "-- 2. does the device exist?"
N=$(run "select count(*) from devices where name = '$D'")
echo "devices named '$DEV': $N"
[ "$N" = "1" ] || { echo "STOP: expected exactly 1 device with that name. Names that look similar:"; run "select name from devices where name ilike '%$(q "$(echo "$DEV" | awk '{print $NF}')")%'"; exit 1; }
echo "-- 3. material events from that device before the time"
run "select count(*) || ' events, ' || count(distinct e.payload->>'id') || ' different materials' from events e join devices d on d.id = e.device_id where d.name = '$D' and e.received_at < '$U'::timestamptz and e.type in ('rec','recdel') and e.payload->>'c' = 'inv.materials'"
echo "-- 4. restore"
run "
begin;
with src as (
  select distinct on (e.payload->>'id') e.type, e.payload
  from events e join devices d on d.id = e.device_id
  where d.name = '$D' and e.received_at < '$U'::timestamptz
    and e.type in ('rec','recdel') and e.payload->>'c' = 'inv.materials'
  order by e.payload->>'id', e.seq desc
), ins as (
  insert into events(id, device_id, type, payload, client_time)
  select gen_random_uuid(), t.id, s.type,
         jsonb_set(s.payload, '{u}', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint)), now()
  from src s cross join (select id from devices where active) t
  returning 1
)
select 'events added: ' || count(*) from ins;
commit;"
echo "-- done. Wait 1-2 minutes, then check the materials in the shop app."
} 2>&1 | tee "$LOG"
echo "Log saved in $LOG. If anything failed, send me the text above."
