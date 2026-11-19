'use strict';
// Super admin: the person who sells and runs the system. Not part of any company. Creates companies and branches,
// gives each branch its admin, its user limit and its licence end date, and can reset a branch's test data.
const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');
const tenancy = require('./tenancy');

const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();      // token -> {id, name, exp}
let fails = [];                  // timestamps of wrong passwords
const PIN_RE = /^\d{6,}$/;
const CODE_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESET_TYPES = "('sale','sale_cancel','order','order_update','order_pay','order_cancel','order_done','num','wh_move')";

function err(status, message) { return Object.assign(new Error(message), { status }); }
function scryptHash(p) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex'); }
function scryptCheck(p, stored) {
  const parts = String(stored || '').split(':'); if (parts.length !== 2) return false;
  const want = Buffer.from(parts[1], 'hex'), got = crypto.scryptSync(String(p), Buffer.from(parts[0], 'hex'), 32);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function hashPinLocal(p) { const s = 'hp|' + String(p); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36); }

async function ensureSchema(pool) {
  await pool.query(`create table if not exists superadmins (
    id text primary key, name text not null, pass_hash text not null, created_at timestamptz not null default now());
    create unique index if not exists superadmins_name_ci on superadmins (lower(name));`);
}

// Wipe a branch's bills, tablet orders and stock movements and tell every device of that branch to start again (stock 100).
async function resetBranch(pool, branchId, by) {
  let sys = (await pool.query("select id from devices where branch_id = $1 and kind = 'system' limit 1", [branchId])).rows[0];
  if (!sys) {
    const d = (await pool.query("select register_device('System', 'system') as r")).rows[0].r;
    await pool.query('update devices set branch_id = $1, active = false where id = $2', [branchId, d.id]);
    sys = { id: d.id };
  }
  const id = crypto.randomUUID(), c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('delete from events where branch_id = $1 and type in ' + RESET_TYPES, [branchId]);
    await c.query('delete from sales where branch_id = $1', [branchId]);
    await c.query("insert into events(id, device_id, type, payload, client_time) values ($1, $2, 'test_reset', $3::jsonb, now())", [id, sys.id, JSON.stringify({ id: id, by: by, t: Date.now() })]);
    await c.query('commit');
  } catch (e) { await c.query('rollback').catch(function () {}); throw e; } finally { c.release(); }
  return id;
}

function who(req) {
  const t = String(req.headers['x-super-token'] || '');
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); throw err(401, 'Please sign in again.'); }
  return s;
}

async function overview(pool) {
  const co = (await pool.query('select * from companies order by created_at, id')).rows;
  const br = (await pool.query(`select b.*,
      (select count(*)::int from users u where u.branch_id = b.id and u.active) as users,
      (select count(*)::int from users u where u.branch_id = b.id and u.active and u.role = 'Owner') as admins,
      (select count(*)::int from devices d where d.branch_id = b.id and d.kind <> 'system' and d.active) as devices,
      (select max(d.last_seen) from devices d where d.branch_id = b.id and d.kind <> 'system') as last_seen,
      (select count(*)::int from sales s where s.branch_id = b.id) as bills
    from branches b order by b.created_at, b.id`)).rows;
  return { companies: co.map(function (c) { return { id: c.id, name: c.name, active: c.active, branches: br.filter(function (b) { return b.company_id === c.id; }).map(function (b) {
    return { id: b.id, name: b.name, code: b.code, active: b.active, max_users: b.max_users, users: b.users, admins: b.admins, devices: b.devices, bills: b.bills,
      expires_on: b.expires_on ? new Date(b.expires_on).toISOString().slice(0, 10) : null, last_seen: b.last_seen, legacy_default: b.legacy_default };
  }) }; }) };
}

