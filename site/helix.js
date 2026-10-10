// The decorative 3D helix behind the hero. It is loaded AFTER the page has finished loading (see site.js), because three.js is large
// and the page must be usable before it arrives. If WebGL is not available the page simply has no helix.
import * as THREE from '/site/vendor/three.module.min.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const stage = document.getElementById('stage');

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
