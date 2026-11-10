'use strict';
// Hollywood POS sync API. A thin layer over the SQL functions in db/schema.sql.
// Only Node's built-in http module and the "pg" driver are used.
const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const MAX_BODY = 2 * 1024 * 1024;
// Optional: also serve the web apps (tablet order pad at /, POS at /pos/) from this folder, so a shop computer can do everything.
const WEB_DIR = process.env.WEB_DIR ? nodePath.resolve(process.env.WEB_DIR) : '';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

function cors(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.indexOf('*') >= 0) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ORIGINS.indexOf(origin) >= 0) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}
function send(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
  res.end(s);
}
function readJson(req) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
async function one(sql, params) { const r = await pool.query(sql, params); return r.rows[0] ? r.rows[0].r : null; }
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }
async function device(req) {
  const id = await one('select auth_device($1) as r', [bearer(req)]);
  if (!id) throw Object.assign(new Error('unknown device token'), { status: 401 });
  return id;
}
function isAdmin(req) {
  const t = req.headers['x-admin-token'] || '';
  return ADMIN_TOKEN.length >= 16 && t === ADMIN_TOKEN;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkEvents(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('events must be a list'), { status: 400 });
  list.forEach(function (e, i) {
    if (!e || typeof e !== 'object' || !UUID.test(String(e.id)) || typeof e.type !== 'string' || !e.type || typeof e.payload !== 'object' || e.payload === null)
      throw Object.assign(new Error('event ' + i + ' needs id (uuid), type and payload'), { status: 400 });
    if (e.type === 'sale' && !UUID.test(String(e.payload.id))) throw Object.assign(new Error('event ' + i + ': sale needs payload.id (uuid)'), { status: 400 });
  });
}


function serveStatic(req, res, pathname) {
  if (!WEB_DIR || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  else if (rel === '/pos') rel = '/pos/index.html';
  const file = nodePath.normalize(nodePath.join(WEB_DIR, rel));
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + nodePath.sep)) return false;   // never leave the web folder
  let st; try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[nodePath.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  if (m === 'GET' && path === '/health') { await pool.query('select 1'); return send(res, 200, { ok: true }); }

  if (path === '/admin/devices' && m === 'POST') {
    if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) return send(res, 400, { error: 'name is required' });
    return send(res, 201, await one('select register_device($1, $2) as r', [name.slice(0, 80), String(b.kind || 'tablet').slice(0, 20)]));
  }
  if (path === '/admin/report/day' && m === 'GET') {
    if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
    const day = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
    return send(res, 200, await one('select report_day($1::date) as r', [day]));
  }

  if (path === '/sync/push' && m === 'POST') {
    const dev = await device(req);
    const b = await readJson(req);
    checkEvents(b.events);
    return send(res, 200, await one('select sync_push($1::uuid, $2::jsonb) as r', [dev, JSON.stringify(b.events)]));
  }
  if (path === '/sync/pull' && m === 'GET') {
    const dev = await device(req);
    const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '500', 10) || 500));
    return send(res, 200, await one('select sync_pull($1::uuid, $2::bigint, $3::int) as r', [dev, after, limit]));
  }
  const cm = path.match(/^\/config\/([a-z0-9_-]{1,40})$/);
  if (cm && m === 'GET') { await device(req); return send(res, 200, await one('select config_get($1) as r', [cm[1]])); }
  if (cm && m === 'PUT') {
    const dev = await device(req);
    const b = await readJson(req);
    if (b.value === undefined) return send(res, 400, { error: 'value is required' });
    const out = await one('select config_put($1::uuid, $2, $3::jsonb, $4::int) as r', [dev, cm[1], JSON.stringify(b.value), parseInt(b.version || 0, 10) || 0]);
    return send(res, out.ok ? 200 : 409, out);
  }
  if (serveStatic(req, res, url.pathname)) return;
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(function (req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  route(req, res).catch(function (e) {
    const status = e.status || (e.code && String(e.code).startsWith('22') ? 400 : 500);
    if (status >= 500) console.error(new Date().toISOString(), e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'server error' : e.message });
  });
});
server.listen(PORT, function () { console.log('Hollywood POS API listening on ' + PORT); });
process.on('SIGTERM', function () { server.close(function () { pool.end().then(function () { process.exit(0); }); }); });
