// Optix ads loader — shared by every Optix PUBLIC website (never used inside the signed-in tools).
// Source of truth: optix-suite-sdk/theme/consent.js (copied into each site by its sync script; do not edit the copies).
//
// Nothing from Google is loaded before the visitor chooses. "Accept" shows personalised ads, "Decline" shows non-personalised ads only.
// The choice is kept in this browser (localStorage). For visitors in the EEA, UK and Switzerland Google also requires its own
// certified consent message: turn on "Privacy & messaging" in the AdSense console (it is free) and it shows on top of this.
const KEY = 'optix_ad_consent';
const CLIENT_RE = /^ca-pub-\d{6,20}$/;
const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const put = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: asked again next time */ } };

let loaded = false;
function load(ads, choice) {
  if (loaded || !ads || !CLIENT_RE.test(ads.client || '')) return;
  loaded = true;
  window.adsbygoogle = window.adsbygoogle || [];
  if (choice === 'no') window.adsbygoogle.requestNonPersonalizedAds = 1;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous';
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
  s.onload = () => fillUnits();
  document.head.appendChild(s);
}
export function fillUnits() {
  document.querySelectorAll('ins.adsbygoogle:not([data-optix-done])').forEach((el) => {
    el.setAttribute('data-optix-done', '1');
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* a blocked or failed unit is not an error for the page */ }
  });
}
function banner(ads) {
  const el = document.createElement('div');
  el.className = 'consent'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Advertising choice');
  el.innerHTML = '<p>This website shows ads to keep the guides free. Choose whether the ads may be personalised using cookies. See our <a href="/privacy">Privacy Policy</a>.</p><div class="acts"><button class="btn sm ghost" data-c="no" type="button">Non-personalised</button><button class="btn sm" data-c="yes" type="button">Accept</button></div>';
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; put(b.dataset.c); el.remove(); load(ads, b.dataset.c); });
  document.body.appendChild(el);
}
export function start(ads) {
  if (!ads || !CLIENT_RE.test(ads.client || '')) return;
  const c = get();
  if (c === 'yes' || c === 'no') load(ads, c); else banner(ads);
  document.querySelectorAll('[data-ad-choices]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); try { localStorage.removeItem(KEY); } catch { /* ignore */ } document.querySelector('.consent')?.remove(); banner(ads); }));
}
