/* ============================================================
   FULLVOLUME - players online

   Fills [data-online] with how many people have the game open right now,
   from /api/players. Everybody counts, not only people in a multiplayer room:
   every running copy of the game checks in with the directory once a minute.

   Repolls every 30 seconds while the tab is visible (the API is held on the
   CDN for 20, so faster would only see the same answer). The element ships
   hidden and stays hidden until a real number arrives, so an offline page or
   a failed request shows nothing rather than a zero. Unlike the download
   tally there is no remembered copy: a player count from yesterday is not
   a number worth painting, even for a second.
   ============================================================ */
(function () {
  "use strict";

  var badges = document.querySelectorAll("[data-online]");
  if (!badges.length) return;

  var ROOT = (function () {
    var self = document.currentScript;
    var src = self && self.src;
    if (!src) return "";
    return src.replace(/js\/online\.js.*$/, "");
  })();

  var ENDPOINT = ROOT + "api/players";
  var POLL_MS = 30 * 1000;

  function paint(count) {
    badges.forEach(function (el) {
      var num = el.querySelector("[data-online-num]");
      if (!num) return;

      var arriving = el.hidden;
      var before = parseInt(num.getAttribute("data-shown") || "-1", 10);

      num.textContent = count.toLocaleString();
      num.setAttribute("data-shown", String(count));
      el.setAttribute("aria-label", count === 1 ? "1 player online" : count + " players online");

      if (arriving) {
        el.hidden = false;
        el.classList.add("is-arriving");
      } else if (count > before) {
        el.classList.remove("is-bumped");
        void el.offsetWidth; /* restart the hop if it is still running */
        el.classList.add("is-bumped");
      }
    });
  }

  var inFlight = false;
  function refresh() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    fetch(ENDPOINT, { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
      .then(function (doc) {
        if (typeof doc.online === "number" && doc.online >= 0) paint(doc.online);
      })
      .catch(function () { /* stays as it was; nothing better to show */ })
      .then(function () { inFlight = false; });
  }

  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
})();
