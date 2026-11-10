-- Hollywood POS database (PostgreSQL 14 or newer)
-- Idea: devices (tablets, counter PCs) save every bill on the device first, then push it here as an
-- "event". Events are never edited or deleted, so syncing can be repeated safely. The tables below
-- (sales, sale_lines) are built from the events and are what reports read.

create table if not exists devices (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'tablet',      -- tablet, counter, admin
  token_hash  bytea not null unique,                -- sha256 of the device token (the token itself is never stored)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz
);

create table if not exists events (
  seq          bigserial primary key,               -- order in which the server received it
  id           uuid not null unique,                -- made on the device, so a repeated push is ignored
  device_id    uuid not null references devices(id),
  type         text not null,                       -- sale, sale_cancel, purchase, waste, stock_count, cash_out, day_close ...
  payload      jsonb not null,
  client_time  timestamptz,
  received_at  timestamptz not null default now()
);
create index if not exists events_type_idx on events(type);
create index if not exists events_device_idx on events(device_id, seq);

create table if not exists sales (
  id               uuid primary key,
  device_id        uuid not null references devices(id),
  bill_no          text not null,
  day              date not null,
  sold_at          timestamptz not null,
  pay              text not null check (pay in ('cash','card')),
  subtotal         numeric(12,2) not null,
  discount         numeric(12,2) not null default 0,
  discount_reason  text,
  discount_note    text,
  total            numeric(12,2) not null,
  vat              numeric(12,2) not null default 0,
  vat_rate         numeric(5,2) not null default 0,
  tendered         numeric(12,2) not null default 0,
  status           text not null default 'paid' check (status in ('paid','cancelled')),
  cancel_reason    text,
  cancel_note      text,
  cancelled_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists sales_day_idx on sales(day);

create table if not exists sale_lines (
  sale_id   uuid not null references sales(id) on delete cascade,
  line_no   int  not null,
  category  text not null,
  item      text not null,
  size      text not null default '',
  price     numeric(12,2) not null,
  qty       int  not null check (qty > 0),
  primary key (sale_id, line_no)
);

-- Menu, prices, settings: one row per key, changed with a version number so two people cannot overwrite each other by accident.
create table if not exists config (
  key         text primary key,
  value       jsonb not null,
  version     int  not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references devices(id)
);

-- ---------- functions used by the API ----------

create or replace function register_device(p_name text, p_kind text default 'tablet') returns jsonb
language plpgsql as $$
declare v_token text; v_id uuid;
begin
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into devices(name, kind, token_hash) values (p_name, coalesce(p_kind, 'tablet'), sha256(convert_to(v_token, 'UTF8')))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'name', p_name, 'token', v_token);
end $$;

