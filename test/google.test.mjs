/* Sign up / Sign in with Google in the hospital app. A FAKE hub answers /api/auth/google-verify and /api/auth/google-config (Google itself
   cannot be reached from a test). Each group of tests gets its own throw-away copy of the server, so the per-address rate limits do not mix. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 5000 + Math.floor(Math.random() * 300);
let nextPort = BASE;
const CREDS = {}; /* credential -> { email, name } the fake Google accepts */
const cred = (email, name = '') => { const c = 'fake-google-credential-' + email; CREDS[c] = { email, name }; return c; };
const GCALLS = { n: 0 };
const hub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/api/auth/google-config') return send(200, { clientId: 'fake-client-id.apps.googleusercontent.com' });
    if (req.url === '/api/auth/google-verify') { GCALLS.n++; const c = CREDS[data.credential]; return c ? send(200, { ok: true, ...c }) : send(400, { error: 'bad credential' }); }
    send(404, {});
  });
});
let HUBPORT; const dirs = []; const procs = [];
before(async () => { await new Promise((r) => hub.listen(0, '127.0.0.1', r)); HUBPORT = hub.address().port; });
after(() => { for (const p of procs) p.kill(); hub.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function startServer(env = {}) {
  const port = nextPort++, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hospital-google-')); dirs.push(dir);
  const p = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ALLOWED_HOSTS: `127.0.0.1:${port}`, HUB_API: `http://127.0.0.1:${HUBPORT}`, HUB_APP_ID: 'hospital', TRUST_PROXY: '1', ...env } }); procs.push(p);
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/plans')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  let ipn = 0; /* TRUST_PROXY: every call comes from a fresh address unless a test pins one (rate-limit tests), so the limits do not mix */
  const call = async (method, url, body, cookie, ip) => {
    const r = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `10.${Math.floor(++ipn / 250)}.${ipn % 250}.7`, ...(cookie ? { Cookie: cookie } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    return { s: r.status, j: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  return { B, call, stop: () => p.kill() };
}

test('Google signup + login', async (t) => {
  const S = await startServer();
  const { call } = S;
  const owner = cred('Owner.Dr@Clinic.PK', 'Dr Owner'); let own, ownCookie;

  await t.test('signup/google creates a workspace and a Super Admin linked to the verified email, and signs in', async () => {
    const r = await call('POST', '/api/signup/google', { credential: owner, hospital: 'Alpha Care', workspace: 'alpha-care', sample: false });
    assert.equal(r.s, 200); assert.equal(r.j.workspace, 'alpha-care'); assert.equal(r.j.user.role, 'Super Admin'); assert.equal(r.j.user.name, 'Dr Owner');
    assert.equal(r.j.user.email, 'owner.dr@clinic.pk'); assert.equal(r.j.user.username, 'owner.dr'); assert.equal(r.j.user.google, true); assert.equal(r.j.user.passwordSet, false); assert.equal(r.j.user.googleNotice, true);
    assert.match(r.cookie, /^sid=/); ownCookie = r.cookie;
    const s = await call('GET', '/api/session', null, ownCookie); assert.equal(s.s, 200); assert.equal(s.j.workspace.name, 'Alpha Care'); assert.equal(s.j.workspace.status, 'trial'); assert.equal(s.j.workspace.sample, false);
    own = (await call('GET', '/api/users', null, ownCookie)).j.users; assert.equal(own.length, 1); assert.equal(own[0].email, 'owner.dr@clinic.pk');
  });

  await t.test('the random password is unknown: the username cannot sign in with a guessed password', async () => {
    for (const pw of ['', 'password', 'owner.dr', 'Owner.Dr@Clinic.PK']) assert.equal((await call('POST', '/api/login', { workspace: 'alpha-care', username: 'owner.dr', password: pw })).s, 401);
  });

  await t.test('a bad or fake credential, or none, is rejected and creates nothing', async () => {
    assert.equal((await call('POST', '/api/signup/google', { credential: 'x'.repeat(40), hospital: 'Fake Co', workspace: 'fake-co' })).s, 401);
    assert.equal((await call('POST', '/api/signup/google', { hospital: 'Fake Co', workspace: 'fake-co' })).s, 401);
    assert.equal((await call('POST', '/api/signup/google', { credential: 'short', hospital: 'Fake Co' })).s, 401);
    assert.equal((await call('GET', '/api/signup/check?slug=fake-co')).j.available, true);
  });

  await t.test('a client-supplied email is never trusted (only the one the hub verified is used)', async () => {
    const c = cred('real.person@gmail.com', 'Real Person');
    const r = await call('POST', '/api/signup/google', { credential: c, email: 'ceo@bank.com', name: 'CEO', username: 'ceo', hospital: 'Real Clinic', workspace: 'real-clinic' });
    assert.equal(r.s, 200); assert.equal(r.j.user.email, 'real.person@gmail.com'); assert.equal(r.j.user.username, 'real.person'); assert.equal(r.j.user.name, 'Real Person');
  });

  await t.test('a taken, reserved or invalid workspace code is refused', async () => {
    const c = cred('third@gmail.com', 'Third');
    const dup = await call('POST', '/api/signup/google', { credential: c, hospital: 'Another', workspace: 'alpha-care' }); assert.equal(dup.s, 409); assert.match(dup.j.error, /taken/);
    assert.equal((await call('POST', '/api/signup/google', { credential: c, hospital: 'Another', workspace: 'admin' })).s, 400);
    assert.equal((await call('POST', '/api/signup/google', { credential: c, hospital: 'Another', workspace: 'Bad Code!' })).s, 400);
  });

  await t.test('without a hospital name or code, sensible ones are derived and made unique', async () => {
    const c = cred('sana.khan@gmail.com', 'Sana Khan');
    const a = await call('POST', '/api/signup/google', { credential: c }); assert.equal(a.s, 200); assert.equal(a.j.workspace, 'sana-khan-s-clinic'); assert.equal(a.j.user.username, 'sana.khan');
    const b = await call('POST', '/api/signup/google', { credential: c }); assert.equal(b.s, 200); assert.match(b.j.workspace, /^sana-khan-s-clinic-[0-9a-f]{4}$/);
    assert.equal((await call('GET', '/api/session', null, b.cookie)).j.workspace.name, "Sana Khan's Clinic");
  });

  await t.test('a Google-linked owner sets a first password WITHOUT the current one, exactly once; normal rules after that', async () => {
    const notice = await call('GET', '/api/session', null, ownCookie); assert.equal(notice.j.user.googleNotice, true);
    assert.equal((await call('POST', '/api/google-notice', {}, ownCookie)).s, 200);
    const after = await call('GET', '/api/session', null, ownCookie); assert.equal(after.j.user.googleNotice, false); assert.equal(after.j.user.passwordSet, false);
    assert.equal((await call('POST', '/api/password', { next: 'short' }, ownCookie)).s, 400);
    const ok = await call('POST', '/api/password', { next: 'my-first-pass-1' }, ownCookie); assert.equal(ok.s, 200); assert.match(ok.cookie, /^sid=/); ownCookie = ok.cookie;
    const s = await call('GET', '/api/session', null, ownCookie); assert.equal(s.j.user.passwordSet, true); assert.equal(s.j.user.google, true);
    assert.equal((await call('POST', '/api/password', { next: 'another-pass-22' }, ownCookie)).s, 400, 'the second time the current password is required');
    assert.equal((await call('POST', '/api/password', { current: 'wrong', next: 'another-pass-22' }, ownCookie)).s, 400);
    const ch = await call('POST', '/api/password', { current: 'my-first-pass-1', next: 'another-pass-22' }, ownCookie); assert.equal(ch.s, 200); ownCookie = ch.cookie;
    assert.equal((await call('POST', '/api/login', { workspace: 'alpha-care', username: 'owner.dr', password: 'another-pass-22' })).s, 200);
  });

  await t.test('password sign-up users still need the current password to change it', async () => {
    const r = await call('POST', '/api/signup', { hospital: 'Pw Clinic', workspace: 'pw-clinic', name: 'Pw Owner', username: 'pwowner', email: 'pw@clinic.pk', password: 'password-123', sample: false });
    assert.equal(r.s, 200); assert.equal(r.j.user.passwordSet, true); assert.equal(r.j.user.google, false);
    assert.equal((await call('POST', '/api/password', { next: 'password-456' }, r.cookie)).s, 400);
    assert.equal((await call('POST', '/api/password', { current: 'password-123', next: 'password-456' }, r.cookie)).s, 200);
  });

  /* staff of alpha-care, added by the Super Admin with their Gmail */
  const addUser = (name, username, email, role = 'Doctor') => call('POST', '/api/users', { name, username, email, role, password: 'staff-pass-1' }, ownCookie);

  await t.test('login/google signs in an active user of the workspace whose email matches, and audits it', async () => {
    assert.equal((await addUser('Dr Sara', 'sara', 'Sara@Gmail.com')).s, 200);
    const r = await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: cred('sara@gmail.com', 'Sara G') });
    assert.equal(r.s, 200); assert.equal(r.j.workspace, 'alpha-care'); assert.equal(r.j.user.username, 'sara'); assert.equal(r.j.user.role, 'Doctor'); assert.equal(r.j.user.passwordSet, true); assert.match(r.cookie, /^sid=/);
    const s = await call('GET', '/api/session', null, r.cookie); assert.equal(s.s, 200); assert.equal(s.j.user.username, 'sara');
    const audit = (await call('GET', '/api/audit', null, ownCookie)).j.rows; assert.ok(audit.some((a) => a.user === 'sara' && a.action === 'Signed in with Google'));
    /* signing in with Google does not waive the current password of an account that has a real one */
    assert.equal((await call('POST', '/api/password', { next: 'try-to-skip-1' }, r.cookie)).s, 400);
  });

  await t.test('no workspace typed: allowed when the Gmail belongs to exactly one workspace', async () => {
    const r = await call('POST', '/api/login/google', { credential: cred('sara@gmail.com') }); assert.equal(r.s, 200); assert.equal(r.j.workspace, 'alpha-care');
  });

  await t.test('unknown email, wrong workspace, inactive user and a made-up workspace all fail with the same safe message', async () => {
    const nomatch = await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: cred('stranger@gmail.com') });
    assert.equal(nomatch.s, 401); assert.match(nomatch.j.error, /No account in this workspace uses this Google email/); assert.equal(nomatch.cookie, '');
    const wrongWs = await call('POST', '/api/login/google', { workspace: 'real-clinic', credential: cred('sara@gmail.com') }); assert.equal(wrongWs.s, 401);
    assert.equal(wrongWs.j.error, nomatch.j.error);
    const ghost = await call('POST', '/api/login/google', { workspace: 'no-such-clinic', credential: cred('sara@gmail.com') }); assert.equal(ghost.s, 401); assert.equal(ghost.j.error, nomatch.j.error);
    await addUser('Gone User', 'gone', 'gone@gmail.com'); const gone = (await call('GET', '/api/users', null, ownCookie)).j.users.find((u) => u.username === 'gone');
    assert.equal((await call('PUT', '/api/users/' + gone.id, { active: false }, ownCookie)).s, 200);
    assert.equal((await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: cred('gone@gmail.com') })).s, 401);
  });

  await t.test('a bad credential never signs anyone in', async () => {
    const r = await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: 'z'.repeat(60) }); assert.equal(r.s, 401); assert.equal(r.cookie, '');
    assert.equal((await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: '' })).s, 401);
    assert.equal((await call('POST', '/api/login/google', { workspace: 'alpha-care', email: 'sara@gmail.com' })).s, 401);
  });

  await t.test('a Gmail in several workspaces needs the workspace code; with it, the right one opens', async () => {
    /* real.person@gmail.com owns real-clinic; add the same Gmail as staff of alpha-care */
    await addUser('Real P', 'realp', 'real.person@gmail.com', 'Receptionist');
    const none = await call('POST', '/api/login/google', { credential: cred('real.person@gmail.com') }); assert.equal(none.s, 409); assert.equal(none.j.code, 'workspace'); assert.equal(none.cookie, '');
    const a = await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: cred('real.person@gmail.com') }); assert.equal(a.s, 200); assert.equal(a.j.user.role, 'Receptionist');
    const b = await call('POST', '/api/login/google', { workspace: 'real-clinic', credential: cred('real.person@gmail.com') }); assert.equal(b.s, 200); assert.equal(b.j.user.role, 'Super Admin'); assert.equal(b.j.workspace, 'real-clinic');
  });

  await t.test('cross-tenant isolation is unchanged: a session only sees its own workspace', async () => {
    const a = await call('POST', '/api/login/google', { workspace: 'alpha-care', credential: cred('real.person@gmail.com') });
    const b = await call('POST', '/api/login/google', { workspace: 'real-clinic', credential: cred('real.person@gmail.com') });
    const ua = (await call('GET', '/api/session', null, a.cookie)).j, ub = (await call('GET', '/api/session', null, b.cookie)).j;
    assert.equal(ua.workspace.slug, 'alpha-care'); assert.equal(ub.workspace.slug, 'real-clinic');
    const names = (await call('GET', '/api/users', null, b.cookie)).j.users.map((u) => u.username); assert.deepEqual(names, ['real.person']);
  });

  await t.test('password sign-in, forgot-password and invite tokens still work', async () => {
    assert.equal((await call('POST', '/api/login', { workspace: 'alpha-care', username: 'sara', password: 'staff-pass-1' })).s, 200);
    assert.equal((await call('POST', '/api/login', { workspace: 'alpha-care', username: 'sara', password: 'nope-nope-1' })).s, 401);
    assert.equal((await call('POST', '/api/forgot', { workspace: 'alpha-care', identifier: 'sara' })).s, 200);
    const inv = await call('POST', '/api/users', { name: 'Invited', username: 'invited', email: 'inv@gmail.com', role: 'Receptionist', invite: true }, ownCookie); assert.equal(inv.s, 200);
  });
  S.stop();
});

