// Optix Medical Sync home page: WebGL double helix behind the dark stage, CSS 3D app stack, tilt cards, reveal on scroll, module explorer, booking demo, roles, pricing.
// The parts every public page shares (theme toggle, menu, progress bar, ads) are in chrome.js.
import * as THREE from '/site/vendor/three.module.min.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage = document.getElementById('stage');

/* ---------- page chrome ---------- */
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
document.querySelectorAll('.reveal').forEach((el, i) => { el.style.transitionDelay = (i % 4) * 70 + 'ms'; io.observe(el); });

/* tilt cards */
if (!reduced && matchMedia('(hover: hover)').matches) {
  document.querySelectorAll('.tilt').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateX(${(-y * 9).toFixed(2)}deg) rotateY(${(x * 11).toFixed(2)}deg) translateY(-4px)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
}

/* CSS 3D app stack follows the pointer and the scroll position */
const deck = document.getElementById('deck'), deckIn = document.getElementById('deckIn');
let mx = 0, my = 0;
function setDeck() {
  const r = deck.getBoundingClientRect(), vh = innerHeight, prog = Math.min(1, Math.max(0, 1 - (r.top + r.height / 2) / vh));
  const ry = -9 + mx * 9 + (prog - 0.5) * -8, rx = 6 - my * 6 + (prog - 0.5) * 4;
  deckIn.style.setProperty('--ry', ry.toFixed(2) + 'deg'); deckIn.style.setProperty('--rx', rx.toFixed(2) + 'deg');
}
if (!reduced) {
  deck.addEventListener('pointermove', (e) => { const r = deck.getBoundingClientRect(); mx = ((e.clientX - r.left) / r.width - 0.5) * 2; my = ((e.clientY - r.top) / r.height - 0.5) * 2; setDeck(); });
  deck.addEventListener('pointerleave', () => { mx = 0; my = 0; setDeck(); });
  addEventListener('scroll', setDeck, { passive: true }); setDeck();
}

/* ---------- WebGL helix ---------- */
const canvas = document.getElementById('gl');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); }
catch (e) { document.documentElement.classList.add('no-gl'); }

