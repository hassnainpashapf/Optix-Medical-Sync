/* The money and clinical arithmetic that lives in the page (index.html): bed-day charges, invoice balances and status, lab flags.
   The functions are cut out of the page source and run on their own, so a change there that breaks the maths fails here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function fn(name) {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' is in the page');
  let d = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const L = new Function(['dayDiff', 'dayOf', 'admCharge', 'txPaid', 'txDue', 'invStatusOf', 'flagOf', 'catOfSvc', 'revParts', 'makeInvoice', 'svcOfItems', 'nextInvId'].map(fn).join('\n') +
  '\nvar TXC = [], stampNow = function () { return "2026-05-01 10:00"; }, SRC_LBL = { cons: "Consultation", bed: "Bed charges", lab: "Lab & radiology", oth: "Other" };\nreturn { dayDiff, admCharge, txPaid, txDue, invStatusOf, flagOf, catOfSvc, revParts, makeInvoice, TXC };')();

test('bed days are counted by calendar day, a same-day stay is charged one day, and a transfer splits the charge by ward rate', () => {
  const a = { moves: [{ ward: 'ICU', rate: 2500, from: '2026-05-01 09:00', to: '2026-05-03 10:30' }, { ward: 'General', rate: 350, from: '2026-05-03 10:30', to: '' }] };
  const c = L.admCharge(a, '2026-05-06 12:00');
  assert.equal(c.days, 5); assert.deepEqual(c.lines.map((l) => [l.ward, l.days, l.amount]), [['ICU', 2, 5000], ['General', 3, 1050]]); assert.equal(c.amount, 6050);
  const same = L.admCharge({ moves: [{ ward: 'General', rate: 350, from: '2026-05-01 09:00', to: '' }] }, '2026-05-01 17:00');
  assert.equal(same.days, 1); assert.equal(same.amount, 350);
  assert.equal(L.admCharge({ moves: [{ ward: 'General', rate: 350, from: '2026-05-01 09:00', to: '' }] }, '2026-05-02 08:00').days, 1, 'overnight = one day');
  assert.equal(L.dayDiff('2026-02-27', '2026-03-02'), 3, 'month ends');
});

test('invoice maths: discount is capped, part payments leave a balance, status follows what was paid, old transactions keep working', () => {
  const x = L.makeInvoice({ pid: 1, name: 'P', items: [{ desc: 'Bed', qty: 3, price: 350, src: 'bed' }, { desc: 'CBC', qty: 1, price: 120, src: 'lab' }], discount: 70, payments: [{ at: 'x', amt: 500, method: 'Cash' }] });
  assert.equal(x.subtotal, 1170); assert.equal(x.discount, 70); assert.equal(x.amt, 1100); assert.equal(x.status, 'Partial'); assert.equal(L.txPaid(x), 500); assert.equal(L.txDue(x), 600);
  x.payments.push({ at: 'y', amt: 600, method: 'Visa Card' }); assert.equal(L.invStatusOf(x), 'Paid'); assert.equal(L.txDue(x), 0);
  assert.equal(L.makeInvoice({ items: [{ desc: 'A', qty: 1, price: 100 }], discount: 999 }).amt, 0, 'discount cannot exceed the subtotal');
  assert.equal(L.makeInvoice({ items: [{ desc: 'A', qty: 1, price: 100 }] }).status, 'Pending');
  /* transactions from before invoices existed: no items, no payments list */
  assert.equal(L.txDue({ kind: 'customers', status: 'Pending', amt: 400 }), 400); assert.equal(L.txDue({ kind: 'customers', status: 'Paid', amt: 400 }), 0); assert.equal(L.txDue({ kind: 'customers', status: 'Failed', amt: 400 }), 0);
  assert.equal(L.txPaid({ kind: 'customers', status: 'Paid', amt: 400 }), 400); assert.equal(L.txPaid({ kind: 'customers', status: 'Pending', amt: 400 }), 0);
  assert.equal(L.txDue({ kind: 'suppliers', status: 'Pending', amt: 9000 }), 0, 'supplier payables are not patient dues');
});

test('revenue by source splits an invoice in proportion to what was paid, and old transactions are grouped by their service name', () => {
  const x = L.makeInvoice({ items: [{ desc: 'Bed', qty: 1, price: 600, src: 'bed' }, { desc: 'CBC', qty: 1, price: 400, src: 'lab' }], payments: [{ at: 'x', amt: 500, method: 'Cash' }] });
  const parts = Object.fromEntries(L.revParts(x).map((p) => [p[0], Math.round(p[1])])); assert.deepEqual(parts, { 'Bed charges': 300, 'Lab & radiology': 200 });
  assert.deepEqual(L.revParts({ status: 'Paid', amt: 800, svc: 'X-Ray' }).map((p) => [p[0], p[1], p[2]]), [['X-Ray', 800, 'lab']]);
  assert.deepEqual(L.revParts({ status: 'Pending', amt: 800, svc: 'X-Ray' }), []);
  assert.equal(L.catOfSvc('Follow-up'), 'cons'); assert.equal(L.catOfSvc('Blood Test'), 'lab'); assert.equal(L.catOfSvc('Surgery'), 'oth');
});

test('lab results are flagged high or low against the reference range, text results and radiology are not', () => {
  const t = { dept: 'Lab', lo: 12, hi: 17 };
  assert.equal(L.flagOf({ ...t, value: '9.1' }), 'low'); assert.equal(L.flagOf({ ...t, value: '14' }), 'normal'); assert.equal(L.flagOf({ ...t, value: '17' }), 'normal'); assert.equal(L.flagOf({ ...t, value: '17.1' }), 'high');
  assert.equal(L.flagOf({ ...t, value: '' }), ''); assert.equal(L.flagOf({ dept: 'Lab', lo: null, hi: null, value: 'Clear' }), 'normal'); assert.equal(L.flagOf({ dept: 'Radiology', lo: null, hi: null, value: 'No abnormality' }), 'normal');
});
