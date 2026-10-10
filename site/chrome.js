// Shared by every public page of the website (home, privacy, terms): mobile menu, scroll progress, back to top, ads.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const nav = document.getElementById('nav');
const $ = (id) => document.getElementById(id);
const totop = $('totop');
function onScrollChrome() { nav.classList.toggle('stuck', scrollY > 8); totop.classList.toggle('show', scrollY > 700); }
addEventListener('scroll', onScrollChrome, { passive: true }); onScrollChrome();
totop.addEventListener('click', () => scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }));

/* mobile menu */
const links = $('links'), burger = $('burger');
function closeMenu() { links.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
burger.addEventListener('click', () => { const o = links.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); });
links.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
const yr = $('yr'); if (yr) yr.textContent = new Date().getFullYear();

/* a soft light that follows the pointer on cards */
document.addEventListener('pointermove', (e) => {
  const c = e.target.closest && e.target.closest('.fcard, .plan'); if (!c) return;
  const r = c.getBoundingClientRect(); c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px');
}, { passive: true });

/* ---------- ads: public page only, and only when a publisher id is set (see README). Nothing loads before the visitor chooses. ---------- */
const ADS = window.OPTIX_ADS || null;
if (ADS && /^ca-pub-\d{6,20}$/.test(ADS.client || '')) {
  document.querySelectorAll('[data-ad-choices]').forEach((a) => { a.hidden = false; });
  document.querySelectorAll('.adslot[data-ad]').forEach((box) => {
    const slot = ADS.slots && ADS.slots[box.dataset.ad]; if (!slot) return;
    const ins = document.createElement('ins'); ins.className = 'adsbygoogle'; ins.style.display = 'block';
    ins.setAttribute('data-ad-client', ADS.client); ins.setAttribute('data-ad-slot', slot); ins.setAttribute('data-ad-format', 'auto'); ins.setAttribute('data-full-width-responsive', 'true');
    box.innerHTML = '<small>Advertisement</small>'; box.appendChild(ins); box.hidden = false;
  });
  import('/site/consent.js').then((m) => m.start(ADS)).catch(() => { /* ads are optional */ });
}


/* scroll progress bar */
const prog = document.getElementById('progress');
function onProg() { const h = document.documentElement.scrollHeight - innerHeight; prog.style.width = (h > 0 ? Math.min(100, (scrollY / h) * 100) : 0) + '%'; }
addEventListener('scroll', onProg, { passive: true }); onProg();