create or replace function auth_device(p_token text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from devices where token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8')) and active;
  if v_id is not null then update devices set last_seen = now() where id = v_id; end if;
  return v_id;
end $$;

create or replace function apply_sale(p_dev uuid, p jsonb) returns void
language plpgsql as $$
declare v_id uuid := (p->>'id')::uuid; l jsonb; n int := 0; c record;
begin
  insert into sales(id, device_id, bill_no, day, sold_at, pay, subtotal, discount, discount_reason, discount_note, total, vat, vat_rate, tendered)
  values (v_id, p_dev, p->>'no', coalesce((p->>'day')::date, current_date),
          to_timestamp((p->>'t')::double precision / 1000.0), p->>'pay',
          coalesce((p->>'subtotal')::numeric, (p->>'total')::numeric), coalesce((p->>'discount')::numeric, 0),
          nullif(p->>'discReason', ''), nullif(p->>'discNote', ''), (p->>'total')::numeric,
          coalesce((p->>'vat')::numeric, 0), coalesce((p->>'vatRate')::numeric, 0), coalesce((p->>'tendered')::numeric, 0))
  on conflict (id) do nothing;
  if not found then return; end if;
  for l in select * from jsonb_array_elements(p->'lines') loop
    n := n + 1;
    insert into sale_lines(sale_id, line_no, category, item, size, price, qty)
    values (v_id, n, l->>'cat', l->>'name', coalesce(l->>'size', ''), (l->>'price')::numeric, (l->>'qty')::int);
  end loop;
  -- a cancel that reached the server before the sale itself
  select payload, client_time into c from events
   where type = 'sale_cancel' and payload->>'id' = v_id::text order by seq limit 1;
  if found then
    update sales set status = 'cancelled', cancel_reason = c.payload->>'reason', cancel_note = nullif(c.payload->>'note', ''),
           cancelled_at = coalesce(c.client_time, now()) where id = v_id;
  end if;
end $$;

create or replace function apply_cancel(p jsonb, p_time timestamptz) returns void
language plpgsql as $$
begin
  update sales set status = 'cancelled', cancel_reason = p->>'reason', cancel_note = nullif(p->>'note', ''),
         cancelled_at = coalesce(p_time, now())
   where id = (p->>'id')::uuid and status = 'paid';
end $$;

create or replace function sync_push(p_dev uuid, p_events jsonb) returns jsonb
language plpgsql as $$
declare e jsonb; v_new int := 0; v_dup int := 0; v_seq bigint; v_t timestamptz;
begin
  if jsonb_typeof(p_events) <> 'array' then raise exception 'events must be an array'; end if;
  if jsonb_array_length(p_events) > 500 then raise exception 'at most 500 events per push'; end if;
  -- sales first, so a cancel in the same batch finds its sale
  for e in select x from jsonb_array_elements(p_events) x order by (x->>'type' = 'sale') desc loop
    v_t := case when e ? 't' then to_timestamp((e->>'t')::double precision / 1000.0) else null end;
    insert into events(id, device_id, type, payload, client_time)
    values ((e->>'id')::uuid, p_dev, e->>'type', e->'payload', v_t)
    on conflict (id) do nothing;
    if found then
      v_new := v_new + 1;
      if e->>'type' = 'sale' then perform apply_sale(p_dev, e->'payload');
      elsif e->>'type' = 'sale_cancel' then perform apply_cancel(e->'payload', v_t); end if;
    else
      v_dup := v_dup + 1;
    end if;
  end loop;
  select coalesce(max(seq), 0) into v_seq from events;
  return jsonb_build_object('accepted', v_new, 'duplicates', v_dup, 'last_seq', v_seq);
end $$;

create or replace function sync_pull(p_dev uuid, p_after bigint default 0, p_limit int default 500) returns jsonb
language plpgsql as $$
declare v_rows jsonb; v_last bigint;
begin
  select coalesce(jsonb_agg(r order by r.seq), '[]'::jsonb), coalesce(max(r.seq), p_after) into v_rows, v_last
  from (select seq, id, device_id, type, payload, extract(epoch from client_time) * 1000 as t
          from events where seq > p_after and device_id <> p_dev order by seq limit least(greatest(p_limit, 1), 1000)) r;
  return jsonb_build_object('events', v_rows, 'last_seq', v_last);
end $$;

create or replace function config_get(p_key text) returns jsonb
language sql as $$
  select coalesce((select jsonb_build_object('key', key, 'value', value, 'version', version, 'updated_at', updated_at) from config where key = p_key),
                  jsonb_build_object('key', p_key, 'value', null, 'version', 0));
$$;

create or replace function config_put(p_dev uuid, p_key text, p_value jsonb, p_base int) returns jsonb
language plpgsql as $$
declare v_cur int;
begin
  select version into v_cur from config where key = p_key for update;
  if not found then
    if coalesce(p_base, 0) <> 0 then return jsonb_build_object('ok', false, 'current', config_get(p_key)); end if;
    insert into config(key, value, version, updated_by) values (p_key, p_value, 1, p_dev);
    return jsonb_build_object('ok', true, 'version', 1);
  end if;
  if coalesce(p_base, -1) <> v_cur then return jsonb_build_object('ok', false, 'current', config_get(p_key)); end if;
  update config set value = p_value, version = v_cur + 1, updated_at = now(), updated_by = p_dev where key = p_key;
  return jsonb_build_object('ok', true, 'version', v_cur + 1);
end $$;

create or replace function report_day(p_day date) returns jsonb
language sql as $$
  with s as (select * from sales where day = p_day),
  paid as (select * from s where status = 'paid')
  select jsonb_build_object(
    'day', p_day,
    'bills', (select count(*) from paid),
    'gross', coalesce((select sum(subtotal) from paid), 0),
    'discount', coalesce((select sum(discount) from paid), 0),
    'net', coalesce((select sum(total) from paid), 0),
    'vat', coalesce((select sum(vat) from paid), 0),
    'cash', coalesce((select sum(total) from paid where pay = 'cash'), 0),
    'card', coalesce((select sum(total) from paid where pay = 'card'), 0),
    'cancelled', jsonb_build_object('count', (select count(*) from s where status = 'cancelled'),
                                    'amount', coalesce((select sum(total) from s where status = 'cancelled'), 0)),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'qty', q, 'amount', a) order by a desc)
                               from (select l.category, sum(l.qty) q, sum(l.qty * l.price) a
                                       from sale_lines l join paid p on p.id = l.sale_id group by l.category) c), '[]'::jsonb)
  );
$$;
