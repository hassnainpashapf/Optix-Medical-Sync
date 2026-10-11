// Optix Medical Sync: multi-tenant hospital management SaaS.
// One Node process (Node 24+, no npm packages). Each hospital (tenant) gets its own SQLite file; a small platform
// database holds tenants, plans, sessions, invite and reset tokens, the email outbox and the platform owner accounts.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailConfig, sendSmtp } from './lib/mail.mjs';
import { HUB, HubError, localRoleOf, resolveHubIdentity } from './lib/hub.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_FILE = 10 * 1024 * 1024;
const TRIAL_DAYS = 15;
const COLLECTIONS = new Set(['appts', 'patients', 'staff', 'suppliers', 'stocks', 'txs', 'devices', 'resv', 'kv', 'wards', 'beds', 'admissions', 'visits', 'opdq', 'labtests', 'labs']);
/* the hospital modules added after the first release: wards and beds (IPD), consultations, OPD queue, lab and radiology */
const HOSPITAL_COLS = ['wards', 'beds', 'admissions', 'visits', 'opdq', 'labtests', 'labs'];
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || `localhost:${PORT},127.0.0.1:${PORT}`).split(',').map((h) => h.trim()));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';
const RESERVED = new Set(['app', 'api', 'www', 'platform', 'admin', 'site', 'signup', 'assets', 'static', 'mail', 'support', 'help', 'login', 'billing', 'status', 'root', 'null', 'undefined']);

fs.mkdirSync(TENANTS_DIR, { recursive: true });

