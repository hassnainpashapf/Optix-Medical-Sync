/* Hospital modules on the server: the role matrix for the new collections, tenant isolation, backup, seed, and the rules the server enforces
   (a bed cannot be double-occupied, a queue token number is unique per doctor and day). Runs a throw-away copy of the server, no network. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-mod-'));
const PORT = 4300 + Math.floor(Math.random() * 400), B = `http://127.0.0.1:${PORT}`;
let srv;
const NEW = ['wards', 'beds', 'admissions', 'visits', 'opdq', 'labtests', 'labs'];
const ROLES = { admin: 'Super Admin', doctor: 'Doctor', reception: 'Receptionist', accounts: 'Accountant', pharmacy: 'Pharmacist' };
/* expected access: rw, r or '' (none) */
const EXPECT = {
  'Super Admin': { wards: 'rw', beds: 'rw', admissions: 'rw', visits: 'rw', opdq: 'rw', labtests: 'rw', labs: 'rw' },
  Doctor: { wards: 'rw', beds: 'rw', admissions: 'rw', visits: 'rw', opdq: 'rw', labtests: 'rw', labs: 'rw' },
  Receptionist: { wards: 'rw', beds: 'rw', admissions: 'rw', visits: 'r', opdq: 'rw', labtests: 'rw', labs: 'rw' },
  Accountant: { wards: 'r', beds: 'r', admissions: 'r', visits: '', opdq: '', labtests: 'r', labs: 'r' },
  Pharmacist: { wards: 'r', beds: 'r', admissions: 'r', visits: 'r', opdq: '', labtests: '', labs: '' },
};

