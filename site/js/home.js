/* Optix Medical Sync home page: hero, scroll-highlight statement, bento, why steps, tabs, booking check, pricing, FAQ, modules ring.
   Plain script (no modules, no libraries). Motion honours prefers-reduced-motion. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ---------- hero: burger + soft photo parallax ---------- */
  (function () {
    var root = $('.hx-hero'); if (!root) return;
    var burger = $('.hx-burger', root), nav = $('.hx-nav', root);
    if (burger && nav) {
      burger.addEventListener('click', function () {
        var open = nav.classList.toggle('hx-open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
        burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      });
      nav.addEventListener('click', function (e) { if (e.target.closest('.hx-links a, .hx-actions a')) { nav.classList.remove('hx-open'); burger.setAttribute('aria-expanded', 'false'); } });
    }
    if (!fine || reduce) return;
    var wrap = $('.hx-photo-wrap', root), tx = 0, ty = 0, cx = 0, cy = 0, raf = null;
    function loop() {
      cx += (tx - cx) * .06; cy += (ty - cy) * .06;
      wrap.style.transform = 'translate(' + cx.toFixed(2) + 'px,' + cy.toFixed(2) + 'px)';
      if (Math.abs(tx - cx) > .05 || Math.abs(ty - cy) > .05) raf = requestAnimationFrame(loop); else raf = null;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    root.addEventListener('mousemove', function (e) { var r = root.getBoundingClientRect(); tx = ((e.clientX - r.left) / r.width - .5) * 16; ty = ((e.clientY - r.top) / r.height - .5) * 12; kick(); });
    root.addEventListener('mouseleave', function () { tx = 0; ty = 0; kick(); });
  })();

  /* ---------- statement: words light up as it scrolls into view ---------- */
  (function () {
    var sec = $('.st-section'); if (!sec) return;
    var toks = $$('.st-tok', sec), n = toks.length, ticking = false;
    function paint(p) { for (var i = 0; i < n; i++) { var on = reduce ? true : (p * n >= i + .55); if (toks[i].classList.contains('on') !== on) toks[i].classList.toggle('on', on); } }
    function update() {
      ticking = false;
      var r = sec.getBoundingClientRect(), vh = window.innerHeight || 800, start = vh * .88, end = vh * .30;
      var p = (start - r.top) / (start - end); p = p < 0 ? 0 : (p > 1 ? 1 : p); paint(p);
    }
    function request() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
    addEventListener('scroll', request, { passive: true }); addEventListener('resize', request); update();
  })();

  /* ---------- bento: rise on scroll + soft tilt ---------- */
  (function () {
    var sec = $('.bn-section'); if (!sec) return;
    var rises = $$('.bn-rise', sec);
    if (reduce || !('IntersectionObserver' in window)) rises.forEach(function (el) { el.classList.add('bn-in'); });
    else {
      rises.forEach(function (el, i) { el.style.transitionDelay = (i * .1) + 's'; });
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('bn-in'); io.unobserve(e.target); } }); }, { threshold: .15, rootMargin: '0px 0px -40px 0px' });
      rises.forEach(function (el) { io.observe(el); });
    }
    if (fine && !reduce) $$('[data-tilt]', sec).forEach(function (card) {
      card.addEventListener('mousemove', function (ev) {
        if (!card.classList.contains('bn-in')) return;
        var r = card.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width - .5, py = (ev.clientY - r.top) / r.height - .5;
        card.style.transition = 'transform .12s ease-out';
        card.style.transform = 'perspective(900px) rotateX(' + (-py * 7).toFixed(2) + 'deg) rotateY(' + (px * 7).toFixed(2) + 'deg)';
      });
      card.addEventListener('mouseleave', function () { card.style.transition = 'transform .55s cubic-bezier(.2,.7,.3,1)'; card.style.transform = ''; });
    });
  })();

  var root = $('.rx-root'); if (!root) return;

  /* ---------- tilt reveals + word-rise headings ---------- */
  var tio = ('IntersectionObserver' in window) ? new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('rx-in'); tio.unobserve(e.target); } }); }, { threshold: .12 }) : null;
  function watch(el) { if (tio) tio.observe(el); else el.classList.add('rx-in'); }
  $$('.rx-tilt', root).forEach(watch);
  function splitWords(el) {
    var frag = document.createDocumentFragment(), wi = 0;
    function wrapUnit(node) {
      var w = document.createElement('span'); w.className = 'rx-w';
      var i = document.createElement('span'); i.className = 'rx-wi'; i.style.setProperty('--rx-wi', wi++); i.appendChild(node);
      w.appendChild(i); frag.appendChild(w); frag.appendChild(document.createTextNode(' '));
    }
    Array.prototype.forEach.call(el.childNodes, function (n) {
      if (n.nodeType === 3) n.textContent.split(/\s+/).filter(Boolean).forEach(function (t) { wrapUnit(document.createTextNode(t)); });
      else if (n.nodeType === 1 && n.tagName === 'BR') frag.appendChild(n.cloneNode(true));
      else if (n.nodeType === 1) wrapUnit(n.cloneNode(true));
    });
    el.innerHTML = ''; el.appendChild(frag); el.classList.add('rx-split'); watch(el);
  }
  $$('h2[data-rx-words]', root).forEach(splitWords);

  /* ---------- request / visit / bill steps ---------- */
  (function () {
    var btns = $$('[data-rx-stepbtn]'), phs = $$('[data-rx-ph]'), fls = $$('[data-rx-fl]'), panels = $$('[data-rx-panel]'), card = $('#rxPhotoCard'), grid = $('#rxWhyGrid'), cur = 1, timer = null;
    function show(n) {
      cur = n;
      btns.forEach(function (b) { b.classList.toggle('rx-on', +b.dataset.rxStepbtn === n); });
      phs.forEach(function (p) { p.classList.toggle('rx-on', +p.dataset.rxPh === n); });
      fls.forEach(function (f) { f.classList.toggle('rx-on', +f.dataset.rxFl === n); });
      panels.forEach(function (p) { p.classList.toggle('rx-on', +p.dataset.rxPanel === n); });
      card.classList.remove('rx-s1', 'rx-s2', 'rx-s3'); card.classList.add('rx-s' + n);
    }
    function auto() { clearInterval(timer); if (!reduce) timer = setInterval(function () { show(cur % 3 + 1); }, 6500); }
    btns.forEach(function (b) { b.addEventListener('click', function () { show(+b.dataset.rxStepbtn); auto(); }); });
    grid.addEventListener('mouseenter', function () { clearInterval(timer); });
    grid.addEventListener('mouseleave', auto);
    show(1);
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { if (es[0].isIntersecting) auto(); else clearInterval(timer); }, { threshold: .3 }).observe(grid); else auto();
  })();

  /* ---------- tab groups: modules and roles ---------- */
  var tabTimers = {};
  $$('[data-tabs]', root).forEach(function (bar) {
    var key = bar.dataset.tabs, btns = $$('.rx-tabbtn', bar), panels = $$('.rx-tabpanel', $('[data-panels="' + key + '"]', root)), cur = 0, user = false;
    function select(i, byUser) {
      cur = i; if (byUser) { user = true; clearInterval(tabTimers[key]); }
      btns.forEach(function (b, k) { b.classList.toggle('rx-on', k === i); b.setAttribute('aria-selected', String(k === i)); });
      panels.forEach(function (p, k) { p.classList.toggle('rx-on', k === i); });
    }
    btns.forEach(function (b, i) { b.addEventListener('click', function () { select(i, true); }); });
    select(0);
    if (key === 'mod' && !reduce && 'IntersectionObserver' in window) new IntersectionObserver(function (es) {
      clearInterval(tabTimers[key]);
      if (es[0].isIntersecting && !user) tabTimers[key] = setInterval(function () { select((cur + 1) % btns.length); }, 5000);
    }, { threshold: .45 }).observe($('#explore', root));
  });

  /* ---------- booking check (same rules as the app) ---------- */
  (function () {
    var simDays = $('#simDays'); if (!simDays) return;
    var simGrid = $('#simGrid'), simMsg = $('#simMsg'), simDoc = $('#simDoc'), simVis = $('#simVis');
    var DOCS = [
      { name: 'Dr. Sarah Ali', days: [1, 0, 1, 1, 1, 0, 1], busy: { 3: [['09:00', 45], ['10:30', 30], ['15:00', 45]], 1: [['11:00', 45]], 4: [['09:30', 45]] } },
      { name: 'Dr. Tariq Al-Hakim', days: [1, 1, 1, 1, 0, 1, 0], busy: { 2: [['08:30', 45], ['16:00', 45]], 3: [['10:00', 60]], 1: [['14:30', 30]] } },
      { name: 'Dr. Amir Al-Farsi', days: [0, 1, 1, 1, 1, 1, 1], busy: { 2: [['09:00', 45], ['09:45', 45]], 4: [['11:30', 45]], 5: [['13:00', 30]] } }
    ];
    var DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], simDay = 3, simPick = '';
    function mins(t) { return +t.slice(0, 2) * 60 + +t.slice(3); }
    function hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
    function fmt12(t) { var h = +t.slice(0, 2); return ((h % 12) || 12) + ':' + t.slice(3) + (h < 12 ? ' am' : ' pm'); }
    function check(t) {
      var d = DOCS[+simDoc.value], dur = +simVis.value, s0 = mins(t), e0 = s0 + dur;
      if (!d.days[simDay]) return [false, d.name + ' does not work on ' + DAYN[simDay] + 's.'];
      if (s0 < 840 && e0 > 780) return [false, 'That time overlaps the 1:00 to 2:00 pm break.'];
      if (e0 > 1080) return [false, 'The visit would run past the end of the day (6:00 pm).'];
      var bs = d.busy[simDay] || [];
      for (var k = 0; k < bs.length; k++) { var b0 = mins(bs[k][0]), b1 = b0 + bs[k][1]; if (s0 < b1 && e0 > b0) return [false, d.name + ' already has an appointment at ' + fmt12(bs[k][0]) + '.']; }
      return [true, 'Booked. ' + d.name + ' is free from ' + fmt12(t) + ' to ' + fmt12(hm(e0)) + '.'];
    }
    function render() {
      var d = DOCS[+simDoc.value];
      simDays.innerHTML = DAYN.map(function (n, i) { return '<button type="button" class="' + (i === simDay ? 'on' : '') + (d.days[i] ? '' : ' off') + '" data-d="' + i + '" aria-pressed="' + (i === simDay) + '">' + n + '</button>'; }).join('');
      var h = '';
      for (var m = 480; m < 1080; m += 30) {
        var t = hm(m), busy = (d.busy[simDay] || []).some(function (b) { return m >= mins(b[0]) && m < mins(b[0]) + b[1]; }), brk = m >= 780 && m < 840;
        h += '<button type="button" data-t="' + t + '" class="' + (busy ? 'busy' : brk ? 'brk' : '') + (t === simPick ? ' pick' : '') + '">' + fmt12(t).replace(' ', '') + '</button>';
      }
      simGrid.innerHTML = h;
      if (simPick) { var r = check(simPick); simMsg.textContent = r[1]; simMsg.className = 'sim-msg ' + (r[0] ? 'ok' : 'bad'); }
      else { simMsg.textContent = 'Choose a time to check it. Red slots are already taken, striped slots are the break.'; simMsg.className = 'sim-msg'; }
    }
    simDays.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { simDay = +b.dataset.d; render(); } });
    simGrid.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { simPick = b.dataset.t; render(); } });
    simDoc.addEventListener('change', render); simVis.addEventListener('change', render);
    render();
  })();

  /* ---------- pricing from the platform (/api/plans) ---------- */
  (function () {
    var box = $('#plans'); if (!box) return;
    var tick = '<span class="rx-check"><svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5 6 11l5.5-7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg></span>';
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function lim(n, u) { return n < 0 ? 'Unlimited ' + u : n.toLocaleString('en-US') + ' ' + u; }
    function sto(mb) { return mb >= 1000 ? (mb / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' GB' : mb + ' MB'; }
    fetch('/api/plans').then(function (r) { return r.json(); }).then(function (d) {
      $('#priceSub').textContent = 'Every plan starts with a ' + d.trialDays + '-day free trial. No card needed.';
      var mid = Math.floor(d.plans.length / 2);
      box.innerHTML = d.plans.map(function (p, i) {
        var hot = i === mid;
        return '<div class="rx-price-card' + (hot ? ' rx-hot' : '') + ' rx-tilt" style="--rx-d:' + (i * .1) + 's">' + (hot ? '<span class="rx-pop-tag">Most popular</span>' : '') +
          '<h3>' + esc(p.name) + '</h3><p class="rx-p-sub">' + esc(p.blurb) + '</p>' +
          '<div class="rx-amount"><b>' + p.price.toLocaleString('en-US') + '</b><span>' + esc(p.currency) + ' / month</span></div>' +
          '<ul class="rx-plan-list"><li>' + tick + lim(p.max_users, 'staff users') + '</li><li>' + tick + lim(p.max_patients, 'patients') + '</li><li>' + tick + sto(p.max_storage_mb) + ' of file storage</li><li>' + tick + 'All modules, roles and reports</li><li>' + tick + 'Audit log and daily backups</li></ul>' +
          '<a class="rx-btn-plan" href="/signup">Start free trial</a></div>';
      }).join('');
      $$('.rx-tilt', box).forEach(watch);
    }).catch(function () { box.innerHTML = '<p class="rx-fine" style="grid-column:1/-1">Pricing could not be loaded. Please refresh.</p>'; });
  })();

  /* ---------- FAQ accordion ---------- */
  $$('.rx-faq-item', root).forEach(function (f) {
    var btn = $('.rx-faq-q', f), ans = $('.rx-faq-a', f);
    if (f.classList.contains('rx-open')) ans.style.maxHeight = ans.scrollHeight + 'px';
    btn.setAttribute('aria-expanded', f.classList.contains('rx-open') ? 'true' : 'false');
    btn.addEventListener('click', function () {
      var open = f.classList.contains('rx-open');
      $$('.rx-faq-item.rx-open', root).forEach(function (o) { o.classList.remove('rx-open'); $('.rx-faq-a', o).style.maxHeight = null; $('.rx-faq-q', o).setAttribute('aria-expanded', 'false'); });
      if (!open) { f.classList.add('rx-open'); ans.style.maxHeight = ans.scrollHeight + 'px'; btn.setAttribute('aria-expanded', 'true'); }
    });
  });

  /* ---------- modules ring ---------- */
  (function () {
    var layer = $('#rxChipLayer'), svg = $('#rxNetSvg'); if (!layer || !svg) return;
    var ns = 'http://www.w3.org/2000/svg';
    var chips = [
      { x: 12, y: 14, g: '📅', t: 'Appointments' }, { x: 30, y: 14, g: '🗓️', t: 'Calendar' },
      { x: 70, y: 14, g: '🧑‍⚕️', t: 'Patients' }, { x: 88, y: 14, g: '🧪', t: 'Lab reports' },
      { x: 9, y: 50, g: '💳', t: 'Billing' }, { x: 28, y: 50, g: '🧾', t: 'Receipts' },
      { x: 72, y: 50, g: '🚚', t: 'Suppliers' }, { x: 90, y: 50, g: '📦', t: 'Stock' },
      { x: 12, y: 86, g: '🩺', t: 'Equipment' }, { x: 30, y: 86, g: '📊', t: 'Reports' },
      { x: 70, y: 86, g: '🛡️', t: 'Audit log' }
    ];
    chips.forEach(function (c, i) {
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', 50); line.setAttribute('y1', 50); line.setAttribute('x2', c.x); line.setAttribute('y2', c.y); svg.appendChild(line);
      var d = document.createElement('div'); d.className = 'rx-chip lab rx-pop';
      d.innerHTML = '<i aria-hidden="true">' + c.g + '</i><span>' + c.t + '</span>';
      d.style.left = c.x + '%'; d.style.top = c.y + '%'; d.style.setProperty('--rx-d', (.15 + i * .06) + 's'); layer.appendChild(d);
    });
  })();

  /* ---------- smooth in-page anchors ---------- */
  $$('a[href^="#"]').forEach(function (a) {
    var h = a.getAttribute('href'); if (h.length < 2) return;
    a.addEventListener('click', function (e) { var t = document.querySelector(h); if (t) { e.preventDefault(); t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); } });
  });
})();
