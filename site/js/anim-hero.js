/* ============================================================
   MedSync HERO — premium animation JS (mxh- prefix)
   Works with assets/anim-hero.css. Never touches index.html.
   - Headline word-by-word stagger (masked rise)
   - Glass-card parallax wrapper (keeps hx- entrance/float intact)
   - Mouse parallax with per-layer depth + lerp smoothing
   - Honors prefers-reduced-motion; parallax off on mobile /
     coarse-pointer devices. No-dependency, ES5-safe.
   ============================================================ */
(function(){
  "use strict";

  var hero=document.querySelector(".hx-hero");
  if(!hero)return;

  function mq(q){
    return (window.matchMedia&&window.matchMedia(q).matches)||false;
  }

  var reduced=mq("(prefers-reduced-motion: reduce)");
  hero.classList.add("mxh-ready");
  if(reduced)return; /* CSS keeps every layer static */

  /* ---- 1. Headline: split into masked words, staggered rise ---- */
  (function(){
    var h1=hero.querySelector(".hx-h1");
    if(!h1)return;
    var frag=document.createDocumentFragment();
    var delay=0.68, step=0.075, words=0;

    function pushWord(text){
      var mask=document.createElement("span");
      mask.className="mxh-wmask";
      var w=document.createElement("span");
      w.className="mxh-w";
      w.textContent=text;
      w.style.setProperty("--mxh-d",delay.toFixed(3)+"s");
      delay+=step;words++;
      mask.appendChild(w);
      frag.appendChild(mask);
    }

    Array.prototype.forEach.call(h1.childNodes,function(n){
      if(n.nodeType===3){
        n.textContent.split(/(\s+)/).forEach(function(part){
          if(!part)return;
          if(/^[\s\u00a0]+$/.test(part)){
            frag.appendChild(document.createTextNode(" "));
          }else{
            pushWord(part);
          }
        });
      }else if(n.nodeName==="BR"){
        frag.appendChild(document.createElement("br"));
      }
    });

    if(!words)return;
    h1.textContent="";
    h1.appendChild(frag);
    hero.classList.add("mxh-h1-on");
  })();

  /* ---- 2. Glass card: wrap for parallax (no animation fights) ---- */
  var glassWrap=null;
  (function(){
    var glass=hero.querySelector(".hx-glass");
    if(!glass||!glass.parentNode)return;
    glassWrap=document.createElement("div");
    glassWrap.className="mxh-glass-wrap";
    glass.parentNode.insertBefore(glassWrap,glass);
    glassWrap.appendChild(glass);
  })();

  /* ---- 3. Mouse parallax: per-layer depth, lerp smoothing ----
     Skipped on mobile (<=768px) and coarse-pointer devices.
     (.hx-photo-wrap already has its own parallax in index.html;
     these are separate layers, no conflict.) */
  var allowParallax=!mq("(max-width: 768px)")&&
                    (mq("(pointer: fine)")||!mq("(pointer: coarse)"));
  if(!allowParallax)return;

  var layers=[
    {el:hero.querySelector(".hx-nav"),    dx:6,  dy:4 },
    {el:hero.querySelector(".hx-content"),dx:14, dy:10},
    {el:hero.querySelector(".hx-badge"),  dx:8,  dy:6 },
    {el:glassWrap,                        dx:26, dy:18}
  ].filter(function(l){return !!l.el;});
  if(!layers.length)return;
  layers.forEach(function(l){l.el.classList.add("mxh-px");});

  var tx=0,ty=0,cx=0,cy=0,raf=0,inView=true;

  function apply(){
    for(var i=0;i<layers.length;i++){
      var l=layers[i];
      l.el.style.transform="translate3d("+
        (cx*l.dx).toFixed(2)+"px,"+(cy*l.dy).toFixed(2)+"px,0)";
    }
  }
  function frame(){
    raf=0;
    cx+=(tx-cx)*0.075;
    cy+=(ty-cy)*0.075;
    if(Math.abs(tx-cx)<0.001&&Math.abs(ty-cy)<0.001){
      cx=tx;cy=ty;apply();return; /* settled: stop the loop */
    }
    apply();
    if(inView)raf=requestAnimationFrame(frame);
  }
  function kick(){
    if(!raf&&inView)raf=requestAnimationFrame(frame);
  }

  hero.addEventListener("mousemove",function(e){
    var r=hero.getBoundingClientRect();
    if(r.width<1||r.height<1)return;
    tx=((e.clientX-r.left)/r.width-0.5)*2;   /* -1..1 */
    ty=((e.clientY-r.top)/r.height-0.5)*2;
    kick();
  });
  hero.addEventListener("mouseleave",function(){
    tx=0;ty=0;kick(); /* ease back to rest */
  });

  if("IntersectionObserver"in window){
    new IntersectionObserver(function(entries){
      inView=entries[0].isIntersecting;
      if(inView)kick();
    },{threshold:0}).observe(hero);
  }
})();
