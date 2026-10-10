/* ==========================================================================
   MedSync — scroll/interaction animation layer (below-hero sections)
   File: assets/anim-scroll.js
   - Adds classes only; never touches existing logic or inline styles except
     where explicitly restored (testimonial drag, magnetic buttons).
   - All motion is transform/opacity. Honors prefers-reduced-motion.
   ========================================================================== */
(function(){
"use strict";

/* QA-FIX: gate the CSS reveal-hidden state on JS actually running.
   anim-scroll.css hides .mxs-reveal* only under html.mxs-js, so if this
   file fails to load the page content stays visible. */
if(document.documentElement&&document.documentElement.classList){
  document.documentElement.classList.add('mxs-js');
}

var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
var hasIO = 'IntersectionObserver' in window;

function qa(s, c){ return Array.prototype.slice.call((c || document).querySelectorAll(s)); }
function hasOwnReveal(el){
  return el.classList.contains('rx-tilt') || el.classList.contains('bn-rise') ||
         el.classList.contains('rx-pop') || el.classList.contains('mxs-reveal') ||
         el.classList.contains('mxs-reveal-l') || el.classList.contains('mxs-reveal-r') ||
         el.classList.contains('mxs-reveal-z');
}

/* ---------- 1. Buttery IntersectionObserver reveals ---------- */
(function reveals(){
  // [selector, variant class, stagger seconds]
  var groups = [
    ['.rx-faq-item', 'mxs-reveal', 0.08],
    ['.rx-f-col, .rx-f-brand, .rx-news', 'mxs-reveal', 0.09],
    ['.rx-cta .rx-wrap', 'mxs-reveal-z', 0],
    ['.rx-billing', 'mxs-reveal', 0],
    ['.rx-tabbtn', 'mxs-reveal', 0.06],
    ['.rx-sol-row', 'mxs-reveal', 0.07],
    ['.rx-stepbtn', 'mxs-reveal', 0.08]
  ];
  var els = [];
  groups.forEach(function(g){
    qa(g[0]).forEach(function(el, i){
      if (hasOwnReveal(el)) return;
      // stay out of the hero entirely
      if (el.closest && el.closest('.hx-hero')) return;
      el.classList.add(g[1]);
      if (g[2]) el.style.setProperty('--mxs-d', (i * g[2]).toFixed(2) + 's');
      els.push(el);
    });
  });
  if (!els.length) return;
  if (reduce || !hasIO){
    els.forEach(function(el){ el.classList.add('mxs-in'); });
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting){ e.target.classList.add('mxs-in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach(function(el){ io.observe(el); });
})();

/* ---------- 2. Animated counters (opt-in via [data-mxs-count]) ----------
   Usage: <b data-mxs-count="98" data-mxs-suffix="%">0%</b>
   data-mxs-prefix / data-mxs-dec (decimals) also supported.
   Dormant when no such elements exist (current build has no stats block). */
(function counters(){
  var els = qa('[data-mxs-count]');
  if (!els.length) return;
  function fmt(v, dec){
    return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function run(el){
    var target = parseFloat(el.getAttribute('data-mxs-count')) || 0;
    var dec = parseInt(el.getAttribute('data-mxs-dec') || '0', 10);
    var pre = el.getAttribute('data-mxs-prefix') || '';
    var suf = el.getAttribute('data-mxs-suffix') || '';
    if (reduce){ el.textContent = pre + fmt(target, dec) + suf; return; }
    var t0 = null, dur = 1400;
    function frame(t){
      if (!t0) t0 = t;
      var p = Math.min((t - t0) / dur, 1);
      var e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = pre + fmt(target * e, dec) + suf;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if (reduce || !hasIO){ els.forEach(run); return; }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting){ run(e.target); io.unobserve(e.target); }
    });
  }, { threshold: 0.4 });
  els.forEach(function(el){ io.observe(el); });
})();

/* ---------- 3. Cursor spotlight on feature/pricing cards ----------
   The existing [data-tilt] 3D tilt writes inline transform; this layer only
   moves a ::after overlay via CSS vars, so the two never fight. */
(function spotlight(){
  if (!fine || reduce) return;
  var cards = qa('.bn-card[data-tilt], .rx-price-card');
  cards.forEach(function(card){
    card.classList.add('mxs-spot');
    var raf = 0;
    card.addEventListener('mousemove', function(ev){
      if (raf) return;
      raf = requestAnimationFrame(function(){
        raf = 0;
        var r = card.getBoundingClientRect();
        var x = ((ev.clientX - r.left) / r.width * 100).toFixed(1);
        var y = ((ev.clientY - r.top) / r.height * 100).toFixed(1);
        card.style.setProperty('--mxs-x', x + '%');
        card.style.setProperty('--mxs-y', y + '%');
      });
    }, { passive: true });
  });
})();

/* ---------- 4. Testimonial carousel: drag/swipe motion layer ----------
   Reuses the existing prev/next buttons (their handlers already reset the
   6s auto-advance timer), so carousel logic is untouched. */
(function tDrag(){
  var grid = document.getElementById('rxTGrid');
  var quote = document.getElementById('rxTQuote');
  var prev = document.getElementById('rxTPrev');
  var next = document.getElementById('rxTNext');
  if (!grid || !quote || !prev || !next || reduce) return;
  var dragging = false, startX = 0, dx = 0, suppressClick = false;

  grid.addEventListener('pointerdown', function(ev){
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    dragging = true; startX = ev.clientX; dx = 0;
    try { grid.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  grid.addEventListener('pointermove', function(ev){
    if (!dragging) return;
    dx = ev.clientX - startX;
    if (Math.abs(dx) > 4){
      grid.classList.add('mxs-dragging');
      quote.style.transition = 'none';
      quote.style.transform = 'translateX(' + dx.toFixed(1) + 'px)';
    }
  }, { passive: true });
  function end(ev){
    if (!dragging) return;
    dragging = false;
    grid.classList.remove('mxs-dragging');
    quote.style.transition = '';
    quote.style.transform = '';
    if (Math.abs(dx) > 60){
      suppressClick = true; // swallow the click that follows a real swipe
      if (dx < 0) next.click(); else prev.click();
      setTimeout(function(){ suppressClick = false; }, 50);
    }
    dx = 0;
  }
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
  grid.addEventListener('click', function(ev){
    if (suppressClick){ ev.stopPropagation(); ev.preventDefault(); }
  }, true);
})();

/* ---------- 5. Magnetic buttons + shine (additive; no existing hover touched) ---------- */
(function magnetic(){
  if (!fine || reduce) return;
  var btns = qa('.rx-btn-blue, .rx-btn-sky, .bn-pill, .rx-btn-plan, .rx-bill-btn');
  btns.forEach(function(b){
    if (b.closest && b.closest('.hx-hero')) return; // hero out of scope
    b.classList.add('mxs-mag', 'mxs-shine');
    var raf = 0, mx = 0, my = 0;
    b.addEventListener('mousemove', function(ev){
      var r = b.getBoundingClientRect();
      mx = ev.clientX - (r.left + r.width / 2);
      my = ev.clientY - (r.top + r.height / 2);
      if (raf) return;
      raf = requestAnimationFrame(function(){
        raf = 0;
        var x = Math.max(-7, Math.min(7, mx * 0.22));
        var y = Math.max(-7, Math.min(7, my * 0.22));
        b.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      });
    }, { passive: true });
    b.addEventListener('mouseleave', function(){
      if (raf){ cancelAnimationFrame(raf); raf = 0; }
      b.style.transform = '';
    });
  });
})();

})();
