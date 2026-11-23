-- Bring the materials back to what ONE device had (for example your laptop) at a chosen time.
-- It adds new "saved / deleted" events that are newer than everything else, so every device takes them.
-- Nothing is deleted from the event log. Run materials_check.sql first to see the device name and time.
--
--   docker compose exec -T db psql -U hpos hpos -v dev="'LAPTOP NAME'" -v until="'2026-11-22 23:59 +04'" < db/materials_recover.sql
--
-- dev   = the device name that had the right materials (as shown by materials_check.sql)
-- until = only that device's changes made BEFORE this time are used
\set ON_ERROR_STOP on
begin;
with src as (
  select distinct on (e.payload->>'id') e.type, e.payload
  from events e join devices d on d.id = e.device_id
  where d.name = :dev and e.received_at < (:until)::timestamptz
    and e.type in ('rec', 'recdel') and e.payload->>'c' = 'inv.materials'
  order by e.payload->>'id', e.seq desc
), ins as (
  insert into events(id, device_id, type, payload, client_time)
  select gen_random_uuid(), t.id, s.type,
         jsonb_set(s.payload, '{u}', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint)), now()
  from src s cross join (select id from devices where active) t
  returning 1
)
select count(*) as events_added from ins;
commit;