// h: { send, readJson, isAdmin }
async function handle(req, res, path, m, pool, h) {
  if (path === '/super' && m === 'GET') {
    const file = nodePath.join(__dirname, 'super.html');
    const html = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    return res.end(html), true;
  }
  if (!path.startsWith('/super/') && path !== '/admin/super') return false;

  // The person who runs the server makes (or resets) the super admin with the server's admin token.
  if (path === '/admin/super' && m === 'POST') {
    if (!h.isAdmin(req)) throw err(403, 'admin token required');
    const b = await h.readJson(req), name = String(b.name || '').trim(), pass = String(b.password || '');
    if (!name) throw err(400, 'name is required');
    if (pass.length < 10) throw err(400, 'Password must be at least 10 characters.');
    const ex = (await pool.query('select id from superadmins where lower(name) = lower($1)', [name])).rows[0];
    if (ex) await pool.query('update superadmins set pass_hash = $2 where id = $1', [ex.id, scryptHash(pass)]);
    else await pool.query('insert into superadmins(id, name, pass_hash) values ($1, $2, $3)', ['s' + crypto.randomBytes(6).toString('hex'), name, scryptHash(pass)]);
    return h.send(res, 200, { ok: true, name: name, existed: !!ex }), true;
  }

  if (path === '/super/login' && m === 'POST') {
    const now = Date.now(); fails = fails.filter(function (t) { return now - t < 10 * 60 * 1000; });
    if (fails.length >= 10) throw err(429, 'Too many wrong attempts. Wait a few minutes.');
    const b = await h.readJson(req);
    const r = (await pool.query('select * from superadmins where lower(name) = lower($1)', [String(b.name || '').trim()])).rows[0];
    const ok = scryptCheck(b.password || '', r ? r.pass_hash : '00:00') && r;
    if (!ok) { fails.push(now); throw err(401, 'Wrong name or password.'); }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { id: r.id, name: r.name, exp: now + SESSION_MS });
    return h.send(res, 200, { ok: true, token: token, name: r.name }), true;
  }

  const s = who(req);
  if (path === '/super/overview' && m === 'GET') return h.send(res, 200, await overview(pool)), true;
  if (path === '/super/logout' && m === 'POST') { sessions.delete(String(req.headers['x-super-token'] || '')); return h.send(res, 200, { ok: true }), true; }

  if (path === '/super/company' && m === 'POST') {
    const b = await h.readJson(req), name = String(b.name || '').trim();
    if (!name) throw err(400, 'Enter the company name.');
    await pool.query('insert into companies(id, name) values ($1, $2)', ['c_' + crypto.randomBytes(5).toString('hex'), name.slice(0, 80)]);
    return h.send(res, 200, await overview(pool)), true;
  }
  if (path === '/super/branch' && m === 'POST') {
    const b = await h.readJson(req), name = String(b.name || '').trim(), code = String(b.code || '').trim().toLowerCase();
    if (!(await pool.query('select 1 from companies where id = $1', [String(b.company_id || '')])).rowCount) throw err(404, 'Company not found.');
    if (!name) throw err(400, 'Enter the branch name.');
    if (!CODE_RE.test(code)) throw err(400, 'Shop code: 3 to 30 letters, numbers, - or _ (no spaces).');
    const mu = Math.max(1, Math.min(500, parseInt(b.max_users, 10) || 3));
    const exp = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_on || '')) ? b.expires_on : null;
    try { await pool.query('insert into branches(id, company_id, name, code, max_users, expires_on) values ($1,$2,$3,$4,$5,$6)', ['b_' + crypto.randomBytes(5).toString('hex'), b.company_id, name.slice(0, 80), code, mu, exp]); }
    catch (e) { if (e.code === '23505') throw err(409, 'That shop code is already used.'); throw e; }
    return h.send(res, 200, await overview(pool)), true;
  }
  const bm = path.match(/^\/super\/branch\/([a-z0-9_]+)(\/[a-z-]+)?$/);
  if (bm) {
    const br = (await pool.query('select * from branches where id = $1', [bm[1]])).rows[0];
    if (!br) throw err(404, 'Branch not found.');
    const sub = bm[2] || '';
    if (!sub && m === 'POST') {          // edit
      const b = await h.readJson(req), set = [], v = [br.id];
      function add(col, val) { v.push(val); set.push(col + ' = $' + v.length); }
      if (b.name !== undefined) { if (!String(b.name).trim()) throw err(400, 'Enter the branch name.'); add('name', String(b.name).trim().slice(0, 80)); }
      if (b.max_users !== undefined) {
        const mu = Math.max(1, Math.min(500, parseInt(b.max_users, 10) || 1));
        const used = (await pool.query('select count(*)::int n from users where branch_id = $1 and active', [br.id])).rows[0].n;
        if (mu < used) throw err(409, 'This branch already has ' + used + ' active users. Switch some off first.');
        add('max_users', mu);
      }
      if (b.expires_on !== undefined) { if (b.expires_on && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_on))) throw err(400, 'Date must be YYYY-MM-DD.'); add('expires_on', b.expires_on || null); }
      if (b.active !== undefined) add('active', !!b.active);
      if (set.length) await pool.query('update branches set ' + set.join(', ') + ' where id = $1', v);
      return h.send(res, 200, await overview(pool)), true;
    }
    if (sub === '/admin' && m === 'POST') {      // create or reset the branch admin (an Owner)
      const b = await h.readJson(req), name = String(b.name || '').trim();
      if (!name) throw err(400, 'Enter the admin name.');
      if (!PIN_RE.test(String(b.pin || ''))) throw err(400, 'PIN must be 6 digits or more (numbers only).');
      const ex = (await pool.query('select id, active from users where branch_id = $1 and lower(name) = lower($2)', [br.id, name])).rows[0];
      if ((await pool.query('select 1 from users where branch_id = $1 and pin_local = $2 and active and id <> $3', [br.id, hashPinLocal(b.pin), ex ? ex.id : ''])).rowCount) throw err(409, 'That PIN is already used in this branch.');
      const used = (await pool.query('select count(*)::int n from users where branch_id = $1 and active and id <> $2', [br.id, ex ? ex.id : ''])).rows[0].n;
      if (used + 1 > br.max_users) throw err(409, 'The user limit (' + br.max_users + ') is reached. Raise the limit first.');
      if (ex) await pool.query("update users set role = 'Owner', active = true, pin_hash = $2, pin_local = $3, ver = nextval('users_ver_seq') where id = $1", [ex.id, scryptHash(b.pin), hashPinLocal(b.pin)]);
      else await pool.query("insert into users(id, name, role, pin_hash, pin_local, branch_id) values ($1,$2,'Owner',$3,$4,$5)", ['u' + crypto.randomBytes(6).toString('hex'), name, scryptHash(b.pin), hashPinLocal(b.pin), br.id]);
      return h.send(res, 200, await overview(pool)), true;
    }
    if (sub === '/users' && m === 'GET') {
      const r = await pool.query("select id, name, role, active, created_at from users where branch_id = $1 order by active desc, (role = 'Owner') desc, lower(name)", [br.id]);
      return h.send(res, 200, { users: r.rows.map(function (u) { return { id: u.id, name: u.name, role: u.role, active: u.active, created: u.created_at }; }), max_users: br.max_users }), true;
    }
    if (sub === '/user' && m === 'POST') {      // reset a user's PIN and/or switch the user on or off
      const b = await h.readJson(req);
      const u = (await pool.query('select id, name, role, active from users where id = $1 and branch_id = $2', [String(b.user_id || ''), br.id])).rows[0];
      if (!u) throw err(404, 'User not found.');
      if (b.delete) { await require('./users').deleteUser(pool, br.id, u, ''); return h.send(res, 200, await overview(pool)), true; }
      if (b.pin !== undefined && b.pin !== '') {
        if (!PIN_RE.test(String(b.pin))) throw err(400, 'PIN must be 6 digits or more (numbers only).');
        if ((await pool.query('select 1 from users where branch_id = $1 and pin_local = $2 and active and id <> $3', [br.id, hashPinLocal(b.pin), u.id])).rowCount) throw err(409, 'That PIN is already used in this branch.');
        await pool.query("update users set pin_hash = $2, pin_local = $3, ver = nextval('users_ver_seq') where id = $1", [u.id, scryptHash(b.pin), hashPinLocal(b.pin)]);
      }
      if (b.active !== undefined && !!b.active !== u.active) {
        if (b.active) {
          const used = (await pool.query('select count(*)::int n from users where branch_id = $1 and active', [br.id])).rows[0].n;
          if (used + 1 > br.max_users) throw err(409, 'The user limit (' + br.max_users + ') is reached. Raise the limit first.');
        }
        await pool.query("update users set active = $2, ver = nextval('users_ver_seq') where id = $1", [u.id, !!b.active]);
      }
      return h.send(res, 200, await overview(pool)), true;
    }
    if (sub === '/reset-test' && m === 'POST') {
      const b = await h.readJson(req);
      if (String(b.confirm || '').trim().toLowerCase() !== br.code.toLowerCase()) throw err(400, 'Type the shop code to confirm.');
      await resetBranch(pool, br.id, s.name);
      return h.send(res, 200, await overview(pool)), true;
    }
  }
  throw err(404, 'not found');
}
module.exports = { ensureSchema, handle };