test('signup/google respects the per-address signup limit (5 an hour) and counts only real creations', async () => {
  const S = await startServer();
  for (let i = 0; i < 5; i++) { const r = await S.call('POST', '/api/signup/google', { credential: cred(`limit${i}@gmail.com`, 'Lim It'), hospital: 'Limit ' + i, workspace: 'limit-' + i }, null, '9.9.9.9'); assert.equal(r.s, 200, 'signup ' + i); }
  const r = await S.call('POST', '/api/signup/google', { credential: cred('limit9@gmail.com'), hospital: 'Limit 9', workspace: 'limit-9' }, null, '9.9.9.9'); assert.equal(r.s, 429);
  assert.equal((await S.call('GET', '/api/signup/check?slug=limit-9')).j.available, true);
  S.stop();
});

test('login/google is rate limited like /api/login (8 failures in 10 minutes)', async () => {
  const S = await startServer(); let last;
  for (let i = 0; i < 9; i++) last = await S.call('POST', '/api/login/google', { workspace: 'x-clinic', credential: cred(`nobody${i}@gmail.com`) }, null, '8.8.8.8');
  assert.equal(last.s, 429);
  S.stop();
});

test('the hub being down is a 503, and with the hub switched off Google is simply off', async () => {
  const down = await startServer({ HUB_API: 'http://127.0.0.1:1' });
  assert.equal((await down.call('POST', '/api/signup/google', { credential: cred('a@gmail.com'), hospital: 'Down Co' })).s, 503);
  assert.equal((await down.call('POST', '/api/login/google', { workspace: 'down-co', credential: cred('a@gmail.com') })).s, 503);
  down.stop();
  const off = await startServer({ HUB_DISABLED: '1' });
  assert.equal((await off.call('GET', '/api/hub/config')).j.enabled, false);
  assert.equal((await off.call('POST', '/api/signup/google', { credential: cred('a@gmail.com'), hospital: 'Off Co' })).s, 404);
  assert.equal((await off.call('POST', '/api/login/google', { workspace: 'off-co', credential: cred('a@gmail.com') })).s, 404);
  off.stop();
});

test('the server never takes the hub for granted: verify is called for each Google request', async () => {
  const before = GCALLS.n, S = await startServer();
  await S.call('POST', '/api/login/google', { workspace: 'nothing', credential: cred('count@gmail.com') });
  assert.equal(GCALLS.n, before + 1);
  S.stop();
});
