/* The old brand name must not show up anywhere a person can see it (page, server-sent mail, public site, printouts),
   while the internal names that existing data and sessions depend on stay as they are. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel, out); } else if (/\.(html|js|mjs|css|json|txt|svg|webmanifest|md)$/.test(e.name)) out.push(rel);
  }
  return out;
}
/* internal identifiers that are not shown to anyone: the database and backup file names, the upload request header, the SMTP EHLO name */
const INTERNAL = [/nexura\.db/gi, /'nexura'/g, /EHLO nexura/g, /\bnexura-\\d/g, /\bnexura-\d/g];

test('no user-facing "Nexura" string is left in the page, the server, the mailer or the public site', () => {
  const files = ['index.html', 'server.mjs', 'lib/mail.mjs', 'lib/hub.mjs', ...walk('site'), ...walk('assets')];
  const left = [];
  for (const f of files) {
    let t = read(f);
    for (const re of INTERNAL) t = t.replace(re, '');
    t.split('\n').forEach((line, i) => { if (/nexura/i.test(line)) left.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120)); });
  }
  assert.deepEqual(left, []);
});

test('printed documents use the workspace name as the letterhead, with Optix Medical Sync as the fallback', () => {
  const html = read('index.html');
  assert.match(html, /function wsName\(\) \{ return \(WS && WS\.name\) \|\| 'Optix Medical Sync'; \}/);
  assert.match(html, /function letterhead\(kind, sub\) \{[^}]*esc\(wsName\(\)\)/);
  assert.match(html, /function printRows\([^)]*\) \{ printHtml\([^;]*esc\(wsName\(\)\)/);
  /* every printout goes through printDoc (letterhead) or printRows (slip); nothing writes its own heading */
  assert.equal((html.match(/printDoc\('/g) || []).length, 5);
});

test('browser storage keys keep their old names so signed-in sessions survive the rename', () => {
  const html = read('index.html');
  for (const k of ['nx_ws']) assert.ok(html.includes("'" + k + "'"), k + ' is still used');
});
