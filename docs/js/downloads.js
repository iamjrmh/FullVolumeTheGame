/* ============================================================
   FULLVOLUME - the download tally

   Every [data-tally="game|charter"] on the page gets the number of times that
   installer has been downloaded, across every release, from /api/downloads.
   It repolls once a minute while the tab is visible (the API is CDN-cached for
   a minute, so polling faster would only ever see the same answer) and rolls
   the number up when it moves rather than snapping to it.

   The element ships hidden and stays hidden until a real number has arrived,
   so an offline page or a failed request shows no tally at all rather than a
   zero. The last number seen is kept in localStorage so a return visit paints
   straight away and then catches up.
   ============================================================ */
(function () {
  "use strict";

  var tallies = document.querySelectorAll("[data-tally]");
  if (!tallies.length) return;

  var ROOT = (function () {
    var self = document.currentScript;
    var src = self && self.src;
    if (!src) return "";
    return src.replace(/js\/downloads\.js.*$/, "");
  })();

  var ENDPOINT = ROOT + "api/downloads";
  var POLL_MS = 60 * 1000;
  var ROLL_MS = 900;
  var STORE = "fv.downloads";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---- Remembered numbers, so a return visit paints before the network ---- */
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(STORE) || "null") || {}; }
    catch (e) { return {}; }
  }
  function saveCache(counts) {
    try { localStorage.setItem(STORE, JSON.stringify(counts)); } catch (e) { /* private mode */ }
  }

  /* ---- Rolling one element from the number it shows to a new one ---- */
  function roll(el, to) {
    var num = el.querySelector("[data-tally-num]");
    if (!num) return;
    var from = parseInt(num.getAttribute("data-shown") || "0", 10) || 0;
    num.setAttribute("data-shown", String(to));
    if (from === to || reduceMotion.matches) {
      num.textContent = to.toLocaleString();
      return;
    }
    var start = null;
    var step = function (now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / ROLL_MS);
      var eased = 1 - Math.pow(1 - t, 3);
      num.textContent = Math.round(from + (to - from) * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    if (from < to) {
      el.classList.remove("is-bumped");
      void el.offsetWidth; /* restart the animation if it is still running */
      el.classList.add("is-bumped");
    }
  }

  /* ---- Per-release breakdown lives in the tooltip ---- */
  function describe(el, tally) {
    if (!tally.releases || !tally.releases.length) return;
    var lines = tally.releases.map(function (r) {
      return r.tag + ": " + r.count.toLocaleString();
    });
    el.setAttribute("title", lines.join("\n"));
  }

  function paint(counts, detail) {
    tallies.forEach(function (el) {
      var product = el.getAttribute("data-tally");
      var n = counts[product];
      if (typeof n !== "number") return;
      el.hidden = false;
      roll(el, n);
      if (detail && detail[product]) describe(el, detail[product]);
    });
  }

  /* ---- Fetching ---- */
  var inFlight = false;
  function refresh() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    fetch(ENDPOINT, { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
      .then(function (doc) {
        var counts = {};
        ["game", "charter"].forEach(function (p) {
          if (doc[p] && typeof doc[p].total === "number") counts[p] = doc[p].total;
        });
        paint(counts, doc);
        saveCache(counts);
      })
      .catch(function () { /* stays as it was; nothing better to show */ })
      .then(function () { inFlight = false; });
  }

  var cached = loadCache();
  if (Object.keys(cached).length) paint(cached, null);

  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
})();
