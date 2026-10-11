// The 3D scene in the hero: a glowing DNA helix, a floating medical cross and orbit rings, drawn with three.js.
// It loads AFTER the page has finished loading (three.js is large and the VPS link is slow), so the page is usable first.
// No WebGL, or "reduce motion": the hero keeps its plain gradient and nothing breaks.
import * as THREE from '/site/vendor/three.module.min.js';

const canvas = document.getElementById('hx3d');
const wrap = canvas && canvas.parentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); } catch (e) { renderer = null; }

if (renderer) {
  const small = innerWidth < 900;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  camera.position.set(0, 0, 15);

  scene.add(new THREE.AmbientLight(0xb9ccff, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(4, 6, 7); scene.add(key);
  const rim = new THREE.PointLight(0x38d6c6, 46, 26); rim.position.set(-6, -2, 3); scene.add(rim);
  const blue = new THREE.PointLight(0x5b8cff, 60, 28); blue.position.set(6, 3, 3); scene.add(blue);

  const rig = new THREE.Group(); scene.add(rig);
  const helix = new THREE.Group(); rig.add(helix);
  const N = small ? 46 : 72, H = 7.4, R = 1.05, TURNS = 2.7;
  const sphereGeo = new THREE.SphereGeometry(0.14, small ? 14 : 20, small ? 14 : 20);
  const matA = new THREE.MeshStandardMaterial({ color: 0x5b8cff, emissive: 0x2349c9, emissiveIntensity: 0.85, roughness: 0.22, metalness: 0.25 });
  const matB = new THREE.MeshStandardMaterial({ color: 0x38d6c6, emissive: 0x0f8f85, emissiveIntensity: 0.85, roughness: 0.22, metalness: 0.25 });
  const strandA = new THREE.InstancedMesh(sphereGeo, matA, N), strandB = new THREE.InstancedMesh(sphereGeo, matB, N);
  const rungMat = new THREE.MeshStandardMaterial({ color: 0xd6e2ff, emissive: 0x6d92f0, emissiveIntensity: 0.5, transparent: true, opacity: 0.6, roughness: 0.4 });
  const rungs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 6), rungMat, N);
  helix.add(strandA, strandB, rungs);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), mid = new THREE.Vector3(), dir = new THREE.Vector3();
  function place(t) {
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1), y = (f - 0.5) * H, a = f * TURNS * Math.PI * 2;
      const r = R * (0.9 + 0.14 * Math.sin(f * Math.PI)) * (1 + Math.sin(t * 1.4 + i * 0.35) * 0.05);
      pa.set(Math.cos(a) * r, y, Math.sin(a) * r); pb.set(Math.cos(a + Math.PI) * r, y, Math.sin(a + Math.PI) * r);
      const sc = 0.85 + 0.5 * Math.sin(f * Math.PI) + 0.1 * Math.sin(t * 2 + i * 0.5);
      s.set(sc, sc, sc); q.identity();
      m.compose(pa, q, s); strandA.setMatrixAt(i, m); m.compose(pb, q, s); strandB.setMatrixAt(i, m);
      mid.addVectors(pa, pb).multiplyScalar(0.5); dir.subVectors(pb, pa); const len = dir.length();
      q.setFromUnitVectors(up, dir.normalize()); s.set(1, len, 1); m.compose(mid, q, s); rungs.setMatrixAt(i, m);
    }
    strandA.instanceMatrix.needsUpdate = strandB.instanceMatrix.needsUpdate = rungs.instanceMatrix.needsUpdate = true;
  }
  place(0);

  const cs = new THREE.Shape(), w = 0.3, l = 0.95;
  cs.moveTo(-w, -l); cs.lineTo(w, -l); cs.lineTo(w, -w); cs.lineTo(l, -w); cs.lineTo(l, w); cs.lineTo(w, w); cs.lineTo(w, l); cs.lineTo(-w, l); cs.lineTo(-w, w); cs.lineTo(-l, w); cs.lineTo(-l, -w); cs.lineTo(-w, -w); cs.closePath();
  const crossGeo = new THREE.ExtrudeGeometry(cs, { depth: 0.34, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.07, bevelSegments: 4 }); crossGeo.center();
  const cross = new THREE.Mesh(crossGeo, new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0x5c85ff, emissiveIntensity: 0.5, roughness: 0.15, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.1 }));
  cross.scale.setScalar(0.62); rig.add(cross);

  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.014, 8, 180), new THREE.MeshBasicMaterial({ color: 0x8fb0ff, transparent: true, opacity: 0.45 }));
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.9, 0.011, 8, 180), new THREE.MeshBasicMaterial({ color: 0x38d6c6, transparent: true, opacity: 0.35 }));
  ring1.rotation.x = 1.2; ring2.rotation.set(0.5, 0.45, 0.3); rig.add(ring1, ring2);

  const PN = small ? 110 : 260, pg = new THREE.BufferGeometry(), pp = new Float32Array(PN * 3);
  for (let i = 0; i < PN; i++) { const a = Math.random() * Math.PI * 2, r = 2.4 + Math.random() * 5.5; pp[i * 3] = Math.cos(a) * r; pp[i * 3 + 1] = (Math.random() - 0.5) * 11; pp[i * 3 + 2] = Math.sin(a) * r - 2; }
  pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  const points = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xb8ccff, size: 0.04, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(points);

  function resize() { const w = canvas.clientWidth || 600, h = canvas.clientHeight || 600; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(canvas); resize();

  let tx = 0, ty = 0, cx = 0, cy = 0, visible = true, time = 0, last = performance.now(), running = false;
  addEventListener('pointermove', (e) => { const r = wrap.getBoundingClientRect(); tx = ((e.clientX - r.left) / r.width - 0.5) * 2; ty = ((e.clientY - r.top) / r.height - 0.5) * 2; }, { passive: true });
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) loop(); }).observe(wrap);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) loop(); });

  function frame(dt) {
    time += dt;
    helix.rotation.y = time * 0.35; helix.rotation.z = 0.2; helix.position.y = Math.sin(time * 0.7) * 0.12;
    ring1.rotation.z = time * 0.22; ring2.rotation.z = -time * 0.15;
    cross.position.set(Math.cos(time * 0.6) * 2.5, 1.2 + Math.sin(time * 0.8) * 0.4, Math.sin(time * 0.6) * 2.5);
    cross.rotation.y = time * 0.9; cross.rotation.x = Math.sin(time * 0.5) * 0.3;
    points.rotation.y = time * 0.03;
    cx += (tx - cx) * Math.min(1, dt * 3); cy += (ty - cy) * Math.min(1, dt * 3);
    rig.rotation.y = cx * 0.35; rig.rotation.x = cy * 0.18;
    place(time); renderer.render(scene, camera);
  }
  function loop() {
    if (running) return; running = true;
    const step = (now) => { if (!visible || document.hidden) { running = false; return; } const dt = Math.min(0.05, (now - last) / 1000); last = now; frame(dt); requestAnimationFrame(step); };
    last = performance.now(); requestAnimationFrame(step);
  }
  if (reduced) frame(0.016); else loop();
  canvas.classList.add('on'); wrap.classList.add('has3d');
}