async function call(method, p, body, cookie) {
  const r = await fetch(B + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const put = (col, rec, cookie) => call('PUT', `/api/records/${col}/${encodeURIComponent(rec.id)}`, rec, cookie);
const sample = (col) => ({ id: `t-${col}`, name: `Test ${col}`, patient: 'Test Patient', status: 'free', date: '2026-01-01', docId: 9, no: Math.floor(Math.random() * 1e6) });
const jar = {};
let jar2 = '';

before(async () => {
  srv = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_HOSTS: `127.0.0.1:${PORT}`, HUB_DISABLED: '1' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/plans')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const su = await call('POST', '/api/signup', { hospital: 'Alpha Care', workspace: 'alpha-care', name: 'Alpha Admin', email: 'a@alpha.test', username: 'admin', password: 'password123', sample: true });
  assert.equal(su.s, 200); jar.admin = su.cookie;
  for (const u of ['doctor', 'reception', 'accounts', 'pharmacy']) {
    const r = await call('POST', '/api/users', { username: u, name: 'Test ' + ROLES[u], role: ROLES[u], password: 'password123', invite: false }, jar.admin); assert.equal(r.s, 200, u);
    const l = await call('POST', '/api/login', { workspace: 'alpha-care', username: u, password: 'password123' }); assert.equal(l.s, 200, 'login ' + u); jar[u] = l.cookie;
  }
  const s2 = await call('POST', '/api/signup', { hospital: 'Beta Care', workspace: 'beta-care', name: 'Beta Admin', email: 'b@beta.test', username: 'admin', password: 'password123', sample: true });
  assert.equal(s2.s, 200); jar2 = s2.cookie;
});
after(() => { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('the new collections are in every role matrix exactly as designed (write and read)', async () => {
  for (const [u, role] of Object.entries(ROLES)) {
    for (const col of NEW) {
      const exp = EXPECT[role][col], w = await put(col, sample(col + '-' + u), jar[u]);
      if (exp === 'rw') assert.equal(w.s, 200, `${role} should write ${col} (got ${w.s})`); else assert.equal(w.s, 403, `${role} must not write ${col} (got ${w.s})`);
    }
  }
  /* admin wrote one record of every collection as every role that may; now check what each role can read */
  for (const col of NEW) assert.equal((await put(col, { ...sample(col), id: 'seed-' + col }, jar.admin)).s, 200);
  for (const [u, role] of Object.entries(ROLES)) {
    const d = await call('GET', '/api/data', undefined, jar[u]); assert.equal(d.s, 200);
    for (const col of NEW) {
      const has = (d.j.collections[col] || []).length > 0, exp = EXPECT[role][col];
      assert.equal(has, exp !== '', `${role} reading ${col}: expected ${exp || 'nothing'}`);
    }
    const sess = await call('GET', '/api/session', undefined, jar[u]); for (const col of NEW) assert.equal(sess.j.user.perms[col] || '', EXPECT[role][col], `${role} perms.${col} sent to the page`);
  }
});

test('unknown collections are rejected and the audit log names the new areas', async () => {
  assert.equal((await call('PUT', '/api/records/payroll/x', { id: 'x' }, jar.admin)).s, 404);
  const a = await call('GET', '/api/audit', undefined, jar.admin), areas = new Set(a.j.rows.map((r) => r.area));
  for (const n of ['Wards', 'Beds', 'Admissions', 'Consultations', 'OPD queue', 'Lab catalog', 'Lab orders']) assert.ok(areas.has(n), 'audit area ' + n);
});

test('a bed cannot be occupied twice and a patient cannot be admitted twice (server rule)', async () => {
  const mk = (id, pid, bedId, status = 'admitted') => ({ id, pid, patient: 'P' + pid, bedId, status, admitAt: '2026-01-01 10:00' });
  assert.equal((await put('admissions', mk('adm-a', 1, 'bed-x'), jar.reception)).s, 200);
  const dup = await put('admissions', mk('adm-b', 2, 'bed-x'), jar.doctor); assert.equal(dup.s, 409); assert.match(dup.j.error, /occupied/);
  const same = await put('admissions', mk('adm-c', 1, 'bed-y'), jar.doctor); assert.equal(same.s, 409); assert.match(same.j.error, /already admitted/);
  assert.equal((await put('admissions', mk('adm-a', 1, 'bed-x'), jar.reception)).s, 200, 'saving the same admission again is fine');
  assert.equal((await put('admissions', mk('adm-b', 2, 'bed-y'), jar.doctor)).s, 200, 'another bed is fine');
  assert.equal((await put('admissions', mk('adm-a', 1, 'bed-x', 'discharged'), jar.reception)).s, 200);
  assert.equal((await put('admissions', mk('adm-d', 3, 'bed-x'), jar.reception)).s, 200, 'the bed is free after discharge');
});

test('queue token numbers are unique per doctor and day; the waiting-room list is role-gated and filtered by day', async () => {
  const t = (id, docId, no, date = '2026-05-01') => ({ id, docId, no, date, patient: 'P', status: 'waiting' });
  assert.equal((await put('opdq', t('q1', 5, 1), jar.reception)).s, 200);
  const dup = await put('opdq', t('q2', 5, 1), jar.doctor); assert.equal(dup.s, 409);
  assert.equal((await put('opdq', t('q2', 6, 1), jar.doctor)).s, 200, 'another doctor can have number 1');
  assert.equal((await put('opdq', t('q3', 5, 1, '2026-05-02'), jar.doctor)).s, 200, 'another day can have number 1');
  assert.equal((await put('opdq', t('q1', 5, 1), jar.reception)).s, 200, 'updating a token keeps its number');
  const list = await call('GET', '/api/opdq?date=2026-05-01', undefined, jar.reception); assert.equal(list.s, 200); assert.equal(list.j.tokens.filter((x) => x.date === '2026-05-01').length, 2); assert.ok(list.j.tokens.every((x) => x.date === '2026-05-01'));
  assert.equal((await call('GET', '/api/opdq', undefined, jar.accounts)).s, 403);
  assert.equal((await call('GET', '/api/opdq', undefined, jar.pharmacy)).s, 403);
  assert.equal((await call('GET', '/api/opdq', undefined, undefined)).s, 401);
});

test('cross-tenant isolation: another hospital never sees or changes these records', async () => {
  const d1 = await call('GET', '/api/data', undefined, jar.admin), d2 = await call('GET', '/api/data', undefined, jar2);
  assert.ok((d1.j.collections.wards || []).length > 0);
  for (const col of NEW) assert.equal((d2.j.collections[col] || []).length, 0, 'beta must not see alpha ' + col);
  assert.equal((await put('wards', { id: 'beta-only', name: 'Beta Ward', rate: 1 }, jar2)).s, 200);
  const again = await call('GET', '/api/data', undefined, jar.admin); assert.ok(!(again.j.collections.wards || []).some((w) => w.id === 'beta-only'), 'alpha must not see the beta ward');
  /* the same bed id in two hospitals is not a clash */
  assert.equal((await put('admissions', { id: 'adm-z', pid: 1, patient: 'Beta Patient', bedId: 'bed-x', status: 'admitted', admitAt: '2026-01-01 10:00' }, jar2)).s, 200);
});

test('backup contains the new collections (and the file opens as a normal database to restore from)', async () => {
  const r = await call('POST', '/api/backup', {}, jar.admin); assert.equal(r.s, 200); assert.match(r.j.file, /^nexura-\d{8}-\d{4}\.db$/);
  const db = new DatabaseSync(path.join(dataDir, 'tenants', 'alpha-care', 'backups', r.j.file), { readOnly: true });
  const cols = new Set(db.prepare('SELECT DISTINCT col FROM records').all().map((x) => x.col));
  for (const c of NEW) assert.ok(cols.has(c), 'backup holds ' + c);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE col = 'wards'").get().n >= 2, true); db.close();
  assert.equal((await call('POST', '/api/backup', {}, jar.doctor)).s, 403, 'only a Super Admin backs up');
});

test('sample data: the seed accepts the new collections; modules can be loaded into a workspace that already had data', async () => {
  /* fresh sample workspace, as the page does it */
  const su = await call('POST', '/api/signup', { hospital: 'Gamma Care', workspace: 'gamma-care', name: 'Gamma Admin', email: 'g@gamma.test', username: 'admin', password: 'password123', sample: true }); assert.equal(su.s, 200);
  const body = { patients: [{ id: 1, name: 'P1' }], wards: [{ id: 'wd1', name: 'W', rate: 100 }], beds: [{ id: 'bd1', wardId: 'wd1', no: '1' }], admissions: [{ id: 'adm1', pid: 1, patient: 'P1', bedId: 'bd1', status: 'admitted' }], visits: [{ id: 'v1', pid: 1 }], opdq: [{ id: 'q1', docId: 1, no: 1, date: '2026-01-01' }], labtests: [{ id: 'lt1', name: 'CBC' }], labs: [{ id: 'lb1', pid: 1 }] };
  const seed = await call('POST', '/api/seed', body, su.cookie); assert.equal(seed.s, 200); assert.equal(seed.j.count, 8);
  const d = await call('GET', '/api/data', undefined, su.cookie); for (const col of NEW) assert.equal(d.j.collections[col].length, 1, col);
  assert.equal((await call('POST', '/api/seed', body, su.cookie)).s, 409, 'seeding twice is refused');
  /* a workspace with older data but no hospital modules */
  const d2 = await call('POST', '/api/signup', { hospital: 'Delta Care', workspace: 'delta-care', name: 'Delta Admin', email: 'd@delta.test', username: 'admin', password: 'password123', sample: true }); assert.equal(d2.s, 200);
  assert.equal((await call('POST', '/api/seed', { patients: [{ id: 1, name: 'Old' }] }, d2.cookie)).s, 200);
  const mod = await call('POST', '/api/seed-modules', { wards: body.wards, beds: body.beds, appts: [{ id: 99 }] }, d2.cookie); assert.equal(mod.s, 200); assert.equal(mod.j.count, 2, 'only the hospital collections are taken');
  assert.equal((await call('POST', '/api/seed-modules', body, d2.cookie)).s, 409);
  const dd = await call('GET', '/api/data', undefined, d2.cookie); assert.equal(dd.j.collections.patients.length, 1); assert.equal((dd.j.collections.appts || []).length, 0);
  /* only a Super Admin of a sample workspace */
  const u = await call('POST', '/api/users', { username: 'rec', name: 'Rec', role: 'Receptionist', password: 'password123', invite: false }, d2.cookie); assert.equal(u.s, 200);
  const l = await call('POST', '/api/login', { workspace: 'delta-care', username: 'rec', password: 'password123' });
  assert.equal((await call('POST', '/api/seed-modules', body, l.cookie)).s, 403);
});

test('the Users page gets the role matrix from the server, so what it shows is what is enforced', async () => {
  const u = await call('GET', '/api/users', undefined, jar.admin); assert.equal(u.s, 200);
  for (const [role, perms] of Object.entries(EXPECT)) for (const col of NEW) assert.equal(u.j.matrix[role][col] || '', perms[col], `${role} ${col}`);
  assert.equal((await call('GET', '/api/users', undefined, jar.doctor)).s, 403);
});
