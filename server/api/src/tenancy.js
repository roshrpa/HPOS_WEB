'use strict';
// Companies and branches. Every device, user, bill, event and setting belongs to one branch, and the server only
// ever reads or writes the branch of the device that is asking. Existing data becomes "Hollywood / Branch 1".
const DEFAULT_COMPANY = { id: 'c_hollywood', name: 'Hollywood' };
const DEFAULT_BRANCH = { id: 'b_hollywood_1', name: 'Branch 1', code: 'hollywood1' };

async function ensureSchema(pool) {
  await pool.query(`
    create table if not exists companies (
      id text primary key, name text not null, active boolean not null default true, created_at timestamptz not null default now());
    create table if not exists branches (
      id text primary key,
      company_id text not null references companies(id),
      name text not null,
      code text not null,                      -- typed once on each device to say which shop it belongs to
      active boolean not null default true,
      max_users int not null default 10,       -- users allowed in this branch (the branch admin counts)
      expires_on date,                         -- licence end; empty = no end
      legacy_default boolean not null default false,  -- devices that do not send a code (old app versions) go here
      created_at timestamptz not null default now());
    create unique index if not exists branches_code_ci on branches (lower(code));
    create unique index if not exists branches_one_legacy on branches (legacy_default) where legacy_default;
  `);
  await pool.query(`insert into companies(id, name) values ($1, $2) on conflict (id) do nothing`, [DEFAULT_COMPANY.id, DEFAULT_COMPANY.name]);
  await pool.query(`insert into branches(id, company_id, name, code, legacy_default) values ($1, $2, $3, $4, true) on conflict (id) do nothing`,
    [DEFAULT_BRANCH.id, DEFAULT_COMPANY.id, DEFAULT_BRANCH.name, DEFAULT_BRANCH.code]);
  const B = DEFAULT_BRANCH.id;
  await pool.query(`
    alter table users   add column if not exists branch_id text references branches(id);
    alter table devices add column if not exists branch_id text references branches(id);
    alter table events  add column if not exists branch_id text references branches(id);
    alter table sales   add column if not exists branch_id text references branches(id);
    alter table config  add column if not exists branch_id text references branches(id);
  `);
  for (const t of ['users', 'devices', 'events', 'sales', 'config']) await pool.query(`update ${t} set branch_id = $1 where branch_id is null`, [B]);
  await pool.query(`
    do $m$ begin
      if exists (select 1 from pg_constraint where conrelid = 'config'::regclass and contype = 'p' and conname = 'config_pkey') then
        alter table config drop constraint config_pkey;
      end if;
    end $m$;
    create unique index if not exists config_branch_key on config (branch_id, key);
    drop index if exists users_name_ci;
    create unique index if not exists users_branch_name_ci on users (branch_id, lower(name));
    create index if not exists events_branch_seq on events (branch_id, seq);
    create index if not exists sales_branch_day on sales (branch_id, day);
    alter table users   alter column branch_id set not null;
    alter table events  alter column branch_id set not null;
    alter table sales   alter column branch_id set not null;
    alter table config  alter column branch_id set not null;
  `);
  // A new device, event or bill takes the branch of the device that made it (so the old SQL functions need no change).
  await pool.query(`
    create or replace function branch_from_device() returns trigger language plpgsql as $f$
    begin
      if new.branch_id is null then new.branch_id := (select branch_id from devices where id = new.device_id); end if;
      return new;
    end $f$;
    drop trigger if exists events_branch on events;
    create trigger events_branch before insert on events for each row execute function branch_from_device();
    drop trigger if exists sales_branch on sales;
    create trigger sales_branch before insert on sales for each row execute function branch_from_device();
    create or replace function devices_default_branch() returns trigger language plpgsql as $f$
    begin
      if new.branch_id is null then new.branch_id := (select id from branches where legacy_default limit 1); end if;
      return new;
    end $f$;
    drop trigger if exists devices_branch on devices;
    create trigger devices_branch before insert on devices for each row execute function devices_default_branch();
    alter table devices alter column branch_id set not null;

    create or replace function sync_pull_b(p_dev uuid, p_after bigint default 0, p_limit int default 500) returns jsonb
    language plpgsql as $f$
    declare v_rows jsonb; v_last bigint; v_b text := (select branch_id from devices where id = p_dev);
    begin
      select coalesce(jsonb_agg(r order by r.seq), '[]'::jsonb), coalesce(max(r.seq), p_after) into v_rows, v_last
        from (select seq, id, device_id, type, payload, extract(epoch from client_time) * 1000 as t
                from events where branch_id = v_b and seq > p_after and device_id <> p_dev order by seq limit least(greatest(p_limit, 1), 1000)) r;
      return jsonb_build_object('events', v_rows, 'last_seq', v_last);
    end $f$;

    create or replace function config_get_b(p_branch text, p_key text) returns jsonb language sql as $f$
      select coalesce((select jsonb_build_object('key', key, 'value', value, 'version', version, 'updated_at', updated_at) from config where branch_id = p_branch and key = p_key),
                      jsonb_build_object('key', p_key, 'value', null, 'version', 0));
    $f$;
    create or replace function config_put_b(p_dev uuid, p_branch text, p_key text, p_value jsonb, p_base int) returns jsonb
    language plpgsql as $f$
    declare v_cur int;
    begin
      select version into v_cur from config where branch_id = p_branch and key = p_key for update;
      if not found then
        if coalesce(p_base, 0) <> 0 then return jsonb_build_object('ok', false, 'current', config_get_b(p_branch, p_key)); end if;
        insert into config(branch_id, key, value, version, updated_by) values (p_branch, p_key, p_value, 1, p_dev);
        return jsonb_build_object('ok', true, 'version', 1);
      end if;
      if coalesce(p_base, -1) <> v_cur then return jsonb_build_object('ok', false, 'current', config_get_b(p_branch, p_key)); end if;
      update config set value = p_value, version = v_cur + 1, updated_at = now(), updated_by = p_dev where branch_id = p_branch and key = p_key;
      return jsonb_build_object('ok', true, 'version', v_cur + 1);
    end $f$;

    create or replace function report_day_b(p_branch text, p_day date) returns jsonb language sql as $f$
      with s as (select * from sales where branch_id = p_branch and day = p_day), paid as (select * from s where status = 'paid')
      select jsonb_build_object('day', p_day, 'bills', (select count(*) from paid), 'net', coalesce((select sum(total) from paid), 0),
        'cash', coalesce((select sum(total) from paid where pay = 'cash'), 0), 'card', coalesce((select sum(total) from paid where pay = 'card'), 0),
        'credit', coalesce((select sum(total) from paid where pay = 'credit'), 0),
        'cancelled', jsonb_build_object('count', (select count(*) from s where status = 'cancelled')));
    $f$;
  `);
}