if (renderer) {
  const small = innerWidth < 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 1.75));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a1230, 0.045);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
  camera.position.set(0, 0, 12.5);

  scene.add(new THREE.AmbientLight(0x9db4ff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 6, 6); scene.add(key);
  const rim = new THREE.PointLight(0x36d1c4, 40, 22); rim.position.set(-5, -2, 3); scene.add(rim);
  const blue = new THREE.PointLight(0x4f8cff, 55, 26); blue.position.set(5, 3, 2); scene.add(blue);

  const helix = new THREE.Group(); scene.add(helix);
  const N = small ? 44 : 70, H = 6.8, R = 0.95, TURNS = 2.9;
  const sphereGeo = new THREE.SphereGeometry(0.115, small ? 12 : 18, small ? 12 : 18);
  const matA = new THREE.MeshStandardMaterial({ color: 0x4f8cff, emissive: 0x1d4fd8, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.2 });
  const matB = new THREE.MeshStandardMaterial({ color: 0x36d1c4, emissive: 0x0f8f85, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.2 });
  const strandA = new THREE.InstancedMesh(sphereGeo, matA, N), strandB = new THREE.InstancedMesh(sphereGeo, matB, N);
  const rungGeo = new THREE.CylinderGeometry(0.016, 0.016, 1, 6);
  const rungMat = new THREE.MeshStandardMaterial({ color: 0xbcd0ff, emissive: 0x5c85e6, emissiveIntensity: 0.55, transparent: true, opacity: 0.55, roughness: 0.4 });
  const rungs = new THREE.InstancedMesh(rungGeo, rungMat, N);
  helix.add(strandA, strandB, rungs);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), mid = new THREE.Vector3(), dir = new THREE.Vector3();
  function placeHelix(t, pulse) {
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1), y = (f - 0.5) * H, a = f * TURNS * Math.PI * 2 + t * 0.0;
      const wob = 1 + Math.sin(t * 1.4 + i * 0.35) * 0.07 * pulse, r = R * (0.92 + 0.12 * Math.sin(f * Math.PI)) * wob;
      pa.set(Math.cos(a) * r, y, Math.sin(a) * r); pb.set(Math.cos(a + Math.PI) * r, y, Math.sin(a + Math.PI) * r);
      const sc = 0.85 + 0.45 * Math.sin(f * Math.PI) + 0.14 * Math.sin(t * 2 + i * 0.5) * pulse;
      s.set(sc, sc, sc); q.identity();
      m.compose(pa, q, s); strandA.setMatrixAt(i, m); m.compose(pb, q, s); strandB.setMatrixAt(i, m);
      mid.addVectors(pa, pb).multiplyScalar(0.5); dir.subVectors(pb, pa); const len = dir.length();
      q.setFromUnitVectors(up, dir.normalize()); s.set(1, len, 1); m.compose(mid, q, s); rungs.setMatrixAt(i, m);
    }
    strandA.instanceMatrix.needsUpdate = strandB.instanceMatrix.needsUpdate = rungs.instanceMatrix.needsUpdate = true;
  }
  placeHelix(0, 0);

  /* medical cross */
  const cs = new THREE.Shape(), w = 0.3, l = 0.95;
  cs.moveTo(-w, -l); cs.lineTo(w, -l); cs.lineTo(w, -w); cs.lineTo(l, -w); cs.lineTo(l, w); cs.lineTo(w, w); cs.lineTo(w, l); cs.lineTo(-w, l); cs.lineTo(-w, w); cs.lineTo(-l, w); cs.lineTo(-l, -w); cs.lineTo(-w, -w); cs.closePath();
  const crossGeo = new THREE.ExtrudeGeometry(cs, { depth: 0.34, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.07, bevelSegments: 4 }); crossGeo.center();
  const cross = new THREE.Mesh(crossGeo, new THREE.MeshPhysicalMaterial({ color: 0xf2f6ff, emissive: 0x5c85ff, emissiveIntensity: 0.65, roughness: 0.18, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.1 }));
  cross.scale.setScalar(0.5); scene.add(cross);

  /* orbit rings */
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x6aa0ff, transparent: true, opacity: 0.35 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.012, 8, 160), ringMat), ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.01, 8, 160), new THREE.MeshBasicMaterial({ color: 0x36d1c4, transparent: true, opacity: 0.28 }));
  ring1.rotation.x = 1.15; ring2.rotation.set(0.55, 0.4, 0.3); helix.add(ring1, ring2);

  /* particles */
  const PN = small ? 140 : 320, pg = new THREE.BufferGeometry(), pp = new Float32Array(PN * 3);
  for (let i = 0; i < PN; i++) { const a = Math.random() * Math.PI * 2, r = 2.2 + Math.random() * 7, y = (Math.random() - 0.5) * 14; pp[i * 3] = Math.cos(a) * r; pp[i * 3 + 1] = y; pp[i * 3 + 2] = Math.sin(a) * r - 2; }
  pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  const points = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x9db8ff, size: 0.035, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(points);

  /* sizing: wrapper height = hero + showcase; canvas is sticky and viewport sized */
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  let tx = 0, ty = 0, cx = 0, cy = 0, visible = true, last = performance.now(), time = 0;
  addEventListener('pointermove', (e) => { tx = (e.clientX / innerWidth - 0.5) * 2; ty = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) loop(); }).observe(stage);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) loop(); });

  function frame(dt) {
    time += dt;
    const total = Math.max(1, stage.offsetHeight - innerHeight), p = Math.min(1, Math.max(0, scrollY / total)); // 0 at top, 1 at the bottom of the stage
    const wide = innerWidth >= 980;
    const heroX = wide ? 3.95 : 0, endX = wide ? -3.6 : 0, baseY = wide ? 0 : -2.7;
    const ease = p * p * (3 - 2 * p);
    helix.position.x += ((heroX + (endX - heroX) * ease) - helix.position.x) * Math.min(1, dt * 4);
    helix.position.y = baseY + Math.sin(time * 0.6) * 0.12 - p * 0.4;
    helix.rotation.y = time * 0.28 + p * Math.PI * 3;
    helix.rotation.z = 0.18 - p * 0.35;
    helix.scale.setScalar(wide ? 1 : 0.7);
    ring1.rotation.z = time * 0.2; ring2.rotation.z = -time * 0.14;
    cross.position.set(helix.position.x + Math.cos(time * 0.7) * 2.2, helix.position.y + 1.1 + Math.sin(time * 0.9) * 0.45, Math.sin(time * 0.7) * 2.2);
    cross.rotation.y = time * 0.9; cross.rotation.x = Math.sin(time * 0.5) * 0.3;
    points.rotation.y = time * 0.02 + p * 0.5;
    cx += (tx - cx) * Math.min(1, dt * 3); cy += (ty - cy) * Math.min(1, dt * 3);
    camera.position.x = cx * 0.9; camera.position.y = -cy * 0.6; camera.lookAt(helix.position.x * 0.35, 0, 0);
    placeHelix(time, 1);
    renderer.render(scene, camera);
  }
  let running = false;
  function loop() {
    if (running) return; running = true;
    const step = (now) => { if (!visible || document.hidden) { running = false; return; } const dt = Math.min(0.05, (now - last) / 1000); last = now; frame(dt); requestAnimationFrame(step); };
    last = performance.now(); requestAnimationFrame(step);
  }
  if (reduced) { frame(0.016); addEventListener('scroll', () => frame(0), { passive: true }); } else loop();
}

