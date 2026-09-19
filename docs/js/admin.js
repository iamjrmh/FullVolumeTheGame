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

  var IS_ID = /^\d{17,20}$/;

  // The two records name the same person the other way round: an application
  // carries the username in `discord` and the ID in `discordId`, while a charter
  // is filed under the ID in `discord` with the username beside it. Both are
  // read through here so nothing else has to remember which is which. Records
  // made before the ID was asked for carry only a username, and still work.
  function personOf(x) {
    if (x && "discordId" in x) {
      return { id: String(x.discordId || ""), name: String(x.discordId ? x.discord : x.discord || "") };
    }
    var d = String((x && x.discord) || "");
    var u = String((x && x.username) || "");
    return IS_ID.test(d) ? { id: d, name: u } : { id: "", name: d };
  }

  // What to call somebody. The username where there is one, because an ID is not
  // something you can say to a person; the ID only when that is all there is.
  // A record filed under an ID alone borrows the name off the Discord profile
  // once that has been read, so "970401206730125342" only ever shows while the
  // lookup is still in the air.
  function who(x) {
    var p = personOf(x);
    if (p.name) return "@" + p.name;
    var known = faces[p.id];
    if (known && (known.username || known.globalName)) return "@" + (known.username || known.globalName);
    return p.id;
  }

  /** The ID to print beside the name, or "" when the name already is the ID. */
  function idOf(x) {
    var p = personOf(x);
    return p.name && p.id ? p.id : "";
  }

  /* ---------- discord profiles ---------- */

  // Every record here is filed under eighteen digits, and eighteen digits are
  // not a person. The face, the display name, the badges and the account's age
  // come from Discord through /api/admin/discord - see netlify/lib/discord.mjs
  // for why that has to be a server call. Profiles land in here once and stay,
  // so a repaint draws the right face immediately instead of flickering.
  var faces = {};

  var DISCORD_EPOCH = 1420070400000;

  // A snowflake carries the moment it was minted in its top bits, so the
  // account's age is known before anybody has answered the question.
  function createdFrom(id) {
    try {
      return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH).toISOString();
    } catch (e) {
      return null;
    }
  }

  // The grey avatar Discord draws for an account that has never set one. Worked
  // out from the ID so a row is never empty and never pops: a plausible face is
  // simply replaced by the real one when it lands.
  function defaultFace(id) {
    var index = 0;
    try { index = Number((BigInt(id) >> 22n) % 6n); } catch (e) { index = 0; }
    return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
  }

  function nameOf(p) { return (p && (p.globalName || p.username)) || ""; }

  function accountAge(iso) {
    if (!iso) return "";
    var days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (days < 1) return "made today";
    if (days < 60) return days + " day" + (days === 1 ? "" : "s") + " old";
    if (days < 730) return Math.floor(days / 30.44) + " months old";
    return Math.floor(days / 365.25) + " years old";
  }

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
    toastTimer = setTimeout(function () { el.classList.remove("is-shown"); }, Math.max(4000, text.length * 60));
  }

  // What happened to the Verified Charters role in the Discord server, as the
  // tail of a toast. Being outside the server is fine: the bot gives it on join.
  function roleNote(role) {
    return {
      granted: " Verified Charters role given.",
      revoked: " Verified Charters role taken back.",
      kept: " They keep the role for their other folder.",
      "not-in-server": " Not in the Discord yet; the bot gives them the role when they join.",
      "no-token": " The role was not touched: the site has no bot token.",
      failed: " Could not change their Discord role; the bot's hourly sweep will retry."
    }[role] || "";
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

  /** The avatar beside a name, and the button that opens the whole profile. */
  function faceHtml(x) {
    var p = personOf(x);
    if (!p.id) return '<span class="adm-face adm-face--none" title="This record predates user IDs">?</span>';
    var known = faces[p.id];
    return '<button class="adm-face" type="button" data-face="' + esc(p.id) + '" ' +
      'aria-label="Discord profile for ' + esc(who(x)) + '">' +
      '<img src="' + esc(known ? known.avatar : defaultFace(p.id)) + '" alt="" width="44" height="44">' +
      '</button>';
  }

  /** Swap the placeholder faces for the real ones, in place, without a repaint. */
  function paintFaces() {
    app.querySelectorAll("button[data-face]").forEach(function (b) {
      var p = faces[b.getAttribute("data-face")];
      if (!p) return;
      var img = b.querySelector("img");
      if (img.getAttribute("src") !== p.avatar) img.setAttribute("src", p.avatar);
      b.classList.toggle("is-missing", p.known === false);
    });
    // A record filed under an ID alone now has a name to show.
    app.querySelectorAll("[data-who]").forEach(function (el) {
      var card = el.closest("[data-id]");
      if (!card) return;
      var id = card.getAttribute("data-id");
      var rec = state.applications.find(function (a) { return a.id === id; }) ||
        state.charters.find(function (c) { return c.id === id; });
      if (rec) el.textContent = who(rec);
    });
  }

  /**
   * One request for every face on the page. Discord has no bulk user route, so
   * asking per card would be a dozen round trips on a page that already knows
   * every ID it needs before it draws anything.
   */
  function fillFaces() {
    var wanted = [];
    state.applications.concat(state.charters).forEach(function (x) {
      var id = personOf(x).id;
      if (id && !faces[id] && wanted.indexOf(id) < 0) wanted.push(id);
    });
    if (!wanted.length) { paintFaces(); return Promise.resolve(); }
    return api("POST", "discord", { ids: wanted })
      .then(function (r) {
        Object.keys(r.profiles || {}).forEach(function (id) { faces[id] = r.profiles[id]; });
        paintFaces();
      })
      .catch(function () {
        // A face that will not load is not worth a red toast over the page.
      });
  }

  function chips(a) {
    var out = [];
    var charts = a.charts + (a.countComplete === false ? "+" : "");
    out.push('<span class="adm-chip ' + (a.charts ? "adm-chip--gold" : "adm-chip--coral") + '">' + esc(charts) + " chart" + (a.charts === 1 ? "" : "s") + "</span>");
    out.push('<span class="adm-chip">' + esc(a.folders) + " folder" + (a.folders === 1 ? "" : "s") + "</span>");
    // The ID is shown as well as the name, because the name is the half that can
    // change and the ID is the half you need when it has.
    if (idOf(a)) out.push('<span class="adm-chip" title="Discord user ID">ID ' + esc(idOf(a)) + "</span>");
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
          '<div class="adm-who">' + faceHtml(a) +
            '<h3 class="adm-app__who" data-who>' + esc(who(a)) + '</h3>' +
          '</div>' +
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
            '<div class="adm-who">' + faceHtml(c) + '<div>' +
            '<b data-who>' + esc(who(c)) + '</b>' +
            '<small>' + esc(charts) + ' &middot; since ' + esc(new Date(c.addedAt).toLocaleDateString()) +
            (idOf(c) ? ' &middot; ID ' + esc(idOf(c)) : "") +
            ' &middot; <a href="' + esc(c.folderUrl) + '" target="_blank" rel="noopener">folder</a></small></div></div>' +
            '<button class="btn btn--danger" type="button" data-act="remove" aria-label="Remove ' + esc(who(c)) + '">Remove</button>' +
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
      fillFaces();
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
        toast(who(a) + " has " + a.charts + " chart" + (a.charts === 1 ? "" : "s") + ".");
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
            state.charters.push(Object.assign({ charts: null }, r.charter));
            state.charters.sort(function (x, y) { return x.discord.localeCompare(y.discord); });
            toast(who(a) + " is verified." + roleNote(r.role) + " Reading their charts now...");
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
        return api("DELETE", "charters/" + encodeURIComponent(id)).then(function (r) {
          return leave(row, true).then(function () {
            state.charters = state.charters.filter(function (x) { return x.id !== id; });
            if (state.index && c.charts) state.index.count = Math.max(0, state.index.count - c.charts);
            paintStats();
            if (!state.charters.length) paintCharters();
            toast("Removed " + who(c) + "." + roleNote(r.role));
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
    addFieldError("username", "");
    addFieldError("folder", "");
    var submit = addForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    api("POST", "charters", {
      discord: addForm.elements.discord.value,
      username: addForm.elements.username.value,
      folder: addForm.elements.folder.value
    })
      .then(function (r) {
        state.charters.push(Object.assign({ charts: null }, r.charter));
        state.charters.sort(function (x, y) { return x.discord.localeCompare(y.discord); });
        addForm.reset();
        showPeek(null);
        paintStats();
        paintCharters();
        toast(who(r.charter) + " is verified." + roleNote(r.role) + " Reading their charts now...");
        startRefresh();
      })
      .catch(function (err) {
        var fields = (err.data && err.data.fields) || {};
        Object.keys(fields).forEach(function (k) { addFieldError(k, fields[k]); });
        if (!Object.keys(fields).length) toast(err.message, true);
      })
      .finally(function () { submit.disabled = false; });
  });

  /* ---------- the profile card ---------- */

  var profileBox = $("admProfile");

  function drawProfile(p) {
    var banner = $("profBanner");
    banner.style.backgroundImage = p.banner ? 'url("' + p.banner + '")' : "";
    banner.style.backgroundColor = p.banner ? "" : (p.accentColor || "");
    banner.classList.toggle("is-plain", !p.banner);

    $("profAvatar").src = p.avatar || defaultFace(p.id);
    var deco = $("profDeco");
    deco.hidden = !p.decoration;
    if (p.decoration) deco.src = p.decoration;

    $("profName").textContent = nameOf(p) || (p.known === false ? "Unknown account" : "Reading Discord…");
    $("profHandle").textContent = p.tag || (p.username ? "@" + p.username : p.id);

    var badges = (p.badges || []).map(function (b) {
      return '<span class="adm-chip' + (b.tone ? " adm-chip--" + b.tone : "") + '">' + esc(b.label) + "</span>";
    });
    if (p.guildTag) {
      badges.unshift('<span class="adm-chip adm-chip--tag" title="Server tag">' +
        (p.guildTag.badge ? '<img src="' + esc(p.guildTag.badge) + '" alt="" width="16" height="16">' : "") +
        esc(p.guildTag.text) + "</span>");
    }
    if (p.bot) badges.unshift('<span class="adm-chip adm-chip--sage">Bot</span>');
    $("profBadges").innerHTML = badges.join("");
    $("profBadges").hidden = !badges.length;

    var made = p.createdAt || createdFrom(p.id);
    $("profCreated").textContent = made
      ? new Date(made).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) +
        " · " + accountAge(made)
      : "unknown";
    $("profId").textContent = p.id;

    // Only ever say why the card is thin, never leave it silently thin.
    var note = {
      "no-token": "DISCORD_BOT_TOKEN is not set on Netlify, so this is only what the ID itself carries.",
      "bad-token": "Discord refused the bot token. Check DISCORD_BOT_TOKEN.",
      missing: "Discord has no account with this ID.",
      "rate-limited": "Discord asked us to slow down. Try again in a moment.",
      unreachable: "Discord did not answer.",
      failed: "Discord did not answer."
    }[p.reason] || "";
    if (!note && p.stale && p.fetchedAt) note = "Discord did not answer just now. Last read " + ago(p.fetchedAt) + ".";
    $("profNote").textContent = note;
    $("profNote").hidden = !note;

    $("profOpen").href = "https://discord.com/users/" + encodeURIComponent(p.id);
  }

  function openProfile(id) {
    profileBox.setAttribute("data-id", id);
    drawProfile(faces[id] || { id: id, avatar: defaultFace(id), badges: [] });
    if (!profileBox.showModal) { window.open("https://discord.com/users/" + id, "_blank", "noopener"); return; }
    profileBox.showModal();
    if (!faces[id]) loadProfile(id, false);
  }

  function loadProfile(id, fresh) {
    var button = $("profRefresh");
    button.disabled = true;
    return api("GET", "discord/" + encodeURIComponent(id) + (fresh ? "/fresh" : ""))
      .then(function (r) {
        faces[id] = r.profile;
        if (profileBox.getAttribute("data-id") === id) drawProfile(r.profile);
        paintFaces();
      })
      .catch(function (err) { if (err.message !== "signed out") toast(err.message, true); })
      .finally(function () { button.disabled = false; });
  }

  // One listener for every face on the page: the cards are redrawn constantly
  // and a per-card listener would have to be reattached each time.
  app.addEventListener("click", function (e) {
    var face = e.target.closest("button[data-face]");
    if (face) openProfile(face.getAttribute("data-face"));
  });

  $("profDone").addEventListener("click", function () { profileBox.close(); });
  $("profClose").addEventListener("click", function () { profileBox.close(); });
  $("profRefresh").addEventListener("click", function () {
    loadProfile(profileBox.getAttribute("data-id"), true);
  });
  $("profCopy").addEventListener("click", function () {
    var id = profileBox.getAttribute("data-id");
    var done = function () { toast("Copied " + id + "."); };
    if (navigator.clipboard) navigator.clipboard.writeText(id).then(done, function () { toast("Could not copy.", true); });
    else done();
  });

  /* ---------- who is this, while you type ---------- */

  // Adding a charter by hand means pasting eighteen digits and hoping. This
  // reads the account as soon as the field holds a whole ID, so the wrong
  // person is caught before the folder is ever attached to them.
  var peekTimer, peekFor = "";

  function showPeek(p) {
    var box = $("addPeek");
    box.hidden = !p;
    if (!p) return;
    box.classList.toggle("is-missing", p.known === false);
    $("addPeekFace").src = p.avatar || defaultFace(p.id);
    $("addPeekName").textContent = p.known === false
      ? "No Discord account with that ID"
      : (nameOf(p) || p.id) + (p.username && nameOf(p) !== p.username ? " (@" + p.username + ")" : "");
    var made = p.createdAt || createdFrom(p.id);
    $("addPeekAge").textContent = p.known === false ? "" : accountAge(made);
  }

  addForm.elements.discord.addEventListener("input", function () {
    var id = this.value.trim();
    clearTimeout(peekTimer);
    peekFor = "";
    if (!IS_ID.test(id)) { showPeek(null); return; }
    if (faces[id]) { showPeek(faces[id]); fillUsername(faces[id]); return; }
    peekFor = id;
    peekTimer = setTimeout(function () {
      api("GET", "discord/" + encodeURIComponent(id))
        .then(function (r) {
          faces[id] = r.profile;
          if (peekFor !== id) return;
          showPeek(r.profile);
          fillUsername(r.profile);
        })
        .catch(function () { if (peekFor === id) showPeek(null); });
    }, 450);
  });

  // Discord usernames are lowercase, and the field says so; a bot's record can
  // still carry capitals from before that rule existed.
  function fillUsername(p) {
    var field = addForm.elements.username;
    if (!field.value && p.username) field.value = p.username.toLowerCase();
  }

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

  /* ---------- charter page video ---------- */

  // The server reads YouTube (through the home relay when it is up), copies the
  // storyboard onto the site and keeps the result; this only shows what came
  // back, so a video that will play without its glow says so before it is used.
  var videoForm = $("videoForm");
  var videoRelay = false;

  function fmtLength(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function videoCardHtml(meta, chosen) {
    var q = meta.qualities || [];
    var chips = [];
    if (meta.lengthSeconds) chips.push('<span class="adm-chip">' + esc(fmtLength(meta.lengthSeconds)) + "</span>");
    chips.push(meta.chapters && meta.chapters.length
      ? '<span class="adm-chip adm-chip--gold">' + meta.chapters.length + " chapters</span>"
      : '<span class="adm-chip adm-chip--coral" title="Add timestamps to the YouTube description">No chapters</span>');
    chips.push(meta.storyboard
      ? '<span class="adm-chip adm-chip--sage" title="The glow follows the video">Glow follows the video</span>'
      : '<span class="adm-chip adm-chip--coral" title="YouTube held the storyboard back; the glow uses three still frames">Glow from stills</span>');
    chips.push(q.length
      ? '<span class="adm-chip adm-chip--sage">Up to ' + esc(q[0].label) + "</span>"
      : '<span class="adm-chip adm-chip--coral" title="The player will list qualities without frame rates">No quality list</span>');
    if (meta.via) chips.push('<span class="adm-chip" title="How YouTube was reached">' + (meta.via.indexOf("relay") === 0 ? "Via home relay" : "Via Netlify") + "</span>");
    if (meta.stale) chips.push('<span class="adm-chip adm-chip--coral">YouTube did not answer, showing the kept copy</span>');

    var byline = chosen && chosen.setAt ? "Chosen by " + chosen.setBy + " " + ago(chosen.setAt) : chosen ? "The default guide" : "";
    return '<img src="https://i.ytimg.com/vi/' + esc(meta.id) + '/hqdefault.jpg" alt="" width="148" height="83">' +
      '<div class="adm-vcard__body">' +
        '<p class="adm-vcard__title">' + esc(meta.title || meta.id) + "</p>" +
        '<p class="adm-vcard__meta">' + esc([meta.author, byline].filter(Boolean).join(" · ")) +
          ' · <a class="adm-link" href="https://www.youtube.com/watch?v=' + esc(meta.id) + '" target="_blank" rel="noopener">YouTube</a></p>' +
        '<div class="adm-chips">' + chips.join("") + "</div>" +
      "</div>";
  }

  function paintVideoIssues(meta) {
    var notes = (meta && meta.warnings) || [];
    $("videoIssues").hidden = !notes.length;
    $("videoIssuesTitle").textContent = notes.length + " note" + (notes.length === 1 ? "" : "s") + " from the last read" + (videoRelay ? "" : " (no home relay configured)");
    $("videoIssuesList").innerHTML = notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("");
  }

  function paintVideo(data) {
    videoRelay = !!data.relay;
    var box = $("videoCurrent");
    box.innerHTML = data.meta
      ? videoCardHtml(data.meta, data.chosen)
      : '<p class="adm-status">Plays ' + esc(data.chosen.id) + ". Nothing read about it yet: it fills in the first time somebody opens the charter page, or press Read it again.</p>";
    paintVideoIssues(data.meta);
  }

  function loadVideo() {
    return api("GET", "video").then(paintVideo).catch(function (err) {
      if (err.message !== "signed out") $("videoCurrent").innerHTML = '<p class="adm-status">Could not read the video: ' + esc(err.message) + "</p>";
    });
  }

  function videoFieldError(message) {
    var field = videoForm.querySelector('.ch-field[data-field="link"]');
    field.classList.toggle("is-invalid", !!message);
    $("hvLink").textContent = message || "A watch, youtu.be, shorts or embed link. Look it up first to see what the page will get.";
  }

  function busy(buttons, on) {
    buttons.forEach(function (b) { b.disabled = on; });
  }

  $("videoLook").addEventListener("click", function () {
    var look = this;
    videoFieldError("");
    busy([look, $("videoUse")], true);
    look.textContent = "Reading YouTube...";
    api("POST", "video/look", { link: videoForm.elements.link.value })
      .then(function (r) {
        $("videoPreview").innerHTML = videoCardHtml(r.meta, null);
        $("videoPreview").hidden = false;
      })
      .catch(function (err) {
        $("videoPreview").hidden = true;
        var fields = (err.data && err.data.fields) || {};
        if (err.message !== "signed out") videoFieldError(fields.link ? err.message + " " + fields.link : err.message);
      })
      .finally(function () { busy([look, $("videoUse")], false); look.textContent = "Look it up"; });
  });

  videoForm.elements.link.addEventListener("input", function () { $("videoPreview").hidden = true; });

  videoForm.addEventListener("submit", function (e) {
    e.preventDefault();
    videoFieldError("");
    var use = $("videoUse");
    var label = use.querySelector(".plate__label");
    busy([use, $("videoLook")], true);
    label.textContent = "SWITCHING...";
    api("POST", "video", { link: videoForm.elements.link.value })
      .then(function (r) {
        paintVideo(r);
        videoForm.reset();
        $("videoPreview").hidden = true;
        toast("The charter page now plays " + (r.meta.title || r.chosen.id) + ".");
      })
      .catch(function (err) {
        var fields = (err.data && err.data.fields) || {};
        if (err.message !== "signed out") videoFieldError(fields.link ? err.message + " " + fields.link : err.message);
      })
      .finally(function () { busy([use, $("videoLook")], false); label.textContent = "USE THIS VIDEO"; });
  });

  $("videoReread").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    button.textContent = "Reading YouTube...";
    api("POST", "video/reread")
      .then(function (r) { paintVideo(r); toast("Read it again. The charter page has the new copy."); })
      .catch(function (err) { if (err.message !== "signed out") toast(err.message, true); })
      .finally(function () { button.disabled = false; button.textContent = "Read it again from YouTube"; });
  });

  load().then(loadVideo).catch(function (err) {
    if (err.message === "signed out") return;
    loading.textContent = "Could not load the admin page: " + err.message;
  });
})();