// The branch a signed-in device belongs to (null when the device is unknown).
async function branchOfDevice(pool, devId) {
  const r = await pool.query('select b.* from devices d join branches b on b.id = d.branch_id where d.id = $1', [devId]);
  return r.rows[0] || null;
}
// Find the branch a login is for: the shop code the app sends, or (old apps without a code) the legacy default branch.
async function branchByCode(pool, code) {
  code = String(code || '').trim();
  const r = code
    ? await pool.query('select b.*, c.name as company_name from branches b join companies c on c.id = b.company_id where lower(b.code) = lower($1)', [code])
    : await pool.query('select b.*, c.name as company_name from branches b join companies c on c.id = b.company_id where b.legacy_default');
  return r.rows[0] || null;
}
const LICENCE_MSG = 'Licence expired. Contact your system provider to renew.';
// The licence runs to the end of its last day (UAE time). Returns days left (0 = last day) or null for no end date.
function licenceDays(b) {
  if (!b.expires_on) return null;
  const exp = new Date(b.expires_on).toISOString().slice(0, 10), now = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  return Math.round((Date.parse(exp) - Date.parse(now)) / 86400000);
}
function licenceExpired(b) { const d = licenceDays(b); return d !== null && d < 0; }
function publicBranch(b) {
  return { days_left: licenceDays(b), expired: licenceExpired(b), id: b.id, code: b.code, name: b.name, company: b.company_name || '', expires_on: b.expires_on ? new Date(b.expires_on).toISOString().slice(0, 10) : null, max_users: b.max_users };
}
module.exports = { ensureSchema, branchOfDevice, branchByCode, publicBranch, licenceExpired, LICENCE_MSG };
