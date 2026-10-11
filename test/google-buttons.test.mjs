/* Google Identity Services keeps ONE callback per page. With two Google buttons on a page (sign-in by workspace and sign-in with the Optix
   account) each button must re-claim the callback when the pointer reaches it, so a click runs ITS handler. Runs the real browser SDK
   (assets/optix-suite-sdk.js) in Node against a stand-in for window.google and for the buttons' containers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkUrl = new URL('../assets/optix-suite-sdk.js', import.meta.url).href;

function box() { const l = {}; return { hidden: true, innerHTML: '', clientWidth: 320, addEventListener(ev, fn) { (l[ev] ||= []).push(fn); }, fire(ev) { for (const f of l[ev] || []) f(); } }; }
const tick = () => new Promise((r) => setTimeout(r, 20));

test('each Google button re-claims the page callback, so the right handler runs', async () => {
  let current = null, rendered = 0;
  globalThis.document = { createElement() { throw new Error('GIS script must not be loaded in the test'); }, head: {} };
  globalThis.window = globalThis;
  globalThis.google = { accounts: { id: { initialize: (o) => { current = o.callback; }, renderButton: () => { rendered++; } } } };
  const { mountGoogleButton } = await import(sdkUrl);
  /* the stand-in hub used by the Hospital pages: it hands the raw Google credential to onResult */
  const hub = { googleClientId: async () => 'client-id', loginWithGoogle: async (c) => c };
  const got = [], a = box(), b = box(), c = box();
  mountGoogleButton(a, { hub, text: 'continue_with', onResult: (cr) => got.push(['workspace', cr]) });
  mountGoogleButton(b, { hub, text: 'continue_with', onResult: (cr) => got.push(['optix', cr]) });
  mountGoogleButton(c, { hub, text: 'signup_with', onResult: (cr) => got.push(['signup', cr]) });
  await tick();
  assert.equal(rendered, 3); assert.equal(a.hidden, false);
  /* untouched: the last one mounted owns the callback (the bug) */
  await current({ credential: 'c0' }); await tick(); assert.deepEqual(got.pop(), ['signup', 'c0']);
  /* pointer reaches a button -> it owns the callback */
  a.fire('pointerenter'); await current({ credential: 'c1' }); await tick(); assert.deepEqual(got.pop(), ['workspace', 'c1']);
  b.fire('mouseover'); await current({ credential: 'c2' }); await tick(); assert.deepEqual(got.pop(), ['optix', 'c2']);
  c.fire('touchstart'); await current({ credential: 'c3' }); await tick(); assert.deepEqual(got.pop(), ['signup', 'c3']);
  a.fire('focusin'); await current({ credential: 'c4' }); await tick(); assert.deepEqual(got.pop(), ['workspace', 'c4']);
  delete globalThis.google; delete globalThis.document;
});

test('the Hospital pages wire the Google buttons to the native endpoints with the credential-only stand-in', () => {
  const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), signup = fs.readFileSync(path.join(root, 'site/signup.html'), 'utf8');
  assert.match(app, /'\/api\/login\/google', \{ workspace/); assert.match(app, /lgGoogleWs/); assert.match(signup, /text: 'signup_with'/); assert.match(signup, /\/api\/signup\/google/);
  assert.match(app, /loginWithGoogle: function \(credential\) \{ return Promise\.resolve\(credential\)/); assert.match(signup, /loginWithGoogle: function \(c\) \{ return Promise\.resolve\(c\)/);
});
