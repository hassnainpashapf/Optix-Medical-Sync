/* Signing in with the Optix account: ticket / token from the hub -> workspace + user here. Runs a fake hub and a throw-away copy of the server. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-hub-'));
const PORT = 3400 + Math.floor(Math.random() * 400), HUBPORT = PORT + 500;
const B = `http://127.0.0.1:${PORT}`;
const lab = { id: 'biz1', slug: 'city-care', name: 'City Care Hospital', status: 'active' };
const catalog = [{ id: 'hospital', name: 'Hospital', sub: '', color: '#0ea5a4', icon: 'users', roles: [] }, { id: 'lab', name: 'Blood Test Lab', sub: '', color: '#0ea5a4', icon: 'flask', roles: [] }];
const people = {
  'tok-admin': { user: { id: 'U-1', name: 'Dr Admin', username: 'admin', email: 'a@city.pk', role: 'admin' }, apps: ['lab', 'hospital'], lab },
  'tok-doc': { user: { id: 'U-2', name: 'Dr Sara', username: 'sara', role: 'reception', appRoles: { hospital: 'DOCTOR' } }, apps: ['hospital'], lab },
  'tok-staff': { user: { id: 'U-3', name: 'Front Desk', username: 'desk', role: 'reception' }, apps: ['hospital'], lab },
  'tok-labonly': { user: { id: 'U-4', name: 'Lab Tech', username: 'tech', role: 'technician' }, apps: ['lab'], lab },
  'tok-expired': { user: { id: 'U-5', name: 'Old', username: 'old', role: 'admin' }, apps: ['hospital'], lab: { ...lab, id: 'biz2', slug: 'old-co', status: 'expired' } },
  'tok-other-admin': { user: { id: 'U-6', name: 'Other Admin', username: 'admin', role: 'admin' }, apps: ['hospital'], lab: { ...lab, id: 'biz3', slug: 'city-care', name: 'City Care Two' } },
};
const tickets = { 'ticket-admin': 'tok-admin', 'ticket-doc': 'tok-doc' };
let hub, srv;

before(async () => {
  hub = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const data = body ? JSON.parse(body) : {};
      const tok = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
      if (req.url === '/api/sso/exchange') { const t = tickets[data.ticket]; delete tickets[data.ticket]; return t ? send(200, { ok: true, token: t, ...people[t], catalog, app: 'hospital' }) : send(401, { error: 'expired' }); }
      if (req.url === '/api/auth/whoami') return people[tok] ? send(200, { ok: true, ...people[tok], catalog }) : send(401, { error: 'auth' });
      send(404, {});
    });
  });
  await new Promise((r) => hub.listen(HUBPORT, '127.0.0.1', r));
  srv = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_HOSTS: `127.0.0.1:${PORT}`, HUB_API: `http://127.0.0.1:${HUBPORT}`, HUB_APP_ID: 'hospital' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/plans')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
});
after(() => { srv.kill(); hub.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const post = async (body, cookie) => {
  const r = await fetch(B + '/api/hub/session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const get = async (p, cookie) => { const r = await fetch(B + p, { headers: { Cookie: cookie } }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

test('config tells the page where the hub is', async () => {
  const j = await (await fetch(B + '/api/hub/config')).json();
  assert.equal(j.enabled, true); assert.equal(j.appId, 'hospital'); assert.equal(j.api, `http://127.0.0.1:${HUBPORT}`);
});

test('first admin of a business opens the hospital: a workspace and a Super Admin are created, a session starts', async () => {
  const r = await post({ ticket: 'ticket-admin' });
  assert.equal(r.s, 200); assert.equal(r.j.workspace, 'city-care'); assert.equal(r.j.user.role, 'Super Admin'); assert.equal(r.j.user.name, 'Dr Admin');
  assert.equal(r.j.hub.token, 'tok-admin'); assert.deepEqual(r.j.hub.catalog.map((c) => c.id), ['hospital', 'lab']); assert.match(r.cookie, /^sid=/);
  const s = await get('/api/session', r.cookie); assert.equal(s.s, 200); assert.equal(s.j.workspace.name, 'City Care Hospital'); assert.equal(s.j.workspace.status, 'trial');
});

test('a ticket works once', async () => {
  assert.equal((await post({ ticket: 'ticket-admin' })).s, 401);
});

test('the same admin signing in again (token) lands in the same workspace and user', async () => {
  const r = await post({ token: 'tok-admin' }); assert.equal(r.s, 200); assert.equal(r.j.workspace, 'city-care'); assert.equal(r.j.user.username, 'admin');
});

test('a person with a hospital role set in the hub gets that role', async () => {
  const r = await post({ ticket: 'ticket-doc' }); assert.equal(r.s, 200); assert.equal(r.j.user.role, 'Doctor'); assert.equal(r.j.workspace, 'city-care');
});

test('other staff default to Receptionist and cannot see Super Admin data', async () => {
  const r = await post({ token: 'tok-staff' }); assert.equal(r.s, 200); assert.equal(r.j.user.role, 'Receptionist');
  assert.equal((await get('/api/data', r.cookie)).s, 200);
});

test('no access without the hospital app, or in an inactive business, or with a bad token', async () => {
  assert.equal((await post({ token: 'tok-labonly' })).s, 403);
  assert.equal((await post({ token: 'tok-expired' })).s, 403);
  assert.equal((await post({ token: 'nope' })).s, 401);
  assert.equal((await post({})).s, 400);
});

test('a non-admin of a business that has no hospital yet is told to ask the admin', async () => {
  people['tok-newstaff'] = { user: { id: 'U-9', name: 'New', username: 'new', role: 'reception' }, apps: ['hospital'], lab: { ...lab, id: 'biz9', slug: 'fresh', name: 'Fresh Co' } };
  const r = await post({ token: 'tok-newstaff' }); assert.equal(r.s, 409); assert.match(r.j.error, /administrator/);
});

test('a second business with the same short name gets its own workspace code', async () => {
  const r = await post({ token: 'tok-other-admin' }); assert.equal(r.s, 200); assert.notEqual(r.j.workspace, 'city-care'); assert.match(r.j.workspace, /^city-care-[0-9a-f]{4}$/);
});

test('the hub being down is a 503, not a way in', async () => {
  hub.close(); await new Promise((r) => setTimeout(r, 100));
  assert.equal((await post({ token: 'tok-admin' })).s, 503);
});
