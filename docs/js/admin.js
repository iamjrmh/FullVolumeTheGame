/* ============================================================
   FULLVOLUME - Admin
   Talks to /api/admin/*. Nothing here is a secret: the functions
   check the session on every request, so this file only decides
   what to draw.
   ============================================================ */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var loading = $("admLoading");
  var gate = $("admGate");
  var app = $("admApp");
  if (!gate || !app) return;

  var REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var LEAVE_MS = REDUCED ? 0 : 200;

  var state = { applications: [], charters: [], index: null, refresh: null, tab: "pending" };

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function ago(iso) {
    if (!iso) return "never";
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.round(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString();
  }

  function api(method, path, body) {
    return fetch("/api/admin/" + path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { showGate(); throw new Error("signed out"); }
        if (!res.ok) { var err = new Error(data.error || "Request failed (" + res.status + ")"); err.data = data; throw err; }
        return data;
      });
    });
  }

  var toastTimer;
  function toast(text, bad) {
    var el = $("admToast");
    el.textContent = text;
    el.classList.toggle("is-bad", !!bad);
    el.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-shown"); }, 4000);
  }

  function confirmThen(title, text, okLabel) {
    var dialog = $("admConfirm");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmOk").textContent = okLabel;
    return new Promise(function (resolve) {
      if (!dialog.showModal) { resolve(window.confirm(title + "\n\n" + text)); return; }
      dialog.returnValue = "";
      dialog.addEventListener("close", function onClose() {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "ok");
      });
      dialog.showModal();
    });
  }

  // An item leaves, then everything below it glides up into the gap rather
  // than jumping - measured before and after, moved by transform only.
  function leave(el, toLeft) {
    return new Promise(function (resolve) {
      var parent = el.parentNode;
      var siblings = Array.prototype.filter.call(parent.children, function (c) { return c !== el; });
      var before = siblings.map(function (c) { return c.getBoundingClientRect().top; });
      if (toLeft) el.classList.add("to-left");
      el.classList.add("is-leaving");
      setTimeout(function () {
        el.remove();
        if (!REDUCED) {
          siblings.forEach(function (c, i) {
            var dy = before[i] - c.getBoundingClientRect().top;
            if (!dy) return;
            c.style.transition = "none";
            c.style.transform = "translateY(" + dy + "px)";
            requestAnimationFrame(function () {
              c.style.transition = "transform 220ms cubic-bezier(.23, 1, .32, 1)";
              c.style.transform = "";
            });
          });
        }
        resolve();
      }, LEAVE_MS);
    });
  }

  /* ---------- gate ---------- */

  function showGate() {
    loading.hidden = true;
    app.hidden = true;
    gate.hidden = false;
    var q = new URLSearchParams(location.search);
    var flash = $("admFlash");
    var text = q.get("denied")
      ? "That Discord account is not an admin here."
      : q.get("error") === "cancelled" ? "Sign-in was cancelled."
      : q.get("error") ? "Sign-in did not work (" + q.get("error") + "). Try again."
      : "";
    flash.textContent = text;
    flash.hidden = !text;
    if (q.toString()) history.replaceState(null, "", location.pathname);
  }

  $("admSignOut").addEventListener("click", function () {
    fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).finally(showGate);
  });

  /* ---------- render ---------- */

  function paintStats() {
    var pending = state.applications.filter(function (a) { return a.status === "pending"; }).length;
    var set = function (k, v) { var el = app.querySelector('[data-stat="' + k + '"]'); if (el) el.textContent = v; };
    set("pending", pending);
    set("charters", state.charters.length);
    set("charts", state.index ? state.index.count : 0);
    set("refreshed", state.index ? ago(state.index.generated) : "never");
    set("refreshedBy", state.index ? (state.index.trigger || "") : "");
    app.querySelector('[data-count="pending"]').textContent = pending;
    app.querySelector('[data-count="decided"]').textContent = state.applications.length - pending;
  }

  function chips(a) {
    var out = [];
    var charts = a.charts + (a.countComplete === false ? "+" : "");
    out.push('<span class="adm-chip ' + (a.charts ? "adm-chip--gold" : "adm-chip--coral") + '">' + esc(charts) + " chart" + (a.charts === 1 ? "" : "s") + "</span>");
    out.push('<span class="adm-chip">' + esc(a.folders) + " folder" + (a.folders === 1 ? "" : "s") + "</span>");
    if (a.layoutProblems) out.push('<span class="adm-chip adm-chip--coral">' + esc(a.layoutProblems) + " misnamed</span>");
    if (a.status === "accepted") out.push('<span class="adm-chip adm-chip--sage">Accepted ' + esc(ago(a.decidedAt)) + "</span>");
    if (a.status === "declined") out.push('<span class="adm-chip adm-chip--coral">Declined ' + esc(ago(a.decidedAt)) + "</span>");
    return out.join("");
  }

  function appHtml(a) {
    var actions = a.status === "pending"
      ? '<button class="btn btn--go" type="button" data-act="accept">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Accept</button>' +
        '<button class="btn btn--danger" type="button" data-act="decline">Decline</button>' +
        '<button class="btn btn--quiet" type="button" data-act="recount">Count charts again</button>'
      : '<button class="btn btn--quiet" type="button" data-act="forget">Remove from list</button>';
    return '' +
      '<article class="adm-app" data-id="' + esc(a.id) + '">' +
        '<div class="adm-app__top">' +
          '<h3 class="adm-app__who">@' + esc(a.discord) + '</h3>' +
          '<span class="adm-app__when" title="' + esc(new Date(a.submittedAt).toLocaleString()) + '">Applied ' + esc(ago(a.submittedAt)) + '</span>' +
        '</div>' +
        '<div class="adm-chips">' + chips(a) + '</div>' +
        '<a class="adm-link" href="' + esc(a.folderUrl) + '" target="_blank" rel="noopener">Open their Drive folder</a>' +
        '<p class="adm-reason">' + esc(a.reason) + '</p>' +
        '<div class="adm-app__actions">' + actions + '</div>' +
      '</article>';
  }

  function paintApplications() {
    var list = $("appList");
    var wantPending = state.tab === "pending";
    var rows = state.applications.filter(function (a) { return (a.status === "pending") === wantPending; });
    list.innerHTML = rows.length
      ? rows.map(appHtml).join("")
      : '<p class="adm-empty">' + (wantPending ? "Nobody is waiting. The form is at /applyforverifiedcharter." : "No decided applications yet.") + "</p>";
    app.querySelectorAll(".adm-tab").forEach(function (t) {
      var on = t.getAttribute("data-tab") === state.tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      if (on) list.setAttribute("aria-labelledby", t.id);
    });
  }

  function paintCharters() {
    var list = $("charterList");
    list.innerHTML = state.charters.length
      ? state.charters.map(function (c) {
          var charts = c.charts == null ? "not refreshed yet" : c.charts + " chart" + (c.charts === 1 ? "" : "s");
          return '<div class="adm-charter" data-id="' + esc(c.id) + '">' +
            '<div><b>@' + esc(c.discord) + '</b>' +
            '<small>' + esc(charts) + ' &middot; since ' + esc(new Date(c.addedAt).toLocaleDateString()) +
            ' &middot; <a href="' + esc(c.folderUrl) + '" target="_blank" rel="noopener">folder</a></small></div>' +
            '<button class="btn btn--danger" type="button" data-act="remove" aria-label="Remove @' + esc(c.discord) + '">Remove</button>' +
          '</div>';
        }).join("")
      : '<p class="adm-empty">No verified charters yet.</p>';
  }

  function paintIssues() {
    var index = state.index;
    var issues = index ? (index.errors || []).map(function (e) { return { bad: true, e: e }; })
      .concat((index.warnings || []).map(function (w) { return { bad: false, e: w }; })) : [];
    $("refreshIssues").hidden = !issues.length;
    if (!issues.length) return;
    $("refreshIssuesTitle").textContent = (index.errors.length ? index.errors.length + " error" + (index.errors.length === 1 ? "" : "s") + ", " : "") +
      index.warnings.length + " warning" + (index.warnings.length === 1 ? "" : "s") + " from the last refresh";
    $("refreshIssuesList").innerHTML = issues.map(function (i) {
      return '<li class="' + (i.bad ? "is-error" : "") + '"><b>@' + esc(i.e.charter) + "</b>: " + esc(i.e.message) + "</li>";
    }).join("");
  }

  function paintAll() {
    paintStats();
    paintApplications();
    paintCharters();
    paintIssues();
    if (!refreshing) paintProgress(state.refresh);
  }

  function load() {
    return api("GET", "overview").then(function (data) {
      loading.hidden = true;
      gate.hidden = true;
      app.hidden = false;
      $("admName").textContent = data.admin.name;
      if (data.admin.avatar) { $("admAvatar").src = data.admin.avatar; $("admAvatar").hidden = false; }
      state.applications = data.applications;
      state.charters = data.charters;
      state.index = data.index;
      state.refresh = data.refresh;
      paintAll();
      if (data.refresh && data.refresh.running && !refreshing) {
        $("refreshStatus").textContent = "A refresh was left part way through. Press refresh to finish it.";
      }
    });
  }

  /* ---------- applications ---------- */

  app.querySelectorAll(".adm-tab").forEach(function (t) {
    t.addEventListener("click", function () {
      state.tab = t.getAttribute("data-tab");
      paintApplications();
    });
  });

  $("appList").addEventListener("click", function (e) {
    var button = e.target.closest("button[data-act]");
    if (!button) return;
    var card = button.closest(".adm-app");
    var id = card.getAttribute("data-id");
    var a = state.applications.find(function (x) { return x.id === id; });
    var act = button.getAttribute("data-act");
    if (!a) return;

    if (act === "recount") {
      button.disabled = true;
      button.textContent = "Counting...";
      api("POST", "applications/" + id + "/recount").then(function (r) {
        Object.assign(a, r.application);
        card.querySelector(".adm-chips").innerHTML = chips(a);
        toast("@" + a.discord + " has " + a.charts + " chart" + (a.charts === 1 ? "" : "s") + ".");
      }).catch(function (err) { toast(err.message, true); })
        .finally(function () { button.disabled = false; button.textContent = "Count charts again"; });
      return;
    }

    var ask = act === "decline"
      ? confirmThen("Decline @" + a.discord + "?", "They stay off the Marketplace. You can still add them by hand later.", "Decline")
      : act === "forget"
      ? confirmThen("Remove this application?", "It is deleted for good. Their verified status, if any, is not touched.", "Remove")
      : Promise.resolve(true);

    ask.then(function (yes) {
      if (!yes) return;
      card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
      var request = act === "forget" ? api("DELETE", "applications/" + id) : api("POST", "applications/" + id + "/" + act);
      return request.then(function (r) {
        return leave(card, act !== "accept").then(function () {
          if (act === "forget") state.applications = state.applications.filter(function (x) { return x.id !== id; });
          else Object.assign(a, r.application);
          if (act === "accept") {
            state.charters.push({ id: a.folderId, discord: a.discord, folderUrl: a.folderUrl, addedAt: a.decidedAt, charts: null });
            state.charters.sort(function (x, y) { return x.discord.localeCompare(y.discord); });
            toast("@" + a.discord + " is verified. Reading their charts now...");
            startRefresh();
          } else if (act === "decline") {
            toast("Declined @" + a.discord + ".");
          }
          paintStats();
          paintCharters();
          if (!$("appList").children.length) paintApplications();
        });
      }).catch(function (err) {
        card.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
        toast(err.message, true);
      });
    });
  });

  /* ---------- charters ---------- */

  $("charterList").addEventListener("click", function (e) {
    var button = e.target.closest('button[data-act="remove"]');
    if (!button) return;
    var row = button.closest(".adm-charter");
    var id = row.getAttribute("data-id");
    var c = state.charters.find(function (x) { return x.id === id; });
    confirmThen("Remove @" + c.discord + "?", "Their charts come off the Marketplace straight away. Their files in Drive are not touched.", "Remove")
      .then(function (yes) {
        if (!yes) return;
        button.disabled = true;
        return api("DELETE", "charters/" + encodeURIComponent(id)).then(function () {
          return leave(row, true).then(function () {
            state.charters = state.charters.filter(function (x) { return x.id !== id; });
            if (state.index && c.charts) state.index.count = Math.max(0, state.index.count - c.charts);
            paintStats();
            if (!state.charters.length) paintCharters();
            toast("Removed @" + c.discord + ".");
          });
        }).catch(function (err) { button.disabled = false; toast(err.message, true); });
      });
  });

  var addForm = $("addCharter");
  function addFieldError(name, message) {
    var field = addForm.querySelector('.ch-field[data-field="' + name + '"]');
    field.classList.toggle("is-invalid", !!message);
    field.querySelector(".ch-help").textContent = message || "";
  }
  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    addFieldError("discord", "");
    addFieldError("folder", "");
    var submit = addForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    api("POST", "charters", { discord: addForm.elements.discord.value, folder: addForm.elements.folder.value })
      .then(function (r) {
        state.charters.push(Object.assign({ charts: null }, r.charter));
        state.charters.sort(function (x, y) { return x.discord.localeCompare(y.discord); });
        addForm.reset();
        paintStats();
        paintCharters();
        toast("@" + r.charter.discord + " is verified. Reading their charts now...");
        startRefresh();
      })
      .catch(function (err) {
        var fields = (err.data && err.data.fields) || {};
        Object.keys(fields).forEach(function (k) { addFieldError(k, fields[k]); });
        if (!Object.keys(fields).length) toast(err.message, true);
      })
      .finally(function () { submit.disabled = false; });
  });

  /* ---------- refresh ---------- */

  var refreshing = false;
  var goButton = $("refreshGo");
  var goLabel = goButton.querySelector(".plate__label");

  function paintProgress(p) {
    var fill = $("refreshFill");
    var track = $("refreshTrack");
    var status = $("refreshStatus");
    if (!p || (!p.running && !p.done)) {
      fill.style.transform = "scaleX(0)";
      track.setAttribute("aria-valuenow", "0");
      if (!refreshing) status.textContent = state.index ? state.index.count + " chart" + (state.index.count === 1 ? "" : "s") + " listed, refreshed " + ago(state.index.generated) + "." : "Not refreshed yet.";
      return;
    }
    // Listing folders is the first tenth; opening charts is the rest.
    var listing = p.foldersLeft > 0;
    var share = p.done ? 1 : listing
      ? 0.1 * (1 - p.foldersLeft / Math.max(p.foldersLeft + 1, state.charters.length || 1))
      : 0.1 + 0.9 * (p.chartsFound ? p.chartsDone / p.chartsFound : 1);
    fill.style.transform = "scaleX(" + Math.max(0.02, Math.min(1, share)).toFixed(3) + ")";
    track.setAttribute("aria-valuenow", String(Math.round(share * 100)));
    status.textContent = p.done
      ? "Done. " + p.count + " chart" + (p.count === 1 ? "" : "s") + " listed (" + p.opened + " new or changed, " + p.reused + " unchanged" + (p.errors ? ", " + p.errors + " failed" : "") + ")."
      : listing
      ? "Reading folders, " + p.foldersLeft + " to go..."
      : "Reading charts: " + p.chartsDone + " of " + p.chartsFound + "...";
  }

  function pass(start) {
    return api("POST", "refresh", { start: start }).then(function (r) {
      if (r.busy) {
        $("refreshStatus").textContent = "Another refresh is running. Waiting for it...";
        return new Promise(function (res) { setTimeout(res, 3000); }).then(function () { return pass(false); });
      }
      if (r.idle) return r;
      paintProgress(r);
      return r.done ? r : pass(false);
    });
  }

  // Starting a sweep, from the button or from having just verified somebody.
  //
  // A new charter's charts are not on the Marketplace until a sweep has read
  // their folder, and the game reads that same listing - so leaving this to the
  // next scheduled sweep means up to twelve hours where the site and the game
  // both say a verified charter has nothing. Accepting somebody is exactly the
  // moment their charts should appear, so accepting starts the sweep itself.
  function startRefresh() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    goButton.disabled = true;
    goLabel.textContent = "REFRESHING...";
    $("refreshTrack").classList.add("is-busy");
    $("refreshStatus").textContent = "Reading folders...";
    $("refreshFill").style.transform = "scaleX(0.04)";
    return pass(true)
      .then(function (r) {
        refreshing = false;
        return load().then(function () {
          if (r.done) { paintProgress(r); toast("Refresh done. " + r.count + " charts listed."); }
        });
      })
      .catch(function (err) {
        if (err.message !== "signed out") { toast(err.message, true); $("refreshStatus").textContent = "Stopped: " + err.message; }
      })
      .finally(function () {
        refreshing = false;
        goButton.disabled = false;
        goLabel.textContent = "REFRESH NOW";
        $("refreshTrack").classList.remove("is-busy");
      });
  }

  goButton.addEventListener("click", startRefresh);

  load().catch(function (err) {
    if (err.message === "signed out") return;
    loading.textContent = "Could not load the admin page: " + err.message;
  });
})();