/* ---------- v2: counters, explorer, demo, roles ---------- */
function runCount(el) {
  const to = +el.dataset.count, suf = el.dataset.suf || '';
  if (reduced || to === 0) { el.textContent = to + suf; return; }
  const t0 = performance.now(), d = 1100;
  const tick = (now) => { const k = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e) + suf; if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
const cio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { runCount(e.target); cio.unobserve(e.target); } }), { threshold: 0.6 });
document.querySelectorAll('.band [data-count]').forEach((el) => cio.observe(el));

/* module explorer */
const MODS = [
  { url: 'Appointments', pts: [['Approve or reject', 'New requests wait in a queue with one-click actions.'], ['3-step booking', 'Patient, appointment and payment details, checked at each step.'], ['Conflict check', 'Double booking and break-time clashes are refused.']] },
  { url: 'Calendar', pts: [['By doctor', 'A column per doctor with the real appointments and off days.'], ['Day, week, month', 'Zoom out for the load, zoom in for the details.'], ['Click for details', 'Status, billing, notes and files for any visit.']] },
  { url: 'Patients', pts: [['Search and filter', 'By name, ID or phone, inpatient or outpatient.'], ['Full profile', 'Insurance, care plan, visits calendar and reports.'], ['Lab reports', 'Attach a file to a report and download it later.']] },
  { url: 'Transactions', pts: [['Paid, pending, failed', 'Every payment with its state and method.'], ['Printable receipts', 'One click from the row menu.'], ['CSV export', 'This page or all filtered rows.']] },
  { url: 'Stocks', pts: [['Low-stock alerts', 'Items under their limit are flagged and counted in the bell.'], ['By supplier', 'See what each supplier delivers and spends.'], ['Restock in a click', 'Add quantity without opening a form.']] },
  { url: 'Staff List', pts: [['Working days', 'Seven-day view of who works when.'], ['Working hours', 'A start and end time for each day.'], ['Employment type', 'Full time or part time, editable.']] },
  { url: 'Audit Log', pts: [['Every change', 'Who created, updated or deleted what.'], ['Filter and search', 'By user, area or words in the details.'], ['Super Admin only', 'Nobody else can read or edit it.']] },
];
const xpTabs = [...document.querySelectorAll('.xp-tabs button')], xpImgs = [...document.querySelectorAll('#xpImgs img')], xpPts = document.getElementById('xpPts'), xpUrl = document.getElementById('xpUrl');
let xpI = 0, xpTimer = 0, xpUser = false;
function setXp(i, byUser) {
  xpI = i; if (byUser) { xpUser = true; clearInterval(xpTimer); }
  xpTabs.forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', String(k === i)); });
  xpImgs.forEach((im, k) => im.classList.toggle('on', k === i));
  xpUrl.textContent = '/app · ' + MODS[i].url;
  xpPts.innerHTML = MODS[i].pts.map((p) => `<li><b>${p[0]}</b>${p[1]}</li>`).join('');
}
xpTabs.forEach((b, i) => b.addEventListener('click', () => setXp(i, true)));
setXp(0);
const xpSec = document.getElementById('explore');
new IntersectionObserver((es) => { clearInterval(xpTimer); if (es[0].isIntersecting && !xpUser && !reduced) xpTimer = setInterval(() => setXp((xpI + 1) % MODS.length), 4500); }, { threshold: 0.4 }).observe(xpSec);
const f3 = document.getElementById('frame3d');
if (!reduced && matchMedia('(hover: hover)').matches) {
  f3.addEventListener('pointermove', (e) => { const r = f3.getBoundingClientRect(); f3.style.setProperty('--fy', (((e.clientX - r.left) / r.width - 0.5) * 12).toFixed(2) + 'deg'); f3.style.setProperty('--fx', ((0.5 - (e.clientY - r.top) / r.height) * 8).toFixed(2) + 'deg'); });
  f3.addEventListener('pointerleave', () => { f3.style.removeProperty('--fy'); f3.style.removeProperty('--fx'); });
}

