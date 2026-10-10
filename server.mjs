// Nexura Care server: serves the web app and a small JSON API backed by SQLite.
// Run with: node server.mjs   (Node 24+ for the built-in node:sqlite module)
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SESSION_MS = 7 * 24 * 3600 * 1000;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE = 10 * 1024 * 1024;
const COLLECTIONS = new Set(['appts', 'patients', 'staff', 'suppliers', 'stocks', 'txs', 'devices', 'resv', 'kv']);
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || `localhost:${PORT},127.0.0.1:${PORT}`).split(','));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'nexura.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (col, id));
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
`);

try { db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN created INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }
db.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, area TEXT NOT NULL, ref TEXT, summary TEXT)');
db.exec('CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)');

const ROLES = ['Super Admin', 'Doctor', 'Receptionist', 'Accountant', 'Pharmacist'];
const RW = (...cols) => Object.fromEntries(cols.map((c) => [c, 'rw']));
const R = (...cols) => Object.fromEntries(cols.map((c) => [c, 'r']));
const PERMS = {
  'Super Admin': { ...RW('appts', 'patients', 'staff', 'suppliers', 'stocks', 'txs', 'devices', 'resv', 'kv') },
  Doctor: { ...RW('appts', 'patients', 'kv'), ...R('staff') },
  Receptionist: { ...RW('appts', 'patients', 'kv'), ...R('staff') },
  Accountant: { ...RW('txs', 'kv'), ...R('appts', 'patients', 'staff', 'suppliers', 'stocks') },
  Pharmacist: { ...RW('suppliers', 'stocks', 'kv'), ...R('devices', 'staff') },
};
const AREA = { appts: 'Appointments', patients: 'Patients', staff: 'Staff', suppliers: 'Suppliers', stocks: 'Stocks', txs: 'Transactions', devices: 'Peripherals', resv: 'Reservations', kv: 'Settings' };
const can = (user, col, mode) => { const p = (PERMS[user.role] || {})[col] || ''; return mode === 'w' ? p === 'rw' : p !== ''; };
function audit(user, action, area, ref, summary) { try { db.prepare('INSERT INTO audit (ts, user, action, area, ref, summary) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), user, action, area, ref == null ? null : String(ref), summary ? String(summary).slice(0, 200) : null); } catch (e) { console.error('audit failed', e.message); } }
function backupNow() {
  const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const file = path.join(dir, `nexura-${stamp}.db`); if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(dir).filter((f) => /^nexura-.*\.db$/.test(f)).sort(); for (const f of all.slice(0, Math.max(0, all.length - 7))) fs.unlinkSync(path.join(dir, f));
  return path.basename(file);
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function setPassword(userId, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(pw, salt), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
function newPassword() { return crypto.randomBytes(9).toString('base64url'); }
function announce(pw, why) {
  const line = '='.repeat(58);
  console.log(`\n${line}\n  ${why}\n  Username: admin\n  Password: ${pw}\n  (change it from the user menu after signing in)\n${line}\n`);
}

if (process.argv.includes('--reset-password')) {
  const u = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!u) { console.error('No admin user yet. Start the server once first.'); process.exit(1); }
  const pw = process.env.ADMIN_PASSWORD || newPassword();
  setPassword(u.id, pw); announce(pw, 'Admin password was reset.'); process.exit(0);
}
if (process.argv.includes('--backup')) { console.log('Backup written: ' + backupNow()); process.exit(0); }
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || newPassword(), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (username, name, role, salt, hash, active, created) VALUES (?, ?, ?, ?, ?, 1, ?)').run('admin', 'Mohamed Agamy', 'Super Admin', salt, hashPw(pw, salt), Date.now());
  announce(pw, 'First run: admin account created.');
}

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const cookieFlags = (req) => `HttpOnly; SameSite=Strict; Path=/${SECURE_COOKIES || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''}`;
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function send(res, code, body, headers = {}) { res.writeHead(code, { ...BASE_HEADERS, ...headers }); res.end(body); }
function sendJson(res, code, obj, headers = {}) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); }
function readBuf(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; }
function userOf(req) {
  const t = cookies(req).sid; if (!t) return null;
  return db.prepare('SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ? AND u.active = 1').get(sha(t), Date.now()) || null;
}
const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, perms: PERMS[u.role] || {} });
const attempts = new Map();
function tooMany(ip) { const a = (attempts.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000); attempts.set(ip, a); return a.length >= 6; }

/* ---------- API ---------- */
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  const isUpload = p === '/api/files' && m === 'POST';
  if (m !== 'GET') {
    if (isUpload ? req.headers['x-requested-with'] !== 'nexura' : !(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: isUpload ? 'Upload header missing' : 'JSON required' });
    const origin = req.headers.origin; if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return sendJson(res, 403, { error: 'Bad origin' });
  }
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req); if (tooMany(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    let b; try { b = JSON.parse(await readBody(req, 10_000)); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || '').toLowerCase());
    const ok = u && u.active === 1 && crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); audit(String(b.username || '?').slice(0, 40), 'Failed sign-in', 'Account', null, null); return sendJson(res, 401, { error: 'Wrong username or password.' }); }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + SESSION_MS);
    audit(u.username, 'Signed in', 'Account', null, null);
    return sendJson(res, 200, { user: publicUser(u) }, { 'Set-Cookie': `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_MS / 1000}` });
  }
  const user = userOf(req);
  if (p === '/api/session' && m === 'GET') return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: 'Not signed in' });
  if (!user) return sendJson(res, 401, { error: 'Not signed in' });

  if (p === '/api/logout' && m === 'POST') { audit(user.username, 'Signed out', 'Account', null, null); db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(cookies(req).sid)); return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `sid=; ${cookieFlags(req)}; Max-Age=0` }); }
  if (p === '/api/data' && m === 'GET') {
    const rows = db.prepare('SELECT col, data FROM records').all(), cols = {};
    for (const r of rows) if (can(user, r.col, 'r')) (cols[r.col] ||= []).push(JSON.parse(r.data));
    return sendJson(res, 200, { empty: rows.length === 0, collections: cols });
  }
  if (p === '/api/seed' && m === 'POST') {
    if (user.role !== 'Super Admin') return sendJson(res, 403, { error: 'Only a Super Admin can load the first data.' });
    if (db.prepare('SELECT 1 FROM records LIMIT 1').get()) return sendJson(res, 409, { error: 'Database already has data' });
    let b; try { b = JSON.parse(await readBody(req, 40_000_000)); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'Bad seed payload' }); }
    const ins = db.prepare('INSERT OR REPLACE INTO records (col, id, data, updated) VALUES (?, ?, ?, ?)'); let n = 0;
    db.exec('BEGIN');
    try {
      for (const col of Object.keys(b)) { if (!COLLECTIONS.has(col) || !Array.isArray(b[col])) continue; for (const o of b[col]) { if (o && o.id !== undefined) { ins.run(col, String(o.id), JSON.stringify(o), Date.now()); n++; } } }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(user.username, 'Loaded demo data', 'System', null, n + ' records');
    return sendJson(res, 200, { ok: true, count: n });
  }
  if (p === '/api/password' && m === 'POST') {
    let b; try { b = JSON.parse(await readBody(req, 10_000)); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!crypto.timingSafeEqual(Buffer.from(hashPw(String(b.current || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return sendJson(res, 400, { error: 'Current password is wrong.' });
    const next = String(b.next || ''); if (next.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
    setPassword(u.id, next); audit(user.username, 'Changed own password', 'Account', null, null);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + SESSION_MS);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_MS / 1000}` });
  }
  if (isUpload) {
    if (!can(user, 'appts', 'w') && !can(user, 'patients', 'w')) return sendJson(res, 403, { error: 'Your role cannot upload files.' });
    let buf; try { buf = await readBuf(req, MAX_FILE); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'File is larger than 10MB.' : 'Upload failed' }); }
    if (!buf.length) return sendJson(res, 400, { error: 'Empty file' });
    let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep default */ }
    name = name.replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 160) || 'file';
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
    db.prepare('INSERT INTO files (id, name, size, created) VALUES (?, ?, ?, ?)').run(id, name, buf.length, Date.now());
    return sendJson(res, 200, { id, name, size: buf.length });
  }
  const fm = p.match(/^\/api\/files\/([a-f0-9]{32})$/);
  if (fm) {
    if (!can(user, 'appts', 'r') && !can(user, 'patients', 'r')) return sendJson(res, 403, { error: 'Your role cannot open files.' });
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fm[1]);
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    if (m === 'GET') {
      let data; try { data = fs.readFileSync(path.join(UPLOAD_DIR, row.id)); } catch { return sendJson(res, 404, { error: 'Not found' }); }
      return send(res, 200, data, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'Cache-Control': 'private, no-store' });
    }
    if (m === 'DELETE') { if (!can(user, 'appts', 'w') && !can(user, 'patients', 'w')) return sendJson(res, 403, { error: 'Your role cannot delete files.' }); db.prepare('DELETE FROM files WHERE id = ?').run(row.id); try { fs.unlinkSync(path.join(UPLOAD_DIR, row.id)); } catch { /* already gone */ } return sendJson(res, 200, { ok: true }); }
  }
  if (p === '/api/users' || p.startsWith('/api/users/') || p === '/api/audit' || p === '/api/backup') {
    if (user.role !== 'Super Admin') return sendJson(res, 403, { error: 'Only a Super Admin can do this.' });
    if (p === '/api/audit' && m === 'GET') return sendJson(res, 200, { rows: db.prepare('SELECT id, ts, user, action, area, ref, summary FROM audit ORDER BY id DESC LIMIT 1500').all() });
    if (p === '/api/backup' && m === 'POST') { const f = backupNow(); audit(user.username, 'Backup', 'System', null, f); return sendJson(res, 200, { file: f }); }
    if (p === '/api/users' && m === 'GET') return sendJson(res, 200, { users: db.prepare('SELECT id, username, name, role, active, created FROM users ORDER BY id').all(), roles: ROLES });
    let b = {}; try { b = JSON.parse(await readBody(req, 10_000)); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const okName = (v) => typeof v === 'string' && v.trim().length >= 2 && v.length <= 80;
    if (p === '/api/users' && m === 'POST') {
      const username = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return sendJson(res, 400, { error: 'Username: 3 to 30 letters, numbers, dot, dash or underscore.' });
      if (!okName(b.name)) return sendJson(res, 400, { error: 'Enter the full name.' });
      if (!ROLES.includes(b.role)) return sendJson(res, 400, { error: 'Choose a role.' });
      if (pw.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters for the password.' });
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return sendJson(res, 409, { error: 'That username is taken.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const r = db.prepare('INSERT INTO users (username, name, role, salt, hash, active, created) VALUES (?, ?, ?, ?, ?, 1, ?)').run(username, b.name.trim(), b.role, salt, hashPw(pw, salt), Date.now());
      audit(user.username, 'Created user', 'Users', r.lastInsertRowid, `${username} (${b.role})`);
      return sendJson(res, 200, { ok: true });
    }
    const um = p.match(/^\/api\/users\/(\d+)$/);
    if (um && m === 'PUT') {
      const t = db.prepare('SELECT * FROM users WHERE id = ?').get(+um[1]); if (!t) return sendJson(res, 404, { error: 'Not found' });
      const activeSA = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'Super Admin' AND active = 1").get().n;
      const name = b.name === undefined ? t.name : b.name, role = b.role === undefined ? t.role : b.role, active = b.active === undefined ? t.active : (b.active ? 1 : 0);
      if (!okName(name)) return sendJson(res, 400, { error: 'Enter the full name.' }); if (!ROLES.includes(role)) return sendJson(res, 400, { error: 'Choose a role.' });
      if (t.id === user.id && (!active || role !== 'Super Admin')) return sendJson(res, 400, { error: 'You cannot lock yourself out. Ask another Super Admin.' });
      if (t.role === 'Super Admin' && t.active === 1 && (role !== 'Super Admin' || !active) && activeSA <= 1) return sendJson(res, 400, { error: 'There must be at least one active Super Admin.' });
      db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name.trim(), role, active, t.id);
      if (!active || role !== t.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.id);
      if (b.password !== undefined && b.password !== '') { if (String(b.password).length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters for the password.' }); setPassword(t.id, String(b.password)); audit(user.username, 'Reset password', 'Users', t.id, t.username); }
      audit(user.username, 'Updated user', 'Users', t.id, `${t.username}: ${role}${active ? '' : ', locked'}`);
      return sendJson(res, 200, { ok: true });
    }
  }
  const rec = p.match(/^\/api\/records\/([a-z]+)\/([^/]{1,120})$/);
  if (rec && COLLECTIONS.has(rec[1])) {
    const col = rec[1], id = decodeURIComponent(rec[2]);
    if (!can(user, col, 'w')) return sendJson(res, 403, { error: 'Your role cannot change ' + AREA[col].toLowerCase() + '.' });
    if (m === 'PUT') {
      let b; try { b = JSON.parse(await readBody(req, 12_000_000)); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'Bad record' }); }
      if (!b || typeof b !== 'object' || Array.isArray(b) || String(b.id) !== id) return sendJson(res, 400, { error: 'Record id mismatch' });
      const existed = db.prepare('SELECT 1 FROM records WHERE col = ? AND id = ?').get(col, id);
      db.prepare('INSERT OR REPLACE INTO records (col, id, data, updated) VALUES (?, ?, ?, ?)').run(col, id, JSON.stringify(b), Date.now());
      if (col !== 'kv') audit(user.username, existed ? 'Updated' : 'Created', AREA[col], id, b.name || b.patient || (b.status ? col + ' ' + id + ' (' + b.status + ')' : col + ' ' + id));
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const old = db.prepare('SELECT data FROM records WHERE col = ? AND id = ?').get(col, id); let nm = col + ' ' + id; try { const o = JSON.parse(old.data); nm = o.name || o.patient || nm; } catch { /* keep */ }
      db.prepare('DELETE FROM records WHERE col = ? AND id = ?').run(col, id); if (col !== 'kv') audit(user.username, 'Deleted', AREA[col], id, nm); return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

/* ---------- static files ---------- */
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const p = url.pathname; let rel = null;
  const hasSite = fs.existsSync(path.join(ROOT, 'site', 'index.html'));
  if (p === '/') rel = hasSite ? 'site/index.html' : 'index.html';
  else if (p === '/app' || p === '/app/' || p === '/index.html') rel = 'index.html';
  else if (/^\/assets\/[\w.-]+$/.test(p)) rel = p.slice(1);
  else if (/^\/site\/[\w./-]+$/.test(p) && !p.includes('..')) rel = p.slice(1);
  if (!rel) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const page = rel === 'index.html' || rel === 'site/index.html';
    send(res, 200, req.method === 'HEAD' ? undefined : buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': page ? 'no-cache' : 'max-age=3600' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, 'Misdirected request', { 'Content-Type': 'text/plain' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, e && e.code === 413 ? 413 : 500, { error: e && e.code === 413 ? 'Request too large' : 'Server error' });
  }
});
try { console.log('Backup written: ' + backupNow()); } catch (e) { console.error('backup failed', e.message); }
setInterval(() => { try { backupNow(); } catch (e) { console.error('backup failed', e.message); } }, 24 * 3600 * 1000).unref();
server.listen(PORT, HOST, () => console.log(`Nexura Care is running at http://localhost:${PORT}  (data: ${path.join(DATA_DIR, 'nexura.db')})`));
process.on('SIGINT', () => { server.close(); db.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0); });
