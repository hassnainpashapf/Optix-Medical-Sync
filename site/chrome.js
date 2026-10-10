// Shared by the public pages: header menu, year, and ads (public pages only, only when a publisher id is set; see README).
const $ = (id) => document.getElementById(id);

/* header menu on the inner pages */
const bar = document.querySelector('.fx-bar'), burger = $('burger');
if (bar && burger) {
  const close = () => { bar.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); };
  burger.addEventListener('click', () => { const o = bar.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); });
  bar.addEventListener('click', (e) => { if (e.target.closest('.fx-menu a')) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
const yr = $('yr'); if (yr) yr.textContent = new Date().getFullYear();

/* ads: nothing loads before the visitor chooses (consent.js) */
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