/* booking check demo (same rules as the app) */
const DOCS = [
  { name: 'Dr. Sarah Ali', days: [1, 0, 1, 1, 1, 0, 1], busy: { 3: [['09:00', 45], ['10:30', 30], ['15:00', 45]], 1: [['11:00', 45]], 4: [['09:30', 45]] } },
  { name: 'Dr. Tariq Al-Hakim', days: [1, 1, 1, 1, 0, 1, 0], busy: { 2: [['08:30', 45], ['16:00', 45]], 3: [['10:00', 60]], 1: [['14:30', 30]] } },
  { name: 'Dr. Amir Al-Farsi', days: [0, 1, 1, 1, 1, 1, 1], busy: { 2: [['09:00', 45], ['09:45', 45]], 4: [['11:30', 45]], 5: [['13:00', 30]] } },
];
const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], simDays = document.getElementById('simDays'), simGrid = document.getElementById('simGrid'), simMsg = document.getElementById('simMsg'), simDoc = document.getElementById('simDoc'), simVis = document.getElementById('simVis');
let simDay = 3, simPick = '';
const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3), hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
function fmt12(t) { const h = +t.slice(0, 2); return ((h % 12) || 12) + ':' + t.slice(3) + (h < 12 ? ' am' : ' pm'); }
function simCheck(t) {
  const d = DOCS[+simDoc.value], dur = +simVis.value, s0 = mins(t), e0 = s0 + dur;
  if (!d.days[simDay]) return [false, `${d.name} does not work on ${DAYN[simDay]}s.`];
  if (s0 < 840 && e0 > 780) return [false, 'That time overlaps the 1:00 to 2:00 pm break.'];
  if (e0 > 1080) return [false, 'The visit would run past the end of the day (6:00 pm).'];
  for (const [bt, bd] of (d.busy[simDay] || [])) { const bs = mins(bt), be = bs + bd; if (s0 < be && e0 > bs) return [false, `${d.name} already has an appointment at ${fmt12(bt)}.`]; }
  return [true, `Booked. ${d.name} is free from ${fmt12(t)} to ${fmt12(hm(e0))}.`];
}
function renderSim() {
  const d = DOCS[+simDoc.value];
  simDays.innerHTML = DAYN.map((n, i) => `<button type="button" class="${i === simDay ? 'on' : ''}${d.days[i] ? '' : ' off'}" data-d="${i}" aria-pressed="${i === simDay}">${n}</button>`).join('');
  let h = ''; for (let m = 480; m < 1080; m += 30) { const t = hm(m), busy = (d.busy[simDay] || []).some(([bt, bd]) => m >= mins(bt) && m < mins(bt) + bd), brk = m >= 780 && m < 840; h += `<button type="button" data-t="${t}" class="${busy ? 'busy' : brk ? 'brk' : ''}${t === simPick ? ' pick' : ''}">${fmt12(t).replace(' ', '')}</button>`; }
  simGrid.innerHTML = h;
  if (simPick) { const [ok, msg] = simCheck(simPick); simMsg.textContent = msg; simMsg.className = 'sim-msg ' + (ok ? 'ok' : 'bad'); } else { simMsg.textContent = 'Choose a time to check it. Red slots are already taken, striped slots are the break.'; simMsg.className = 'sim-msg'; }
}
simDays.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { simDay = +b.dataset.d; renderSim(); } });
simGrid.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { simPick = b.dataset.t; renderSim(); } });
simDoc.addEventListener('change', renderSim); simVis.addEventListener('change', renderSim);
renderSim();

