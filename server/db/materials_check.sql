-- Who changed the materials, and when? (read only, changes nothing)
-- Run on the server, in the server folder:
--   docker compose exec -T db psql -U hpos hpos < db/materials_check.sql
\echo '--- devices ---'
select name, active, last_seen at time zone 'Asia/Dubai' as last_seen_dubai from devices order by name;
\echo '--- material changes per device and hour (Dubai time) ---'
select d.name as device,
       date_trunc('hour', e.received_at at time zone 'Asia/Dubai') as hour_dubai,
       count(*) filter (where e.type = 'rec')    as saved,
       count(*) filter (where e.type = 'recdel') as deleted
from events e join devices d on d.id = e.device_id
where e.type in ('rec', 'recdel') and e.payload->>'c' = 'inv.materials'
group by 1, 2 order by 2, 1;
