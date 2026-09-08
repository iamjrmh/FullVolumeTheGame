/* ============================================================
   FULL VOLUME - fullvolumethegame.xyz

   Motion rules followed throughout:
     - transform / opacity only, so everything composites on the GPU
     - transitions (retargetable) over keyframes for anything a
       person can interrupt
     - reduced motion is honoured by skipping movement, not content
   ============================================================ */
(function () {
  "use strict";

  /* Pages now live at two depths (/, /Marketplace/), so anything this file
     fetches has to be resolved against the site root rather than the page. */
  var ROOT = (function () {
    var self = document.currentScript;
    var src = self && self.src;
    if (!src) return "";
    return src.replace(/js\/main\.js.*$/, "");
  })();

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var prefersReduced = function () { return reduceMotion.matches; };
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  /* ----------------------------------------------------------
     1. HERO ENTRANCE
     Rare / first-time motion, so a little delight is allowed.
     Stagger is 70ms per step; see the transition-delays in CSS.
     ---------------------------------------------------------- */
  requestAnimationFrame(function () {
    document.body.classList.add("is-ready");
  });

  /* ----------------------------------------------------------
     2. HERO BACKDROP VIDEO
     21MB, so it is never part of the initial load. The still is
     the poster; the loop is fetched once the page is idle and
     crossfades in only when it can actually play.
     ---------------------------------------------------------- */
  (function loadBackdrop() {
    var video = document.getElementById("heroVideo");
    if (!video || prefersReduced()) return;

    // Skip it entirely on a metered or slow connection.
    var conn = navigator.connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ""))) return;

    var start = function () {
      video.src = ROOT + "assets/video/room-loop.mp4";
      video.addEventListener("canplay", function () {
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () { /* autoplay refused; the still stays */ });
        video.classList.add("is-ready");
      }, { once: true });
      video.load();
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(start, { timeout: 2500 });
    } else {
      window.addEventListener("load", function () { setTimeout(start, 600); });
    }
  })();

  /* ----------------------------------------------------------
     3. HERO PARALLAX
     Subtle, transform-only, and read once per frame rather than
     once per scroll event so it cannot thrash layout.
     ---------------------------------------------------------- */
  (function parallax() {
    var bg = document.getElementById("heroBg");
    if (!bg || prefersReduced()) return;

    var latest = 0, ticking = false;

    var apply = function () {
      ticking = false;
      // Only while the hero is anywhere near the viewport.
      if (latest > window.innerHeight * 1.2) return;
      bg.style.transform = "translate3d(0," + (latest * 0.16).toFixed(2) + "px,0)";
    };

    window.addEventListener("scroll", function () {
      latest = window.scrollY;
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    }, { passive: true });
  })();

  /* ----------------------------------------------------------
     4. SCROLL REVEAL
     One-shot. Elements settle and are then left alone - nothing
     re-animates on the way back up, which is just noise.
     ---------------------------------------------------------- */
  (function reveal() {
    var items = document.querySelectorAll("[data-reveal]");
    if (!items.length) return;

    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }

    var seen = new WeakMap();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;

        // 60ms cascade between siblings revealed in the same pass.
        var parent = entry.target.parentElement;
        var n = seen.get(parent) || 0;
        seen.set(parent, n + 1);
        entry.target.style.transitionDelay = Math.min(n * 60, 240) + "ms";

        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

    items.forEach(function (el) { io.observe(el); });
  })();

  /* ----------------------------------------------------------
     5. COUNTERS
     Tick up once, when the number is on screen. Tabular figures
     in CSS keep the layout from twitching as digits change.
     ---------------------------------------------------------- */
  (function counters() {
    var nums = document.querySelectorAll("[data-count]");
    if (!nums.length) return;

    var settle = function (el) {
      var target = parseInt(el.getAttribute("data-count"), 10);
      if (isNaN(target)) return;

      // A trailing "+" is part of the claim, not decoration, so it rides
      // along with every frame rather than being pinned on at the end.
      var suffix = el.getAttribute("data-count-suffix") || "";
      var show = function (n) { el.textContent = n.toLocaleString() + suffix; };

      if (prefersReduced()) { show(target); return; }

      var duration = 1100, started = null;
      var step = function (now) {
        if (started === null) started = now;
        var t = Math.min((now - started) / duration, 1);
        // ease-out cubic, matching the CSS curve's character
        var eased = 1 - Math.pow(1 - t, 3);
        show(Math.round(target * eased));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (!("IntersectionObserver" in window)) {
      nums.forEach(settle);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        settle(e.target);
        io.unobserve(e.target);
      });
    }, { threshold: 0.5 });

    nums.forEach(function (el) { io.observe(el); });
  })();

  /* ----------------------------------------------------------
     6. STICKY NAV + CURRENT SECTION
     ---------------------------------------------------------- */
  (function nav() {
    var bar = document.getElementById("nav");
    if (!bar) return;

    var ticking = false;
    var onScroll = function () {
      ticking = false;
      bar.classList.toggle("is-stuck", window.scrollY > 24);
    };
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
    }, { passive: true });
    onScroll();

    // Highlight the section you are actually looking at.
    var links = Array.prototype.slice.call(document.querySelectorAll(".nav__links a"));
    var sections = links
      .filter(function (a) { return (a.getAttribute("href") || "").charAt(0) === "#"; })
      .map(function (a) { return document.querySelector(a.getAttribute("href")); })
      .filter(Boolean);

    if (!sections.length || !("IntersectionObserver" in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) {
          a.classList.toggle("is-active", a.getAttribute("href") === "#" + e.target.id);
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });

    sections.forEach(function (s) { io.observe(s); });
  })();

  /* ----------------------------------------------------------
     7. MOBILE MENU
     ---------------------------------------------------------- */
  (function mobileMenu() {
    var burger = document.getElementById("burger");
    var menu = document.getElementById("mobile-menu");
    if (!burger || !menu) return;

    var setOpen = function (open) {
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.hidden = !open;
    };

    burger.addEventListener("click", function () {
      setOpen(burger.getAttribute("aria-expanded") !== "true");
    });

    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    // Escape always gets you out.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && burger.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        burger.focus();
      }
    });
  })();

  /* ----------------------------------------------------------
     8. SCREENSHOT GALLERY
     A CSS transition on the track, not keyframes, so a fast
     second click retargets from where it is instead of snapping
     back to zero. Drag works with the pointer captured, so it
     survives the cursor leaving the element.
     ---------------------------------------------------------- */
  (function gallery() {
    var viewport = document.getElementById("galleryViewport");
    var track = document.getElementById("galleryTrack");
    var dotsHost = document.getElementById("galleryDots");
    var prev = document.getElementById("galleryPrev");
    var next = document.getElementById("galleryNext");
    if (!viewport || !track) return;

    var real = Array.prototype.slice.call(track.children);
    var count = real.length;
    if (!count) return;

    // Ring, not a strip: a copy of the whole set sits either side of the real
    // one, so there is always something to slide onto in both directions. Once
    // a move lands in a copy we shift the index by one full set - the slide
    // under the eye is identical, so the reset is invisible.
    function bank() {
      real.forEach(function (li) {
        var c = li.cloneNode(true);
        c.setAttribute("aria-hidden", "true");
        c.classList.add("is-clone");
        c.querySelectorAll("img").forEach(function (img) { img.setAttribute("loading", "lazy"); });
        track.appendChild(c);
      });
    }
    bank();                                   // trailing copy
    var lead = document.createDocumentFragment();
    real.forEach(function (li) {
      var c = li.cloneNode(true);
      c.setAttribute("aria-hidden", "true");
      c.classList.add("is-clone");
      lead.appendChild(c);
    });
    track.insertBefore(lead, track.firstChild);

    var slides = Array.prototype.slice.call(track.children);
    var index = count;                        // the first real slide
    var dots = [];
    var settle = null;

    function wrap(i) { return ((i % count) + count) % count; }

    real.forEach(function (_, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-label", "Screenshot " + (i + 1) + " of " + count);
      b.addEventListener("click", function () { jumpTo(i); });
      dotsHost.appendChild(b);
      dots.push(b);
    });

    function offsetFor(i) {
      // Centre the chosen slide in the viewport, so the neighbours peek by the
      // same amount on both sides instead of the strip hanging off to the left.
      var s = slides[i];
      return (viewport.clientWidth / 2) - (s.offsetLeft + s.offsetWidth / 2);
    }

    function paint() {
      track.style.transform = "translate3d(" + offsetFor(index) + "px,0,0)";
      slides.forEach(function (s, i) { s.classList.toggle("is-current", i === index); });
      var live = wrap(index);
      dots.forEach(function (d, i) { d.setAttribute("aria-selected", String(i === live)); });
    }

    // Snap back into the middle set without animating. Same picture, new index.
    function recentre() {
      if (index >= count && index < count * 2) return;
      index = count + wrap(index);
      track.classList.add("no-anim");
      paint();
      void track.offsetWidth;                 // commit before the transition returns
      track.classList.remove("no-anim");
    }

    function schedule() {
      clearTimeout(settle);
      settle = setTimeout(recentre, 460);     // just past the 420ms track transition
    }

    function step(delta) {
      var target = index + delta;
      // Never walk off the end of the three sets, however fast the clicking is.
      if (target < 0 || target > slides.length - 1) { recentre(); target = index + delta; }
      index = target;
      paint();
      schedule();
    }

    // A dot goes to the nearest copy of that slide, so picking one never
    // scrolls the length of the whole strip to get there.
    function jumpTo(i) {
      var best = count + i, span = Math.abs(best - index);
      [i, count * 2 + i].forEach(function (c) {
        if (Math.abs(c - index) < span) { best = c; span = Math.abs(c - index); }
      });
      index = best;
      paint();
      schedule();
    }

    if (prev) prev.addEventListener("click", function () { step(-1); });
    if (next) next.addEventListener("click", function () { step(1); });

    viewport.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); step(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    });

    // --- drag / swipe ---
    var dragging = false, startX = 0, startT = 0, moved = 0, base = 0;

    viewport.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      clearTimeout(settle);
      recentre();
      dragging = true;
      moved = 0;
      startX = e.clientX;
      startT = performance.now();
      base = offsetFor(index);
      track.classList.add("no-anim");
      viewport.classList.add("is-dragging");
      viewport.setPointerCapture(e.pointerId);
    });

    viewport.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      moved = e.clientX - startX;
      // No edges to resist against on a ring, so the strip follows the finger.
      track.style.transform = "translate3d(" + (base + moved) + "px,0,0)";
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("no-anim");
      viewport.classList.remove("is-dragging");
      if (e && e.pointerId !== undefined && viewport.hasPointerCapture(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId);
      }

      // A flick should be enough; do not demand a distance threshold.
      var elapsed = Math.max(1, performance.now() - startT);
      var velocity = Math.abs(moved) / elapsed;
      var far = Math.abs(moved) > slides[0].offsetWidth * 0.22;

      if (velocity > 0.4 || far) step(moved < 0 ? 1 : -1);
      else { paint(); schedule(); }
    }

    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);

    // A drag must not also fire the link/click underneath.
    viewport.addEventListener("click", function (e) {
      if (Math.abs(moved) > 6) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    window.addEventListener("resize", function () {
      track.classList.add("no-anim");
      paint();
      requestAnimationFrame(function () { track.classList.remove("no-anim"); });
    });

    track.classList.add("no-anim");
    paint();
    requestAnimationFrame(function () { track.classList.remove("no-anim"); });
  })();

  /* ----------------------------------------------------------
     9. THE GAME'S BUTTON SOUNDS
     The same two clips MenuButton.cs plays. Off until asked for -
     a page that makes noise at you unprompted is a page people
     close - and the choice is remembered.
     ---------------------------------------------------------- */
  (function buttonSfx() {
    var toggle = document.getElementById("sfxToggle");
    if (!toggle) return;

    var KEY = "fv.sfx";
    var on = false;
    try { on = localStorage.getItem(KEY) === "1"; } catch (err) { /* private mode */ }

    var clips = {};
    var load = function (name, volume) {
      var a = new Audio(ROOT + "assets/sfx/" + name + ".mp3");
      a.preload = "none";
      a.volume = volume;
      clips[name] = a;
    };
    load("button-hover", 0.28);
    load("button-click", 0.42);

    var play = function (name) {
      if (!on) return;
      var clip = clips[name];
      if (!clip) return;
      try {
        clip.currentTime = 0;
        var p = clip.play();
        if (p && p.catch) p.catch(function () { /* not gestured yet */ });
      } catch (err) { /* nothing worth breaking the page over */ }
    };

    var paint = function () {
      toggle.setAttribute("aria-pressed", String(on));
      toggle.title = on
        ? "Button sounds on - the game's own clips"
        : "Play the game's own button sounds";
    };

    toggle.addEventListener("click", function () {
      on = !on;
      try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (err) { /* ignore */ }
      paint();
      if (on) { clips["button-hover"].preload = "auto"; clips["button-click"].preload = "auto"; play("button-click"); }
    });
    paint();

    var plates = document.querySelectorAll(".plate");

    if (finePointer.matches) {
      plates.forEach(function (el) {
        el.addEventListener("pointerenter", function () {
          if (el.disabled) return;
          play("button-hover");
        });
      });
    }
    plates.forEach(function (el) {
      el.addEventListener("click", function () {
        if (el.disabled) return;
        play("button-click");
      });
    });
  })();

  /* ----------------------------------------------------------
     10. DOWNLOAD PLACEHOLDER
     There is no build hosted yet - say so plainly rather than
     handing someone a dead link.
     ---------------------------------------------------------- */
  (function download() {
    document.querySelectorAll("[data-download]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        var label = el.querySelector(".plate__label");
        if (!label || el.dataset.busy) return;
        el.dataset.busy = "1";
        var was = label.textContent;
        label.textContent = "COMING SOON";
        setTimeout(function () {
          label.textContent = was;
          delete el.dataset.busy;
        }, 1600);
      });
    });
  })();


  /* ----------------------------------------------------------
     11. MARQUEE
     The CSS slides the track by half its own width, which only
     reads as a loop if each half is wider than the screen. Two
     hard-coded copies were not, so the tail ran out mid-screen
     and the strip went blank until it snapped back. Copy the
     group until one half covers the window, then it rings round
     with no seam at any width.
     ---------------------------------------------------------- */
  (function marquee() {
    var track = document.getElementById("marqueeTrack");
    if (!track) return;

    var group = track.querySelector(".marquee__group");
    if (!group) return;

    var html = group.outerHTML;
    var unit = 0;
    var built = 0;

    function fill() {
      // Measure one copy on its own before deciding how many are needed.
      track.innerHTML = html;
      unit = track.firstElementChild.getBoundingClientRect().width;
      if (!unit) return;

      var half = Math.max(1, Math.ceil(window.innerWidth / unit) + 1);
      if (half === built) return;
      built = half;

      // Two identical halves, so translating by -50% lands copy on copy.
      var out = "";
      for (var i = 0; i < half * 2; i++) out += html;
      track.innerHTML = out;
      Array.prototype.forEach.call(track.children, function (el, i) {
        if (i) el.setAttribute("aria-hidden", "true");
      });

      // Keep the pace the same however many copies it took to fill.
      track.style.animationDuration = (half * 17) + "s";
    }

    fill();

    var pending;
    window.addEventListener("resize", function () {
      clearTimeout(pending);
      pending = setTimeout(fill, 200);
    });
  })();

})();