/* role matrix (mirrors the server) */
const AREAS = ['Appointments', 'Patients', 'Staff', 'Suppliers', 'Stocks', 'Transactions', 'Peripherals', 'Reports', 'Users and audit log'];
const ROLES = {
  'Super Admin': ['rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw', 'rw'],
  Doctor: ['rw', 'rw', 'r', '', '', '', '', '', ''],
  Receptionist: ['rw', 'rw', 'r', '', '', '', '', '', ''],
  Accountant: ['r', 'r', 'r', 'r', 'r', 'rw', '', 'r', ''],
  Pharmacist: ['', '', 'r', 'rw', 'rw', '', 'r', '', ''],
};
const rtabs = document.getElementById('rtabs'), matrix = document.getElementById('matrix'); let roleNow = 'Super Admin';
function renderRoles() {
  rtabs.innerHTML = Object.keys(ROLES).map((r) => `<button type="button" role="tab" class="${r === roleNow ? 'on' : ''}" aria-selected="${r === roleNow}" data-r="${r}">${r}</button>`).join('');
  matrix.innerHTML = AREAS.map((a, i) => { const p = ROLES[roleNow][i]; return `<div class="cell ${p || 'none'}"><span>${a}</span><em>${p === 'rw' ? 'Can change' : p === 'r' ? 'View only' : 'No access'}</em></div>`; }).join('');
}
rtabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { roleNow = b.dataset.r; renderRoles(); } });
renderRoles();

/* ---------- pricing from the platform (/api/plans) ---------- */
(function () {
  const box = document.getElementById('plans'); if (!box) return;
  const lim = (n, u) => (n < 0 ? 'Unlimited ' + u : n.toLocaleString('en-US') + ' ' + u);
  const sto = (mb) => (mb >= 1000 ? (mb / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' GB' : mb + ' MB');
  fetch('/api/plans').then((r) => r.json()).then((d) => {
    document.getElementById('priceSub').textContent = `Every plan starts with a ${d.trialDays}-day free trial. No card needed.`;
    const mid = Math.floor(d.plans.length / 2);
    box.innerHTML = d.plans.map((p, i) => `<article class="plan${i === mid ? ' pop' : ''}"><h3>${p.name}</h3><p class="bl">${p.blurb}</p><div class="pr">${p.price.toLocaleString('en-US')} <small>${p.currency} / month</small></div><ul><li>${lim(p.max_users, 'staff users')}</li><li>${lim(p.max_patients, 'patients')}</li><li>${sto(p.max_storage_mb)} of file storage</li><li>All modules, roles and reports</li><li>Audit log and daily backups</li></ul><a class="btn" href="/signup">Start free trial</a></article>`).join('');
  }).catch(() => { box.innerHTML = '<p class="fine" style="grid-column:1/-1;text-align:center">Pricing could not be loaded. Please refresh.</p>'; });
})();