/* ================= platform database ================= */
const pdb = new DatabaseSync(path.join(DATA_DIR, 'platform.db'));
pdb.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, trial_ends INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, sample INTEGER NOT NULL DEFAULT 0, owner_email TEXT NOT NULL DEFAULT '', last_active INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'EGP', max_users INTEGER NOT NULL, max_patients INTEGER NOT NULL, max_storage_mb INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 0, blurb TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS owners (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS owner_sessions (token TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (tenant_id, user_id);
  CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tenant_id TEXT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
  CREATE TABLE IF NOT EXISTS paudit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, ref TEXT, summary TEXT);
`);
try { pdb.exec('ALTER TABLE tenants ADD COLUMN hub_lab TEXT'); } catch { /* already there */ }
try { pdb.exec('CREATE UNIQUE INDEX IF NOT EXISTS tenants_hub_lab ON tenants (hub_lab) WHERE hub_lab IS NOT NULL'); } catch { /* ignore */ }
if (!pdb.prepare('SELECT 1 FROM plans LIMIT 1').get()) {
  // Placeholder prices. The platform owner edits these in the panel; the website reads them from /api/plans.
  const ins = pdb.prepare('INSERT INTO plans (id, name, price, currency, max_users, max_patients, max_storage_mb, sort, blurb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('starter', 'Starter', 990, 'EGP', 3, 300, 500, 1, 'For a small clinic getting started.');
  ins.run('clinic', 'Clinic', 2490, 'EGP', 15, 3000, 5000, 2, 'For a busy clinic with several doctors.');
  ins.run('hospital', 'Hospital', 6990, 'EGP', -1, -1, 50000, 3, 'For hospitals with no limits on staff or patients.');
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const randPw = () => crypto.randomBytes(9).toString('base64url');
const checkPw = (pw, u) => { try { return crypto.timingSafeEqual(Buffer.from(hashPw(String(pw || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex')); } catch { return false; } };
function paudit(who, action, ref, summary) { try { pdb.prepare('INSERT INTO paudit (ts, who, action, ref, summary) VALUES (?, ?, ?, ?, ?)').run(Date.now(), who, action, ref == null ? null : String(ref), summary ? String(summary).slice(0, 200) : null); } catch (e) { console.error('paudit failed', e.message); } }

/* ================= tenants ================= */
const ROLES = ['Super Admin', 'Doctor', 'Receptionist', 'Accountant', 'Pharmacist'];
const rw = (...c) => Object.fromEntries(c.map((x) => [x, 'rw']));
const ro = (...c) => Object.fromEntries(c.map((x) => [x, 'r']));
const PERMS = {
  'Super Admin': rw('appts', 'patients', 'staff', 'suppliers', 'stocks', 'txs', 'devices', 'resv', 'kv', ...HOSPITAL_COLS),
  Doctor: { ...rw('appts', 'patients', 'kv', 'wards', 'beds', 'admissions', 'visits', 'opdq', 'labtests', 'labs'), ...ro('staff') },
  Receptionist: { ...rw('appts', 'patients', 'kv', 'wards', 'beds', 'admissions', 'opdq', 'labtests', 'labs'), ...ro('staff', 'visits') },
  Accountant: { ...rw('txs', 'kv'), ...ro('appts', 'patients', 'staff', 'suppliers', 'stocks', 'wards', 'beds', 'admissions', 'labtests', 'labs') },
  Pharmacist: { ...rw('suppliers', 'stocks', 'kv'), ...ro('devices', 'staff', 'wards', 'beds', 'admissions', 'visits') },
};
const AREA = { appts: 'Appointments', patients: 'Patients', staff: 'Staff', suppliers: 'Suppliers', stocks: 'Stocks', txs: 'Transactions', devices: 'Peripherals', resv: 'Reservations', kv: 'Settings', wards: 'Wards', beds: 'Beds', admissions: 'Admissions', visits: 'Consultations', opdq: 'OPD queue', labtests: 'Lab catalog', labs: 'Lab orders' };
/* Rules the server enforces on top of the role matrix, so two users on two screens cannot break the data. Return an error text or ''. */
const jget = (db, col, where, ...args) => db.prepare(`SELECT 1 FROM records WHERE col = '${col}' AND ${where}`).get(...args);
const RULES = {
  admissions(db, id, b) {
    if (b.status !== 'admitted') return '';
    if (b.bedId && jget(db, 'admissions', "id != ? AND json_extract(data, '$.status') = 'admitted' AND json_extract(data, '$.bedId') = ?", id, String(b.bedId))) return 'That bed is already occupied. Pick another bed.';
    if (b.pid !== undefined && jget(db, 'admissions', "id != ? AND json_extract(data, '$.status') = 'admitted' AND json_extract(data, '$.pid') = ?", id, b.pid ?? null)) return 'This patient is already admitted.';
    return '';
  },
  opdq(db, id, b) {
    if (jget(db, 'opdq', "id != ? AND json_extract(data, '$.docId') = ? AND json_extract(data, '$.date') = ? AND json_extract(data, '$.no') = ?", id, b.docId ?? null, String(b.date), b.no ?? null)) return 'That token number was just issued to someone else. Refresh and try again.';
    return '';
  },
};
const can = (user, col, mode) => { const p = (PERMS[user.role] || {})[col] || ''; return mode === 'w' ? p === 'rw' : p !== ''; };
const validSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(s) && !RESERVED.has(s);

const cache = new Map();
function initTenantDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (col, id));
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, area TEXT NOT NULL, ref TEXT, summary TEXT);
    CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
  `);
  for (const sql of ['ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1', 'ALTER TABLE users ADD COLUMN created INTEGER NOT NULL DEFAULT 0', "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''", 'ALTER TABLE users ADD COLUMN hub_user TEXT']) { try { db.exec(sql); } catch { /* column exists */ } }
}
function tenantCtx(slug) {
  if (!validSlug(slug) && slug !== 'demo') return null;
  if (cache.has(slug)) return cache.get(slug);
  const dir = path.join(TENANTS_DIR, slug), file = path.join(dir, 'nexura.db');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file); initTenantDb(db);
  const ctx = { slug, dir, db, uploads: path.join(dir, 'uploads') }; fs.mkdirSync(ctx.uploads, { recursive: true });
  cache.set(slug, ctx); return ctx;
}
function closeTenant(slug) { const c = cache.get(slug); if (c) { try { c.db.close(); } catch { /* ignore */ } cache.delete(slug); } }
function createTenantFiles(slug) {
  const dir = path.join(TENANTS_DIR, slug); fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'nexura.db')); initTenantDb(db); db.close();
}
const planOf = (id) => pdb.prepare('SELECT * FROM plans WHERE id = ?').get(id) || pdb.prepare('SELECT * FROM plans ORDER BY sort LIMIT 1').get();
function usageOf(ctx) {
  return {
    users: ctx.db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n,
    patients: ctx.db.prepare("SELECT COUNT(*) n FROM records WHERE col = 'patients'").get().n,
    storage: ctx.db.prepare('SELECT COALESCE(SUM(size), 0) n FROM files').get().n,
  };
}
const trialLeft = (t) => (t.status === 'trial' ? Math.ceil((t.trial_ends - Date.now()) / 86400000) : null);
function writeBlock(t) {
  if (t.status === 'suspended') return 'This workspace is suspended. Contact the platform owner.';
  if (t.status === 'cancelled') return 'This workspace was cancelled.';
  if (t.status === 'trial' && t.trial_ends < Date.now()) return 'The free trial has ended. Ask your Super Admin to choose a plan.';
  return '';
}
function wsInfo(t, ctx) {
  const p = planOf(t.plan), u = usageOf(ctx);
  return { slug: t.id, name: t.name, status: t.status, trialDaysLeft: trialLeft(t), trialEnds: t.trial_ends, plan: { id: p.id, name: p.name, price: p.price, currency: p.currency, maxUsers: p.max_users, maxPatients: p.max_patients, maxStorageMb: p.max_storage_mb }, usage: u, sample: !!t.sample };
}
function tenantAudit(ctx, user, action, area, ref, summary) { try { ctx.db.prepare('INSERT INTO audit (ts, user, action, area, ref, summary) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), user, action, area, ref == null ? null : String(ref), summary ? String(summary).slice(0, 200) : null); } catch (e) { console.error('audit failed', e.message); } }

function backupDb(db, dir, prefix) {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), z = (n) => String(n).padStart(2, '0'), stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
  const file = path.join(dir, `${prefix}-${stamp}.db`); if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith(prefix + '-') && f.endsWith('.db')).sort(); for (const f of all.slice(0, Math.max(0, all.length - 7))) fs.unlinkSync(path.join(dir, f));
  return path.basename(file);
}
function backupAll() {
  const out = [backupDb(pdb, path.join(DATA_DIR, 'backups'), 'platform')];
  for (const t of pdb.prepare("SELECT id FROM tenants WHERE status != 'cancelled'").all()) { const c = tenantCtx(t.id); if (c) out.push(t.id + '/' + backupDb(c.db, path.join(c.dir, 'backups'), 'nexura')); }
  return out;
}

/* ---------- one-time migration of the old single-hospital layout ---------- */
(function migrate() {
  const old = path.join(DATA_DIR, 'nexura.db');
  if (!fs.existsSync(old) || pdb.prepare('SELECT 1 FROM tenants LIMIT 1').get()) return;
  const dir = path.join(TENANTS_DIR, 'demo'); fs.mkdirSync(dir, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(old + ext)) fs.renameSync(old + ext, path.join(dir, 'nexura.db' + ext));
  const up = path.join(DATA_DIR, 'uploads'); if (fs.existsSync(up)) fs.renameSync(up, path.join(dir, 'uploads'));
  pdb.prepare("INSERT INTO tenants (id, name, plan, status, trial_ends, created, sample, owner_email) VALUES ('demo', 'Demo Hospital', 'hospital', 'active', 0, ?, 0, '')").run(Date.now());
  paudit('system', 'Migrated the single-hospital database', 'demo', 'moved to data/tenants/demo');
  console.log('Migrated the existing database into workspace "demo".');
})();

/* ================= email ================= */
function appUrl(req) { if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, ''); const proto = TRUST_PROXY && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http'; return `${proto}://${req.headers.host}`; }
function queueMail(tenantId, to, subject, text) {
  const r = pdb.prepare('INSERT INTO outbox (ts, tenant_id, to_addr, subject, body, status) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), tenantId || null, to, subject, text, 'queued'), id = r.lastInsertRowid, cfg = mailConfig();
  if (!cfg) { pdb.prepare("UPDATE outbox SET status = 'logged' WHERE id = ?").run(id); console.log(`[email not sent, SMTP not configured] to ${to}: ${subject}`); return; }
  sendSmtp(cfg, { to, subject, text }).then(() => pdb.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").run(id)).catch((e) => { pdb.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 300), id); console.error('mail failed:', e.message); });
}
function makeToken(tenantId, userId, kind, ttlMs) {
  const raw = crypto.randomBytes(32).toString('base64url');
  pdb.prepare('DELETE FROM tokens WHERE tenant_id = ? AND user_id = ? AND kind = ?').run(tenantId, userId, kind);
  pdb.prepare('INSERT INTO tokens (hash, tenant_id, user_id, kind, expires) VALUES (?, ?, ?, ?, ?)').run(sha(raw), tenantId, userId, kind, Date.now() + ttlMs); return raw;
}
function sendInvite(req, t, user, byName) {
  const link = `${appUrl(req)}/app?token=${makeToken(t.id, user.id, 'invite', 3 * 86400000)}`;
  queueMail(t.id, user.email, `You are invited to ${t.name} on Optix Medical Sync`, `Hello ${user.name},\n\n${byName} invited you to ${t.name} on Optix Medical Sync as ${user.role}.\n\nSet your password and sign in here (valid for 3 days):\n${link}\n\nWorkspace code: ${t.id}\nUsername: ${user.username}\n`);
}
function sendReset(req, t, user) {
  const link = `${appUrl(req)}/app?token=${makeToken(t.id, user.id, 'reset', 3600000)}`;
  queueMail(t.id, user.email, 'Reset your Optix Medical Sync password', `Hello ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, you can ignore this email.\n`);
}

/* ================= http helpers ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const gzCache = new Map(); /* file -> { key, gz }: compressed once per file version */
function gzipCached(file, buf) {
  const key = buf.length + ':' + fs.statSync(file).mtimeMs, hit = gzCache.get(file);
  if (hit && hit.key === key) return hit.gz;
  const gz = zlib.gzipSync(buf, { level: 9 }); gzCache.set(file, { key, gz }); return gz;
}
const send = (res, code, body, headers = {}) => { res.writeHead(code, { ...BASE_HEADERS, ...headers }); res.end(body); };
const sendJson = (res, code, obj, headers = {}) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
function readBuf(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function readJson(req, limit = 20000) { const b = await readBuf(req, limit); try { const o = JSON.parse(b.toString('utf8') || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { throw Object.assign(new Error('Bad request'), { code: 400 }); } }
const cookies = (req) => { const o = {}; (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; };
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const cookieFlags = (req) => `HttpOnly; SameSite=Strict; Path=/${SECURE_COOKIES || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''}`;
const setCookie = (req, name, val, maxAge) => ({ 'Set-Cookie': `${name}=${val}; ${cookieFlags(req)}; Max-Age=${maxAge}` });

const hits = new Map();
function limited(bucket, key, max, windowMs) { const k = bucket + key, now = Date.now(), a = (hits.get(k) || []).filter((t) => now - t < windowMs); hits.set(k, a); return a.length >= max; }
const hit = (bucket, key) => { const k = bucket + key; hits.set(k, [...(hits.get(k) || []), Date.now()]); };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter((t) => now - t < 3600000); if (f.length) hits.set(k, f); else hits.delete(k); } }, 600000).unref();

/* ---------- sessions ---------- */
function newSession(tenantId, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  pdb.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  pdb.prepare('INSERT INTO sessions (token, tenant_id, user_id, expires) VALUES (?, ?, ?, ?)').run(sha(token), tenantId, userId, Date.now() + SESSION_MS); return token;
}
const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, email: u.email || '', perms: PERMS[u.role] || {} });
function tenantAuth(req) {
  const tok = cookies(req).sid; if (!tok) return null;
  const s = pdb.prepare('SELECT * FROM sessions WHERE token = ? AND expires > ?').get(sha(tok), Date.now()); if (!s) return null;
  const t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(s.tenant_id); if (!t || t.status === 'cancelled') return null;
  const ctx = tenantCtx(t.id); if (!ctx) return null;
  const user = ctx.db.prepare('SELECT id, username, name, role, email FROM users WHERE id = ? AND active = 1').get(s.user_id); if (!user) return null;
  return { t, ctx, user, token: sha(tok) };
}
function ownerAuth(req) {
  const tok = cookies(req).psid; if (!tok) return null;
  return pdb.prepare('SELECT o.id, o.username, o.name FROM owner_sessions s JOIN owners o ON o.id = s.owner_id WHERE s.token = ? AND s.expires > ? AND o.active = 1').get(sha(tok), Date.now()) || null;
}
function startTenantSession(req, res, t, user, extra = {}) {
  const token = newSession(t.id, user.id); pdb.prepare('UPDATE tenants SET last_active = ? WHERE id = ?').run(Date.now(), t.id);
  return sendJson(res, 200, { user: publicUser(user), workspace: t.id, ...extra }, setCookie(req, 'sid', token, SESSION_MS / 1000));
}

/* Link a hub business to a hospital workspace (created on the first visit of that business's admin) and a hub person to a user of it. The
   hub stays the source of truth for who the person is and, when set there, their role; the hospital keeps all clinical data. */
function hubProvision(who) {
  const { user: hu, lab } = who, labId = String(lab.id);
  let t = pdb.prepare('SELECT * FROM tenants WHERE hub_lab = ?').get(labId), fresh = false;
  if (!t) {
    if (hu.role !== 'admin') throw new HubError(409, 'Your business has no hospital workspace yet. Ask your administrator to open the Hospital app once.');
    let base = slugify(lab.slug || lab.name); if (!validSlug(base)) base = 'hospital';
    let slug = base; while (pdb.prepare('SELECT 1 FROM tenants WHERE id = ?').get(slug) || !validSlug(slug)) slug = (base.slice(0, 24) + '-' + crypto.randomBytes(2).toString('hex')).replace(/^-+/, '');
    createTenantFiles(slug);
    pdb.prepare('INSERT INTO tenants (id, name, plan, status, trial_ends, created, sample, owner_email, last_active, hub_lab) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(slug, String(lab.name || slug).slice(0, 80), 'clinic', 'trial', Date.now() + TRIAL_DAYS * 86400000, Date.now(), 0, String(hu.email || ''), Date.now(), labId);
    paudit('system', 'New workspace (Optix account)', slug, `${lab.name} (business ${labId})`);
    t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(slug); fresh = true;
  }
  if (t.status === 'suspended') throw new HubError(403, 'This workspace is suspended. Contact the platform owner.');
  if (t.status === 'cancelled') throw new HubError(403, 'This workspace was cancelled.');
  const ctx = tenantCtx(t.id); if (!ctx) throw new HubError(500, 'The workspace could not be opened.');
  const hubId = String(hu.id), wanted = localRoleOf(hu.appRoles && hu.appRoles[HUB.appId]) || (hu.role === 'admin' ? 'Super Admin' : null);
  let u = ctx.db.prepare('SELECT * FROM users WHERE hub_user = ?').get(hubId);
  if (!u) {
    const plan = planOf(t.plan);
    if (plan.max_users >= 0 && usageOf(ctx).users >= plan.max_users) throw new HubError(402, `The ${plan.name} plan allows ${plan.max_users} users. Ask your administrator to upgrade.`);
    let base = String(hu.username || hu.name || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24); if (base.length < 3) base = (base + 'user').slice(0, 24);
    let username = base; while (ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = base + '-' + crypto.randomBytes(2).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex'), role = wanted || 'Receptionist';
    const r = ctx.db.prepare('INSERT INTO users (username, name, role, salt, hash, active, created, email, hub_user) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(username, String(hu.name || username).slice(0, 80), role, salt, hashPw(randPw() + randPw(), salt), Date.now(), String(hu.email || ''), hubId);
    u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    tenantAudit(ctx, username, fresh ? 'Created the workspace (Optix account)' : 'Joined with the Optix account', 'Account', u.id, role);
  } else {
    if (!u.active) throw new HubError(403, 'Your hospital account is switched off. Ask your Super Admin.');
    if (wanted && wanted !== u.role) { ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(wanted, u.id); tenantAudit(ctx, u.username, 'Role set by the Optix account', 'Account', u.id, `${u.role} -> ${wanted}`); u.role = wanted; }
    if (hu.name && hu.name !== u.name) { ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(hu.name).slice(0, 80), u.id); u.name = hu.name; }
    tenantAudit(ctx, u.username, 'Signed in (Optix account)', 'Account', null, null);
  }
  return { t, user: u };
}

/* ================= public + signup API ================= */
const okEmail = (e) => typeof e === 'string' && e.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const okUser = (u) => /^[a-z0-9._-]{3,30}$/.test(u);
const okName = (n) => typeof n === 'string' && n.trim().length >= 2 && n.length <= 80;
function slugify(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, ''); }

async function publicApi(req, res, p, m, url) {
  if (p === '/api/plans' && m === 'GET') return sendJson(res, 200, { plans: pdb.prepare('SELECT id, name, price, currency, max_users, max_patients, max_storage_mb, blurb FROM plans ORDER BY sort').all(), trialDays: TRIAL_DAYS, supportEmail: process.env.SUPPORT_EMAIL || '' });
  if (p === '/api/signup/check' && m === 'GET') { const s = String(url.searchParams.get('slug') || '').toLowerCase(); return sendJson(res, 200, { valid: validSlug(s), available: validSlug(s) && !pdb.prepare('SELECT 1 FROM tenants WHERE id = ?').get(s) }); }
  if (p === '/api/signup' && m === 'POST') {
    const ip = clientIp(req); if (limited('signup', ip, 5, 3600000)) return sendJson(res, 429, { error: 'Too many sign-ups from this address. Try again later.' });
    const b = await readJson(req); const slug = String(b.workspace || slugify(b.hospital)).toLowerCase(), username = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!okName(b.hospital)) return sendJson(res, 400, { error: 'Enter the hospital or clinic name.' });
    if (!validSlug(slug)) return sendJson(res, 400, { error: 'Workspace code: 3 to 30 lowercase letters, numbers or dashes (not a reserved word).' });
    if (!okName(b.name)) return sendJson(res, 400, { error: 'Enter your full name.' });
    if (!okEmail(b.email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (!okUser(username)) return sendJson(res, 400, { error: 'Username: 3 to 30 letters, numbers, dot, dash or underscore.' });
    if (pw.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters for the password.' });
    if (pdb.prepare('SELECT 1 FROM tenants WHERE id = ?').get(slug)) return sendJson(res, 409, { error: 'That workspace code is taken. Try another.' });
    hit('signup', ip);
    createTenantFiles(slug);
    pdb.prepare('INSERT INTO tenants (id, name, plan, status, trial_ends, created, sample, owner_email, last_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(slug, b.hospital.trim(), 'clinic', 'trial', Date.now() + TRIAL_DAYS * 86400000, Date.now(), b.sample === false ? 0 : 1, b.email.trim(), Date.now());
    const ctx = tenantCtx(slug), salt = crypto.randomBytes(16).toString('hex');
    const r = ctx.db.prepare('INSERT INTO users (username, name, role, salt, hash, active, created, email) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(username, b.name.trim(), 'Super Admin', salt, hashPw(pw, salt), Date.now(), b.email.trim());
    tenantAudit(ctx, username, 'Created the workspace', 'System', slug, b.hospital.trim()); paudit('system', 'New workspace', slug, `${b.hospital.trim()} (${b.email.trim()})`);
    const t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(slug), user = { id: r.lastInsertRowid, username, name: b.name.trim(), role: 'Super Admin', email: b.email.trim() };
    queueMail(slug, user.email, 'Welcome to Optix Medical Sync', `Hello ${user.name},\n\nYour workspace "${t.name}" is ready. Your ${TRIAL_DAYS}-day free trial has started.\n\nSign in at: ${appUrl(req)}/app\nWorkspace code: ${slug}\nUsername: ${username}\n\nKeep the workspace code, you need it to sign in.\n`);
    return startTenantSession(req, res, t, user);
  }
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req); if (limited('login', ip, 8, 600000)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readJson(req), ws = String(b.workspace || '').trim().toLowerCase(), t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(ws), ctx = t && t.status !== 'cancelled' ? tenantCtx(ws) : null;
    const u = ctx && ctx.db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || '').trim().toLowerCase());
    if (!u || !u.active || !checkPw(b.password, u)) { hit('login', ip); if (ctx) tenantAudit(ctx, String(b.username || '?').slice(0, 40), 'Failed sign-in', 'Account', null, null); return sendJson(res, 401, { error: 'Wrong workspace, username or password.' }); }
    if (t.status === 'suspended') return sendJson(res, 403, { error: 'This workspace is suspended. Contact the platform owner.' });
    tenantAudit(ctx, u.username, 'Signed in', 'Account', null, null);
    return startTenantSession(req, res, t, u);
  }
  /* ---------- Optix account (one login for the whole suite) ---------- */
  if (p === '/api/hub/config' && m === 'GET') return sendJson(res, 200, { enabled: HUB.enabled, api: HUB.api, appId: HUB.appId });
  if (p === '/api/hub/session' && m === 'POST') {
    const ip = clientIp(req); if (limited('hub', ip, 30, 600000)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    hit('hub', ip);
    try {
      const b = await readJson(req, 4000), who = await resolveHubIdentity({ ticket: b.ticket, token: b.token });
      const { t, user } = hubProvision(who);
      return startTenantSession(req, res, t, user, { hub: { token: who.token, apps: who.apps, catalog: who.catalog, business: who.lab.name } });
    } catch (e) { if (e instanceof HubError) return sendJson(res, e.status, { error: e.message }); throw e; }
  }
  if (p === '/api/forgot' && m === 'POST') {
    const ip = clientIp(req); if (limited('forgot', ip, 5, 3600000)) return sendJson(res, 429, { error: 'Too many requests. Try again later.' });
    hit('forgot', ip); const b = await readJson(req), ws = String(b.workspace || '').trim().toLowerCase(), id = String(b.identifier || '').trim().toLowerCase();
    const t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(ws), ctx = t && t.status !== 'cancelled' ? tenantCtx(ws) : null;
    const u = ctx && id && ctx.db.prepare("SELECT * FROM users WHERE active = 1 AND email != '' AND (username = ? OR lower(email) = ?)").get(id, id);
    if (u) sendReset(req, t, u);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/token' && m === 'GET') {
    const row = pdb.prepare('SELECT * FROM tokens WHERE hash = ? AND expires > ?').get(sha(String(url.searchParams.get('t') || '')), Date.now()); if (!row) return sendJson(res, 404, { error: 'This link is invalid or has expired.' });
    const t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(row.tenant_id), ctx = t && tenantCtx(t.id), u = ctx && ctx.db.prepare('SELECT username, name FROM users WHERE id = ?').get(row.user_id);
    if (!u) return sendJson(res, 404, { error: 'This link is invalid or has expired.' });
    return sendJson(res, 200, { kind: row.kind, workspace: t.id, workspaceName: t.name, username: u.username, name: u.name });
  }
  if (p === '/api/token' && m === 'POST') {
    const ip = clientIp(req); if (limited('token', ip, 20, 600000)) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    hit('token', ip); const b = await readJson(req), pw = String(b.password || ''), row = pdb.prepare('SELECT * FROM tokens WHERE hash = ? AND expires > ?').get(sha(String(b.t || '')), Date.now());
    if (!row) return sendJson(res, 404, { error: 'This link is invalid or has expired.' });
    if (pw.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters for the password.' });
    const t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(row.tenant_id), ctx = t && tenantCtx(t.id), u = ctx && ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!u) return sendJson(res, 404, { error: 'This link is invalid or has expired.' });
    const salt = crypto.randomBytes(16).toString('hex'); ctx.db.prepare('UPDATE users SET salt = ?, hash = ?, active = 1 WHERE id = ?').run(salt, hashPw(pw, salt), u.id);
    pdb.prepare('DELETE FROM tokens WHERE tenant_id = ? AND user_id = ?').run(t.id, u.id); pdb.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(t.id, u.id);
    tenantAudit(ctx, u.username, row.kind === 'invite' ? 'Accepted the invite' : 'Reset own password', 'Account', u.id, null);
    if (t.status === 'suspended') return sendJson(res, 403, { error: 'This workspace is suspended. Contact the platform owner.' });
    return startTenantSession(req, res, t, u);
  }
  return null;
}

/* ================= tenant API ================= */
async function tenantApi(req, res, p, m, auth, url) {
  const { t, ctx, user } = auth, db = ctx.db;
  if (p === '/api/session' && m === 'GET') return sendJson(res, 200, { user: publicUser(user), workspace: wsInfo(t, ctx) });
  if (p === '/api/logout' && m === 'POST') { tenantAudit(ctx, user.username, 'Signed out', 'Account', null, null); pdb.prepare('DELETE FROM sessions WHERE token = ?').run(auth.token); return sendJson(res, 200, { ok: true }, setCookie(req, 'sid', '', 0)); }
  const blocked = m !== 'GET' && p !== '/api/password' ? writeBlock(t) : '';
  if (blocked) return sendJson(res, 423, { error: blocked, code: 'locked' });
  const plan = planOf(t.plan), over = (cur, max) => max >= 0 && cur >= max;

  if (p === '/api/account' && m === 'GET') return sendJson(res, 200, { workspace: wsInfo(t, ctx) });
  if (p === '/api/data' && m === 'GET') {
    const rows = db.prepare('SELECT col, data FROM records').all(), cols = {};
    for (const r of rows) if (can(user, r.col, 'r')) (cols[r.col] ||= []).push(JSON.parse(r.data));
    return sendJson(res, 200, { empty: rows.length === 0, seed: rows.length === 0 && !!t.sample && user.role === 'Super Admin', collections: cols, workspace: wsInfo(t, ctx) });
  }
  if (p === '/api/seed' && m === 'POST') {
    if (user.role !== 'Super Admin') return sendJson(res, 403, { error: 'Only a Super Admin can load sample data.' });
    if (!t.sample) return sendJson(res, 403, { error: 'This workspace was created without sample data.' });
    if (db.prepare('SELECT 1 FROM records LIMIT 1').get()) return sendJson(res, 409, { error: 'The workspace already has data' });
    let b; try { b = JSON.parse((await readBuf(req, 40_000_000)).toString('utf8')); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'Bad seed payload' }); }
    const ins = db.prepare('INSERT OR REPLACE INTO records (col, id, data, updated) VALUES (?, ?, ?, ?)'); let n = 0;
    db.exec('BEGIN');
    try { for (const col of Object.keys(b)) { if (!COLLECTIONS.has(col) || !Array.isArray(b[col])) continue; for (const o of b[col]) if (o && o.id !== undefined) { ins.run(col, String(o.id), JSON.stringify(o), Date.now()); n++; } } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    tenantAudit(ctx, user.username, 'Loaded sample data', 'System', null, n + ' records'); return sendJson(res, 200, { ok: true, count: n });
  }
  if (p === '/api/seed-modules' && m === 'POST') {
    /* sample data for the hospital modules (wards, beds, visits, queue, lab) in a workspace that already had data before they existed */
    if (user.role !== 'Super Admin') return sendJson(res, 403, { error: 'Only a Super Admin can load sample data.' });
    if (!t.sample) return sendJson(res, 403, { error: 'This workspace was created without sample data.' });
    if (db.prepare(`SELECT 1 FROM records WHERE col IN (${HOSPITAL_COLS.map(() => '?').join(',')}) LIMIT 1`).get(...HOSPITAL_COLS)) return sendJson(res, 409, { error: 'The hospital modules already have data' });
    let b; try { b = JSON.parse((await readBuf(req, 20_000_000)).toString('utf8')); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'Bad seed payload' }); }
    const ins = db.prepare('INSERT OR REPLACE INTO records (col, id, data, updated) VALUES (?, ?, ?, ?)'); let n = 0;
    db.exec('BEGIN');
    try { for (const col of HOSPITAL_COLS) { if (!Array.isArray(b[col])) continue; for (const o of b[col]) if (o && o.id !== undefined) { ins.run(col, String(o.id), JSON.stringify(o), Date.now()); n++; } } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    tenantAudit(ctx, user.username, 'Loaded sample data', 'System', null, n + ' hospital-module records'); return sendJson(res, 200, { ok: true, count: n });
  }
  if (p === '/api/opdq' && m === 'GET') {
    /* the waiting-room screen polls this small list instead of the whole data set */
    if (!can(user, 'opdq', 'r')) return sendJson(res, 403, { error: 'Your role cannot open the OPD queue.' });
    const date = String(url.searchParams.get('date') || '').slice(0, 10), rows = db.prepare("SELECT data FROM records WHERE col = 'opdq'" + (/^\d{4}-\d{2}-\d{2}$/.test(date) ? " AND json_extract(data, '$.date') = ?" : '')).all(...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? [date] : []));
    return sendJson(res, 200, { tokens: rows.map((r) => JSON.parse(r.data)), now: Date.now() });
  }
  if (p === '/api/password' && m === 'POST') {
    const b = await readJson(req), u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!checkPw(b.current, u)) return sendJson(res, 400, { error: 'Current password is wrong.' });
    const next = String(b.next || ''); if (next.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters.' });
    const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(next, salt), u.id);
    pdb.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(t.id, u.id); tenantAudit(ctx, user.username, 'Changed own password', 'Account', null, null);
    return sendJson(res, 200, { ok: true }, setCookie(req, 'sid', newSession(t.id, u.id), SESSION_MS / 1000));
  }
  if (p === '/api/files' && m === 'POST') {
    if (!can(user, 'appts', 'w') && !can(user, 'patients', 'w')) return sendJson(res, 403, { error: 'Your role cannot upload files.' });
    let buf; try { buf = await readBuf(req, MAX_FILE); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'File is larger than 10MB.' : 'Upload failed' }); }
    if (!buf.length) return sendJson(res, 400, { error: 'Empty file' });
    if (plan.max_storage_mb >= 0 && usageOf(ctx).storage + buf.length > plan.max_storage_mb * 1048576) return sendJson(res, 402, { error: `Your ${plan.name} plan has ${plan.max_storage_mb} MB of file storage and it is full.`, code: 'limit' });
    let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep */ }
    name = name.replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 160) || 'file'; const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(ctx.uploads, id), buf); db.prepare('INSERT INTO files (id, name, size, created) VALUES (?, ?, ?, ?)').run(id, name, buf.length, Date.now());
    return sendJson(res, 200, { id, name, size: buf.length });
  }
  const fm = p.match(/^\/api\/files\/([a-f0-9]{32})$/);
  if (fm) {
    if (!can(user, 'appts', 'r') && !can(user, 'patients', 'r')) return sendJson(res, 403, { error: 'Your role cannot open files.' });
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fm[1]); if (!row) return sendJson(res, 404, { error: 'Not found' });
    if (m === 'GET') { let data; try { data = fs.readFileSync(path.join(ctx.uploads, row.id)); } catch { return sendJson(res, 404, { error: 'Not found' }); } return send(res, 200, data, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'Cache-Control': 'private, no-store' }); }
    if (m === 'DELETE') { if (!can(user, 'appts', 'w') && !can(user, 'patients', 'w')) return sendJson(res, 403, { error: 'Your role cannot delete files.' }); db.prepare('DELETE FROM files WHERE id = ?').run(row.id); try { fs.unlinkSync(path.join(ctx.uploads, row.id)); } catch { /* gone */ } return sendJson(res, 200, { ok: true }); }
  }
  if (p === '/api/users' || p.startsWith('/api/users/') || p === '/api/audit' || p === '/api/backup') {
    if (user.role !== 'Super Admin') return sendJson(res, 403, { error: 'Only a Super Admin can do this.' });
    if (p === '/api/audit' && m === 'GET') return sendJson(res, 200, { rows: db.prepare('SELECT id, ts, user, action, area, ref, summary FROM audit ORDER BY id DESC LIMIT 1500').all() });
    if (p === '/api/backup' && m === 'POST') { const f = backupDb(db, path.join(ctx.dir, 'backups'), 'nexura'); tenantAudit(ctx, user.username, 'Backup', 'System', null, f); return sendJson(res, 200, { file: f }); }
    if (p === '/api/users' && m === 'GET') return sendJson(res, 200, { users: db.prepare('SELECT id, username, name, role, active, created, email FROM users ORDER BY id').all(), roles: ROLES, matrix: PERMS });
    const b = await readJson(req);
    const um = p.match(/^\/api\/users\/(\d+)(\/invite)?$/);
    if (p === '/api/users' && m === 'POST') {
      const username = String(b.username || '').trim().toLowerCase(), email = String(b.email || '').trim(), pw = String(b.password || ''), invite = !!b.invite;
      if (!okUser(username)) return sendJson(res, 400, { error: 'Username: 3 to 30 letters, numbers, dot, dash or underscore.' });
      if (!okName(b.name)) return sendJson(res, 400, { error: 'Enter the full name.' }); if (!ROLES.includes(b.role)) return sendJson(res, 400, { error: 'Choose a role.' });
      if (email && !okEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
      if (invite && !email) return sendJson(res, 400, { error: 'Enter an email address to send an invite.' });
      if (!invite && pw.length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters for the password.' });
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return sendJson(res, 409, { error: 'That username is taken.' });
      if (over(usageOf(ctx).users, plan.max_users)) return sendJson(res, 402, { error: `Your ${plan.name} plan allows ${plan.max_users} users. Upgrade to add more.`, code: 'limit' });
      const salt = crypto.randomBytes(16).toString('hex'), r = db.prepare('INSERT INTO users (username, name, role, salt, hash, active, created, email) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(username, b.name.trim(), b.role, salt, hashPw(invite ? randPw() : pw, salt), Date.now(), email);
      tenantAudit(ctx, user.username, invite ? 'Invited user' : 'Created user', 'Users', r.lastInsertRowid, `${username} (${b.role})`);
      if (invite) sendInvite(req, t, { id: Number(r.lastInsertRowid), name: b.name.trim(), role: b.role, email, username }, user.name);
      return sendJson(res, 200, { ok: true, invited: invite });
    }
    if (um && um[2] && m === 'POST') {
      const tu = db.prepare('SELECT * FROM users WHERE id = ?').get(+um[1]); if (!tu) return sendJson(res, 404, { error: 'Not found' });
      if (!tu.email) return sendJson(res, 400, { error: 'This user has no email address. Edit the user and add one.' });
      sendInvite(req, t, tu, user.name); tenantAudit(ctx, user.username, 'Sent invite', 'Users', tu.id, tu.username); return sendJson(res, 200, { ok: true });
    }
    if (um && m === 'PUT') {
      const tu = db.prepare('SELECT * FROM users WHERE id = ?').get(+um[1]); if (!tu) return sendJson(res, 404, { error: 'Not found' });
      const activeSA = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'Super Admin' AND active = 1").get().n;
      const name = b.name === undefined ? tu.name : b.name, role = b.role === undefined ? tu.role : b.role, active = b.active === undefined ? tu.active : (b.active ? 1 : 0), email = b.email === undefined ? tu.email : String(b.email).trim();
      if (!okName(name)) return sendJson(res, 400, { error: 'Enter the full name.' }); if (!ROLES.includes(role)) return sendJson(res, 400, { error: 'Choose a role.' });
      if (email && !okEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
      if (tu.id === user.id && (!active || role !== 'Super Admin')) return sendJson(res, 400, { error: 'You cannot lock yourself out. Ask another Super Admin.' });
      if (tu.role === 'Super Admin' && tu.active === 1 && (role !== 'Super Admin' || !active) && activeSA <= 1) return sendJson(res, 400, { error: 'There must be at least one active Super Admin.' });
      if (active && !tu.active && over(usageOf(ctx).users, plan.max_users)) return sendJson(res, 402, { error: `Your ${plan.name} plan allows ${plan.max_users} users. Upgrade to unlock more.`, code: 'limit' });
      db.prepare('UPDATE users SET name = ?, role = ?, active = ?, email = ? WHERE id = ?').run(name.trim(), role, active, email, tu.id);
      if (!active || role !== tu.role) pdb.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(t.id, tu.id);
      if (b.password !== undefined && b.password !== '') { if (String(b.password).length < 8) return sendJson(res, 400, { error: 'Use at least 8 characters for the password.' }); const salt = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hashPw(String(b.password), salt), tu.id); pdb.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(t.id, tu.id); tenantAudit(ctx, user.username, 'Reset password', 'Users', tu.id, tu.username); }
      tenantAudit(ctx, user.username, 'Updated user', 'Users', tu.id, `${tu.username}: ${role}${active ? '' : ', locked'}`); return sendJson(res, 200, { ok: true });
    }
  }
  const rec = p.match(/^\/api\/records\/([a-z]+)\/([^/]{1,120})$/);
  if (rec && COLLECTIONS.has(rec[1])) {
    const col = rec[1], id = decodeURIComponent(rec[2]);
    if (!can(user, col, 'w')) return sendJson(res, 403, { error: 'Your role cannot change ' + AREA[col].toLowerCase() + '.' });
    if (m === 'PUT') {
      let b; try { b = JSON.parse((await readBuf(req, 12_000_000)).toString('utf8')); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'Bad record' }); }
      if (!b || typeof b !== 'object' || Array.isArray(b) || String(b.id) !== id) return sendJson(res, 400, { error: 'Record id mismatch' });
      const existed = db.prepare('SELECT 1 FROM records WHERE col = ? AND id = ?').get(col, id);
      if (col === 'kv' && id === 'currency' && user.role !== 'Super Admin') return sendJson(res, 403, { error: 'Only a Super Admin can change the currency.' });
      if (col === 'kv' && id === 'currency' && !/^[A-Z]{2,5}$/.test(String(b.v))) return sendJson(res, 400, { error: 'Use a currency code such as PKR or USD.' });
      const rule = RULES[col], ruleErr = rule ? rule(db, id, b) : ''; if (ruleErr) return sendJson(res, 409, { error: ruleErr });
      if (!existed && col === 'patients' && over(usageOf(ctx).patients, plan.max_patients)) return sendJson(res, 402, { error: `Your ${plan.name} plan allows ${plan.max_patients} patients. Upgrade to add more.`, code: 'limit' });
      db.prepare('INSERT OR REPLACE INTO records (col, id, data, updated) VALUES (?, ?, ?, ?)').run(col, id, JSON.stringify(b), Date.now());
      if (col !== 'kv') tenantAudit(ctx, user.username, existed ? 'Updated' : 'Created', AREA[col], id, b.name || b.patient || (b.status ? col + ' ' + id + ' (' + b.status + ')' : col + ' ' + id));
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const old = db.prepare('SELECT data FROM records WHERE col = ? AND id = ?').get(col, id); if (!old) return sendJson(res, 200, { ok: true }); let nm = col + ' ' + id; try { const o = JSON.parse(old.data); nm = o.name || o.patient || nm; } catch { /* keep */ }
      db.prepare('DELETE FROM records WHERE col = ? AND id = ?').run(col, id); if (col !== 'kv') tenantAudit(ctx, user.username, 'Deleted', AREA[col], id, nm); return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

/* ================= platform owner API ================= */
const STATUSES = ['trial', 'active', 'suspended', 'cancelled'];
async function platformApi(req, res, p, m) {
  const q = p.slice('/api/platform'.length) || '/';
  if (q === '/state' && m === 'GET') return sendJson(res, 200, { needsSetup: !pdb.prepare('SELECT 1 FROM owners LIMIT 1').get(), owner: ownerAuth(req) });
  if (q === '/setup' && m === 'POST') {
    if (pdb.prepare('SELECT 1 FROM owners LIMIT 1').get()) return sendJson(res, 409, { error: 'The platform owner already exists.' });
    const b = await readJson(req), username = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!okName(b.name)) return sendJson(res, 400, { error: 'Enter your full name.' }); if (!okUser(username)) return sendJson(res, 400, { error: 'Username: 3 to 30 letters, numbers, dot, dash or underscore.' }); if (pw.length < 10) return sendJson(res, 400, { error: 'Use at least 10 characters for the owner password.' });
    const salt = crypto.randomBytes(16).toString('hex'), r = pdb.prepare('INSERT INTO owners (username, name, email, salt, hash) VALUES (?, ?, ?, ?, ?)').run(username, b.name.trim(), String(b.email || '').trim(), salt, hashPw(pw, salt));
    paudit(username, 'Created the platform owner', r.lastInsertRowid, null);
    const tok = crypto.randomBytes(32).toString('hex'); pdb.prepare('INSERT INTO owner_sessions (token, owner_id, expires) VALUES (?, ?, ?)').run(sha(tok), r.lastInsertRowid, Date.now() + SESSION_MS);
    return sendJson(res, 200, { owner: { username, name: b.name.trim() } }, setCookie(req, 'psid', tok, SESSION_MS / 1000));
  }
  if (q === '/login' && m === 'POST') {
    const ip = clientIp(req); if (limited('plogin', ip, 6, 600000)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readJson(req), o = pdb.prepare('SELECT * FROM owners WHERE username = ?').get(String(b.username || '').trim().toLowerCase());
    if (!o || !o.active || !checkPw(b.password, o)) { hit('plogin', ip); paudit(String(b.username || '?').slice(0, 40), 'Failed owner sign-in', null, null); return sendJson(res, 401, { error: 'Wrong username or password.' }); }
    const tok = crypto.randomBytes(32).toString('hex'); pdb.prepare('INSERT INTO owner_sessions (token, owner_id, expires) VALUES (?, ?, ?)').run(sha(tok), o.id, Date.now() + SESSION_MS); paudit(o.username, 'Owner signed in', null, null);
    return sendJson(res, 200, { owner: { username: o.username, name: o.name } }, setCookie(req, 'psid', tok, SESSION_MS / 1000));
  }
  const owner = ownerAuth(req); if (!owner) return sendJson(res, 401, { error: 'Not signed in' });
  if (q === '/logout' && m === 'POST') { pdb.prepare('DELETE FROM owner_sessions WHERE token = ?').run(sha(cookies(req).psid || '')); return sendJson(res, 200, { ok: true }, setCookie(req, 'psid', '', 0)); }
  if (q === '/overview' && m === 'GET') {
    const plans = pdb.prepare('SELECT * FROM plans ORDER BY sort').all(), pmap = Object.fromEntries(plans.map((x) => [x.id, x]));
    const tenants = pdb.prepare('SELECT * FROM tenants ORDER BY created DESC').all().map((t) => { const ctx = t.status === 'cancelled' ? null : tenantCtx(t.id), u = ctx ? usageOf(ctx) : { users: 0, patients: 0, storage: 0 }; return { id: t.id, name: t.name, plan: t.plan, status: t.status, trialDaysLeft: trialLeft(t), created: t.created, lastActive: t.last_active, ownerEmail: t.owner_email, notes: t.notes, sample: !!t.sample, usage: u }; });
    const mrr = tenants.filter((t) => t.status === 'active').reduce((s, t) => s + (pmap[t.plan] ? pmap[t.plan].price : 0), 0);
    return sendJson(res, 200, { tenants, plans, stats: { total: tenants.length, trial: tenants.filter((t) => t.status === 'trial').length, active: tenants.filter((t) => t.status === 'active').length, suspended: tenants.filter((t) => t.status === 'suspended').length, mrr, currency: plans[0] ? plans[0].currency : 'EGP' }, mail: { configured: !!mailConfig() } });
  }
  const tm = q.match(/^\/tenants\/([a-z0-9-]+)(\/reset-admin)?$/);
  if (tm) {
    const t = pdb.prepare('SELECT * FROM tenants WHERE id = ?').get(tm[1]); if (!t) return sendJson(res, 404, { error: 'Not found' });
    if (tm[2] && m === 'POST') {
      const ctx = tenantCtx(t.id); if (!ctx) return sendJson(res, 404, { error: 'Workspace data not found' });
      let u = ctx.db.prepare("SELECT * FROM users WHERE role = 'Super Admin' ORDER BY active DESC, id LIMIT 1").get(), pw = randPw(), salt = crypto.randomBytes(16).toString('hex');
      if (u) ctx.db.prepare('UPDATE users SET salt = ?, hash = ?, active = 1 WHERE id = ?').run(salt, hashPw(pw, salt), u.id);
      else { const r = ctx.db.prepare("INSERT INTO users (username, name, role, salt, hash, active, created, email) VALUES ('admin', 'Administrator', 'Super Admin', ?, ?, 1, ?, ?)").run(salt, hashPw(pw, salt), Date.now(), t.owner_email); u = { id: r.lastInsertRowid, username: 'admin' }; }
      pdb.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').run(t.id, u.id); paudit(owner.username, 'Reset the workspace Super Admin', t.id, u.username); tenantAudit(ctx, 'platform', 'Super Admin password reset by the platform owner', 'Users', u.id, u.username);
      return sendJson(res, 200, { username: u.username, password: pw });
    }
    if (m === 'PUT') {
      const b = await readJson(req), upd = {};
      if (b.plan !== undefined) { if (!pdb.prepare('SELECT 1 FROM plans WHERE id = ?').get(b.plan)) return sendJson(res, 400, { error: 'Unknown plan.' }); upd.plan = b.plan; }
      if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return sendJson(res, 400, { error: 'Unknown status.' }); upd.status = b.status; }
      if (b.addTrialDays !== undefined) { const d = Math.max(-365, Math.min(365, Math.round(+b.addTrialDays || 0))); upd.trial_ends = Math.max(Date.now(), t.trial_ends) + d * 86400000; if (upd.status === undefined && d > 0 && t.status !== 'trial') upd.status = 'trial'; }
      if (b.notes !== undefined) upd.notes = String(b.notes).slice(0, 500);
      const keys = Object.keys(upd); if (!keys.length) return sendJson(res, 400, { error: 'Nothing to change.' });
      pdb.prepare(`UPDATE tenants SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => upd[k]), t.id);
      if (upd.status === 'suspended' || upd.status === 'cancelled') pdb.prepare('DELETE FROM sessions WHERE tenant_id = ?').run(t.id);
      paudit(owner.username, 'Updated workspace', t.id, keys.map((k) => k + '=' + (k === 'trial_ends' ? new Date(upd[k]).toISOString().slice(0, 10) : upd[k])).join(', ').slice(0, 180)); return sendJson(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const b = await readJson(req); if (b.confirm !== t.id) return sendJson(res, 400, { error: 'Type the workspace code to confirm.' });
      closeTenant(t.id); fs.rmSync(path.join(TENANTS_DIR, t.id), { recursive: true, force: true });
      pdb.prepare('DELETE FROM tenants WHERE id = ?').run(t.id); pdb.prepare('DELETE FROM sessions WHERE tenant_id = ?').run(t.id); pdb.prepare('DELETE FROM tokens WHERE tenant_id = ?').run(t.id); paudit(owner.username, 'Deleted workspace', t.id, t.name); return sendJson(res, 200, { ok: true });
    }
  }
  const pm = q.match(/^\/plans\/([a-z0-9-]+)$/);
  if (pm && m === 'PUT') {
    const b = await readJson(req), cur = pdb.prepare('SELECT * FROM plans WHERE id = ?').get(pm[1]); if (!cur) return sendJson(res, 404, { error: 'Not found' });
    const n = { name: String(b.name ?? cur.name).trim().slice(0, 30), price: Math.max(0, Math.round(+(b.price ?? cur.price))), currency: String(b.currency ?? cur.currency).trim().slice(0, 5) || 'EGP', max_users: Math.round(+(b.max_users ?? cur.max_users)), max_patients: Math.round(+(b.max_patients ?? cur.max_patients)), max_storage_mb: Math.round(+(b.max_storage_mb ?? cur.max_storage_mb)), blurb: String(b.blurb ?? cur.blurb).trim().slice(0, 120) };
    if (!n.name || [n.price, n.max_users, n.max_patients, n.max_storage_mb].some((x) => !Number.isFinite(x))) return sendJson(res, 400, { error: 'Check the plan values.' });
    pdb.prepare('UPDATE plans SET name = ?, price = ?, currency = ?, max_users = ?, max_patients = ?, max_storage_mb = ?, blurb = ? WHERE id = ?').run(n.name, n.price, n.currency, n.max_users, n.max_patients, n.max_storage_mb, n.blurb, cur.id);
    paudit(owner.username, 'Edited plan', cur.id, `${n.name}: ${n.price} ${n.currency}`); return sendJson(res, 200, { ok: true });
  }
  if (q === '/outbox' && m === 'GET') return sendJson(res, 200, { rows: pdb.prepare('SELECT id, ts, tenant_id, to_addr, subject, body, status, error FROM outbox ORDER BY id DESC LIMIT 200').all() });
  if (q === '/audit' && m === 'GET') return sendJson(res, 200, { rows: pdb.prepare('SELECT * FROM paudit ORDER BY id DESC LIMIT 500').all() });
  if (q === '/backup' && m === 'POST') { const r = backupAll(); paudit(owner.username, 'Backed up everything', null, r.length + ' databases'); return sendJson(res, 200, { files: r }); }
  return sendJson(res, 404, { error: 'Not found' });
}

/* ================= router ================= */
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  if (m !== 'GET') {
    const isUpload = p === '/api/files' && m === 'POST';
    if (isUpload ? req.headers['x-requested-with'] !== 'nexura' : !(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: isUpload ? 'Upload header missing' : 'JSON required' });
    const origin = req.headers.origin; if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return sendJson(res, 403, { error: 'Bad origin' });
  }
  if (p.startsWith('/api/platform')) return platformApi(req, res, p, m);
  const pub = await publicApi(req, res, p, m, url); if (pub !== null) return pub;
  const auth = tenantAuth(req);
  if (!auth) return sendJson(res, 401, { error: 'Not signed in' });
  if (auth.t.status === 'suspended') return sendJson(res, 403, { error: 'This workspace is suspended. Contact the platform owner.', code: 'suspended' });
  return tenantApi(req, res, p, m, auth, url);
}

/* Google AdSense (public marketing pages only; never inside /app, /signup or /platform).
   Set ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX (and ADSENSE_SLOT_HOME=<ad unit id>) in the environment. Empty = no ads, no Google scripts, no ads.txt. */
const ADSENSE_CLIENT = /^ca-pub-\d{6,20}$/.test(process.env.ADSENSE_CLIENT || '') ? process.env.ADSENSE_CLIENT : '';
const ADS = { client: ADSENSE_CLIENT, slots: { home: /^\d{6,20}$/.test(process.env.ADSENSE_SLOT_HOME || '') ? process.env.ADSENSE_SLOT_HOME : '' } };
function sendAdsTxt(req, res) {
  if (!ADSENSE_CLIENT) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  return send(res, 200, req.method === 'HEAD' ? undefined : `google.com, ${ADSENSE_CLIENT.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=3600' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const p = url.pathname; let rel = null;
  if (p === '/ads.txt') return sendAdsTxt(req, res);
  if (p === '/ads-config.js') return send(res, 200, req.method === 'HEAD' ? undefined : `window.OPTIX_ADS=${JSON.stringify(ADS).replace(/</g, '\\u003c')};`, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (p === '/') rel = 'site/index.html'; else if (p === '/app' || p === '/app/') rel = 'index.html'; else if (p === '/signup') rel = 'site/signup.html'; else if (p === '/platform' || p === '/platform/') rel = 'site/platform.html';
  else if (p === '/privacy' || p === '/privacy/') rel = 'site/privacy.html'; else if (p === '/terms' || p === '/terms/') rel = 'site/terms.html';
  else if (/^\/assets\/[\w.-]+$/.test(p)) rel = p.slice(1); else if (/^\/site\/[\w./-]+$/.test(p) && !p.includes('..')) rel = p.slice(1);
  if (!rel) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file), headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : (/^\.(jpg|jpeg|png|webp|woff2|mjs)$/.test(ext) || rel.startsWith('site/vendor/') ? 'max-age=86400' : 'max-age=3600') };
    /* text files travel compressed: the server link can be slow (CSS, JS and HTML compress well) */
    if (/^\.(html|css|js|mjs|json|svg|txt)$/.test(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && req.method !== 'HEAD') { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; buf = gzipCached(file, buf); }
    send(res, 200, req.method === 'HEAD' ? undefined : buf, headers);
  });
}

/* ================= command line ================= */
if (process.argv.includes('--backup')) { console.log('Backups written:\n  ' + backupAll().join('\n  ')); process.exit(0); }
if (process.argv.includes('--reset-owner-password')) {
  const o = pdb.prepare('SELECT * FROM owners ORDER BY id LIMIT 1').get(); if (!o) { console.error('No platform owner yet. Open /platform in the browser and create one.'); process.exit(1); }
  const pw = process.env.OWNER_PASSWORD || randPw() + randPw(), salt = crypto.randomBytes(16).toString('hex'); pdb.prepare('UPDATE owners SET salt = ?, hash = ?, active = 1 WHERE id = ?').run(salt, hashPw(pw, salt), o.id); pdb.prepare('DELETE FROM owner_sessions WHERE owner_id = ?').run(o.id);
  console.log(`\nPlatform owner password reset.\n  Username: ${o.username}\n  Password: ${pw}\n`); process.exit(0);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, 'Misdirected request', { 'Content-Type': 'text/plain' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && (e.code === 413 || e.code === 400)) return sendJson(res, e.code, { error: e.code === 413 ? 'Request too large' : 'Bad request' });
    console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  }
});
try { console.log('Backups written: ' + backupAll().length + ' databases'); } catch (e) { console.error('backup failed', e.message); }
setInterval(() => { try { backupAll(); } catch (e) { console.error('backup failed', e.message); } }, 24 * 3600 * 1000).unref();
server.listen(PORT, HOST, () => console.log(`Optix Medical Sync is running at http://localhost:${PORT}  (data: ${DATA_DIR})`));
const stop = () => { server.close(); for (const c of cache.values()) try { c.db.close(); } catch { /* ignore */ } try { pdb.close(); } catch { /* ignore */ } process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
