// Interactive Anatomical Lungs Hero controller (replaces the old three.js DNA helix).
const stage = document.getElementById('hx3d');
const art = document.getElementById('hxLungsArt');
const pin = document.getElementById('hxLungPin');
const card = document.getElementById('hxLungCard');

if (stage && art) {
  let zoom = 1;
  let panX = 0, panY = 0;
  let tiltX = 0, tiltY = 0;
  const outBtn = stage.querySelector('[data-lung-act="out"]');

  const applyTransform = () => {
    art.style.animation = zoom !== 1 || panX !== 0 || panY !== 0 ? 'none' : '';
    art.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom.toFixed(2)}) rotateX(${tiltY.toFixed(2)}deg) rotateY(${tiltX.toFixed(2)}deg)`;
    if (outBtn) outBtn.classList.toggle('hx-lbtn-muted', zoom <= 1.01);
  };

  stage.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lung-act]');
    if (btn) {
      const act = btn.dataset.lungAct;
      if (act === 'in') zoom = Math.min(1.35, +(zoom + 0.12).toFixed(2));
      else if (act === 'out') zoom = Math.max(0.88, +(zoom - 0.12).toFixed(2));
      else if (act === 'pan') { zoom = 1; panX = 0; panY = 0; tiltX = 0; tiltY = 0; if (card) card.classList.remove('is-hidden'); }
      applyTransform();
      return;
    }
    if (e.target.closest('#hxLungPin') && card) {
      card.classList.toggle('is-hidden');
    }
  });

  if (matchMedia('(pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stage.addEventListener('pointermove', (e) => {
      const r = stage.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      tiltX = px * 8;
      tiltY = -py * 8;
      if (zoom !== 1) applyTransform();
    }, { passive: true });
    stage.addEventListener('pointerleave', () => {
      tiltX = 0;
      tiltY = 0;
      if (zoom !== 1) applyTransform();
    });
  }
}
