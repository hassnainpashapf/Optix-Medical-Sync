/* The Optix superadmin console opens the platform panel with a one-time hub ticket (no second login). Runs a fake hub and a throw-away server. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-sso-'));
const PORT = 3400 + Math.floor(Math.random() * 400), HUBPORT = PORT + 500;
const B = `http://127.0.0.1:${PORT}`;
const good = new Set(['ticket-ok-0123456789abcdef']);
let hub, srv, asked = [];

before(async () => {
  hub = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/saas/sa-ticket/verify') { const d = JSON.parse(body || '{}'); asked.push(d); const ok = good.delete(d.ticket) && d.product === 'hospital'; return ok ? send(200, { ok: true, product: 'hospital' }) : send(401, { error: 'no' }); }
      send(404, {});
    });
  });
  await new Promise((r) => hub.listen(HUBPORT, '127.0.0.1', r));
  srv = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_HOSTS: `127.0.0.1:${PORT}`, HUB_API: `http://127.0.0.1:${HUBPORT}`, HUB_APP_ID: 'hospital' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/plans')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
});
after(() => { srv.kill(); hub.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const sso = async (ticket) => {
  const r = await fetch(B + '/api/platform/sso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  let j = {}; try { j = await r.json(); } catch { /* none */ }
  return { s: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

test('a good ticket signs the platform owner in once; before any owner exists it is refused politely', async () => {
  let r = await sso('ticket-ok-0123456789abcdef'); assert.equal(r.s, 409, 'no owner yet');
  good.add('ticket-ok-0123456789abcdef');
  const setup = await fetch(B + '/api/platform/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', name: 'The Boss', password: 'a-long-enough-password' }) });
  assert.equal(setup.status, 200);
  good.add('ticket-ok-0123456789abcdef');
  r = await sso('ticket-ok-0123456789abcdef'); assert.equal(r.s, 200); assert.equal(r.j.owner.username, 'boss'); assert.match(r.cookie, /^psid=/);
  const st = await (await fetch(B + '/api/platform/state', { headers: { Cookie: r.cookie } })).json(); assert.equal(st.owner.username, 'boss', 'the session works');
  r = await sso('ticket-ok-0123456789abcdef'); assert.equal(r.s, 401, 'a ticket works once');
  assert.ok(asked.every((d) => d.product === 'hospital'), 'the server asks the hub for its own product only');
});

test('bad or short tickets never start a session', async () => {
  for (const t of ['', 'short', 'x'.repeat(300), 'not-a-ticket-0123456789abcdef']) { const r = await sso(t); assert.ok(r.s === 401 || r.s === 400, 'refused: ' + t.slice(0, 10)); assert.equal(r.cookie, ''); }
});
