'use strict';
// Users and login. Users live on the server; a device signs in with a user name and PIN and the server hands it
// its own device token, so nobody types or sees a token. PINs are stored with scrypt. Each user also has "pin_local",
// the short scrambled PIN the apps use for approvals and offline login on a device (same function as the apps).
const crypto = require('crypto');

const PIN_RE = /^\d{6,}$/;                 // 6 digits or more
const ROLES = ['Owner', 'Manager', 'Cashier'];
const LOCK_AFTER = 5, LOCK_MS = 15 * 60 * 1000;
const fails = {};                          // lower(name) -> {n, until}
let ipFails = [];                          // timestamps of failures from anywhere, to slow down guessing across names

function hashPinLocal(p) { const s = 'hp|' + String(p); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36); }
function scryptHash(pin) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function scryptCheck(pin, stored) {
  const parts = String(stored || '').split(':'); if (parts.length !== 2) return false;
  const want = Buffer.from(parts[1], 'hex'), got = crypto.scryptSync(String(pin), Buffer.from(parts[0], 'hex'), 32);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function err(status, message) { return Object.assign(new Error(message), { status }); }

async function ensureSchema(pool) {
  await pool.query(`
    create sequence if not exists users_ver_seq;
    create table if not exists users (
      id text primary key,
      name text not null,
      role text not null default 'Cashier',
      active boolean not null default true,
      pin_hash text not null,
      pin_local text not null,
      created_at timestamptz not null default now(),
      ver bigint not null default nextval('users_ver_seq')
    );
    create unique index if not exists users_name_ci on users (lower(name));`);
}

function publicUser(r) { return { id: r.id, name: r.name, role: r.role, active: r.active, pin: r.pin_local, t: new Date(r.created_at).getTime() }; }
async function listUsers(pool) {
  const r = await pool.query('select * from users order by created_at, id');
  const ver = r.rows.reduce(function (m, x) { return Math.max(m, Number(x.ver)); }, 0);
  return { ver: ver, users: r.rows.map(publicUser) };
}

function checkLock(name) {
  const now = Date.now(), k = String(name).toLowerCase(), f = fails[k];
  ipFails = ipFails.filter(function (t) { return now - t < 10 * 60 * 1000; });
  if (ipFails.length >= 60) throw err(429, 'Too many wrong attempts. Wait a few minutes.');
  if (f && f.until > now) throw err(429, 'Too many wrong PINs for this user. Try again in ' + Math.ceil((f.until - now) / 60000) + ' minutes.');
}
function noteFail(name) {
  const k = String(name).toLowerCase(), f = fails[k] || { n: 0, until: 0 };
  f.n += 1; if (f.n >= LOCK_AFTER) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails[k] = f; ipFails.push(Date.now());
}
function noteOk(name) { delete fails[String(name).toLowerCase()]; }

async function verify(pool, name, pin) {
  name = String(name || '').trim();
  if (!name || !pin) throw err(400, 'Enter the user name and PIN.');
  checkLock(name);
  const r = await pool.query('select * from users where lower(name) = lower($1)', [name]);
  const u = r.rows[0];
  // always do the hash work so a wrong name takes as long as a wrong PIN
  const ok = scryptCheck(pin, u ? u.pin_hash : '00:00') && u && u.active;
  if (!ok) { noteFail(name); throw err(401, 'Wrong user name or PIN.'); }
  noteOk(name);
  return u;
}

async function pinTaken(pool, pin, exceptId) {
  const r = await pool.query('select 1 from users where pin_local = $1 and active and id <> $2 limit 1', [hashPinLocal(pin), exceptId || '']);
  return r.rowCount > 0;
}
async function ownerCount(pool) { return (await pool.query("select count(*)::int n from users where role = 'Owner' and active")).rows[0].n; }

// h = helpers from server.js: { one, readJson, send, device, registerDevice(name, kind), bearerDevice(req) }
async function handle(req, res, path, m, pool, h) {
  if (path === '/auth/status' && m === 'GET') {
    const n = (await pool.query('select count(*)::int n from users')).rows[0].n;
    return h.send(res, 200, { users: n });
  }

  if (path === '/auth/login' && m === 'POST') {
    const b = await h.readJson(req);
    const u = await verify(pool, b.name, b.pin);
    return finishLogin(res, pool, h, u.name, b);
  }

  // The first Owner (and a forgotten PIN) are handled by the person who runs the server, with the admin token.
  if (path === '/admin/users' && m === 'POST') {
    if (!h.isAdmin(req)) throw err(403, 'admin token required');
    const b = await h.readJson(req);
    const name = String(b.name || '').trim(), role = ROLES.indexOf(b.role) >= 0 ? b.role : 'Owner';
    if (!name) throw err(400, 'name is required');
    if (!PIN_RE.test(String(b.pin || ''))) throw err(400, 'PIN must be 6 digits or more (numbers only).');
    const ex = (await pool.query('select id from users where lower(name) = lower($1)', [name])).rows[0];
    if (await pinTaken(pool, b.pin, ex ? ex.id : '')) throw err(409, 'That PIN is already used by another user.');
    if (ex) { await pool.query("update users set role = $2, active = true, pin_hash = $3, pin_local = $4, ver = nextval('users_ver_seq') where id = $1", [ex.id, role, scryptHash(b.pin), hashPinLocal(b.pin)]); delete fails[name.toLowerCase()]; }
    else await pool.query('insert into users(id, name, role, pin_hash, pin_local) values ($1,$2,$3,$4,$5)', ['u' + crypto.randomBytes(6).toString('hex'), name, role, scryptHash(b.pin), hashPinLocal(b.pin)]);
    return h.send(res, 200, { ok: true, name: name, role: role, existed: !!ex });
  }

  if (path === '/users' && m === 'GET') {
    await h.device(req);
    return h.send(res, 200, await listUsers(pool));
  }

  if (path === '/users/manage' && m === 'POST') {
    await h.device(req);
    const b = await h.readJson(req);
    const a = b.actor || {};
    const au = (await pool.query('select * from users where id = $1', [String(a.id || '')])).rows[0];
    if (!au) throw err(401, 'Your PIN was not accepted.');
    await verify(pool, au.name, a.pin);
    if (au.role !== 'Owner') throw err(403, 'Only an Owner can change users.');
    const op = String(b.op || ''), t = b.user || {};
    if (op === 'create') {
      const name = String(t.name || '').trim(), role = ROLES.indexOf(t.role) >= 0 ? t.role : 'Cashier';
      if (!name) throw err(400, 'Enter a name.');
      if (!PIN_RE.test(String(t.pin || ''))) throw err(400, 'PIN must be 6 digits or more (numbers only).');
      if (await pinTaken(pool, t.pin)) throw err(409, 'That PIN is already used. Choose another.');
      try { await pool.query('insert into users(id, name, role, pin_hash, pin_local) values ($1,$2,$3,$4,$5)', ['u' + crypto.randomBytes(6).toString('hex'), name, role, scryptHash(t.pin), hashPinLocal(t.pin)]); }
      catch (e) { if (e.code === '23505') throw err(409, 'There is already a user with that name.'); throw e; }
    } else {
      const tu = (await pool.query('select * from users where id = $1', [String(t.id || '')])).rows[0];
      if (!tu) throw err(404, 'User not found.');
      if (op === 'setpin') {
        if (!PIN_RE.test(String(t.pin || ''))) throw err(400, 'PIN must be 6 digits or more (numbers only).');
        if (await pinTaken(pool, t.pin, tu.id)) throw err(409, 'That PIN is already used. Choose another.');
        await pool.query('update users set pin_hash = $2, pin_local = $3, ver = nextval(\'users_ver_seq\') where id = $1', [tu.id, scryptHash(t.pin), hashPinLocal(t.pin)]);
        delete fails[tu.name.toLowerCase()];
      } else if (op === 'update') {
        const name = t.name !== undefined ? String(t.name).trim() : tu.name;
        const role = t.role !== undefined ? t.role : tu.role;
        const active = t.active !== undefined ? !!t.active : tu.active;
        if (!name) throw err(400, 'Enter a name.');
        if (ROLES.indexOf(role) < 0) throw err(400, 'Unknown role.');
        if (tu.role === 'Owner' && tu.active && (role !== 'Owner' || !active) && (await ownerCount(pool)) < 2) throw err(409, 'There must be at least one active Owner.');
        if (tu.id === au.id && !active) throw err(409, 'You cannot deactivate yourself.');
        try { await pool.query('update users set name = $2, role = $3, active = $4, ver = nextval(\'users_ver_seq\') where id = $1', [tu.id, name, role, active]); }
        catch (e) { if (e.code === '23505') throw err(409, 'There is already a user with that name.'); throw e; }
      } else throw err(400, 'Unknown operation.');
    }
    return h.send(res, 200, await listUsers(pool));
  }
  return false;
}

// After a good sign in: reuse the device token the app already has, or give it a new one.
async function finishLogin(res, pool, h, name, b) {
  const u = (await pool.query('select * from users where lower(name) = lower($1)', [name])).rows[0];
  const d = b.device || {};
  let token = '';
  const have = await h.bearerDevice(b.token);
  if (!have) {
    const dn = String(d.name || 'Device').trim().slice(0, 70) + ' ' + crypto.randomBytes(2).toString('hex');
    token = (await h.registerDevice(dn, String(d.kind || 'pos'))).token;
  }
  const L = await listUsers(pool);
  return h.send(res, 200, { ok: true, token: token, user: publicUser(u), users: L.users, ver: L.ver });
}

module.exports = { ensureSchema, handle, hashPinLocal };
