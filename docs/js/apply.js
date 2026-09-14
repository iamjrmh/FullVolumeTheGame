/* ============================================================
   FULLVOLUME - Become a verified charter
   The application form. Fields are checked when you leave them
   (never while typing), again on send, and the server has the
   final word: it opens the Drive folder, so "that folder is not
   shared" can only come from there. Its answer lands under the
   field it is about, the same as a check made here.
   ============================================================ */
(function () {
  "use strict";

  var form = document.getElementById("applyForm");
  if (!form) return;

  var sent = document.getElementById("applySent");
  var sentLine = document.getElementById("applySentLine");
  var summary = document.getElementById("applySummary");
  var send = document.getElementById("applySend");
  var sendLabel = send.querySelector(".plate__label");
  var reason = document.getElementById("fReason");
  var counter = document.getElementById("reasonCount");

  var REASON_MIN = 20;
  var REASON_MAX = 1500;
  var USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;
  // A Discord snowflake. Both are asked for: the username is how we talk to
  // somebody, the ID is what still finds them after they rename themselves.
  var USER_ID = /^\d{17,20}$/;
  var FOLDER = /^https:\/\/(drive|docs)\.google\.com\/.*\/folders\/[\w-]{10,}/i;
  var DRAFT_KEY = "fv-apply-draft";

  var ERROR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5v5.5M12 16.4v.1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  var checks = {
    discord: function (v) {
      v = v.trim().replace(/^@/, "").toLowerCase();
      if (!v) return "Enter your Discord username.";
      if (!USERNAME.test(v)) return "That is not a Discord username. It is 2 to 32 lowercase letters, numbers, dots or underscores.";
      return "";
    },
    discordId: function (v) {
      v = v.trim();
      if (!v) return "Enter your Discord user ID.";
      if (!USER_ID.test(v)) return "That is not a Discord user ID. It is 17 to 20 digits, like 970401206730125342.";
      return "";
    },
    folder: function (v) {
      v = v.trim();
      if (!v) return "Paste the link to your shared Google Drive folder.";
      if (/\/file\/d\//.test(v)) return "That links to a single file. Share the folder that holds your charts instead.";
      if (!FOLDER.test(v)) return "That is not a Google Drive folder link. It should start with https://drive.google.com/drive/folders/";
      return "";
    },
    reason: function (v) {
      v = v.trim();
      if (v.length < REASON_MIN) return "Tell us a little more, at least " + REASON_MIN + " characters.";
      if (v.length > REASON_MAX) return "Keep it under " + REASON_MAX + " characters.";
      return "";
    }
  };

  function fieldEl(name) { return form.querySelector('.ch-field[data-field="' + name + '"]'); }
  function inputOf(name) { return form.elements[name]; }

  function setError(name, message) {
    var field = fieldEl(name);
    if (!field) return;
    var input = inputOf(name);
    var id = "err-" + name;
    var existing = document.getElementById(id);
    var help = field.querySelector(".ch-help");

    field.classList.toggle("is-invalid", !!message);
    input.setAttribute("aria-invalid", message ? "true" : "false");
    input.setAttribute("aria-describedby", (message ? id + " " : "") + help.id);

    if (!message) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      existing.lastChild.textContent = message;
      return;
    }
    var p = document.createElement("p");
    p.className = "ch-error";
    p.id = id;
    p.innerHTML = ERROR_ICON + "<span></span>";
    p.lastChild.textContent = message;
    help.parentNode.insertBefore(p, help);
  }

  function check(name) {
    var message = checks[name](inputOf(name).value);
    setError(name, message);
    return message;
  }

  // Leaving a field checks it; once it has shown an error, typing clears it
  // as soon as it is right, so the red never outstays the mistake.
  Object.keys(checks).forEach(function (name) {
    var input = inputOf(name);
    input.addEventListener("blur", function () {
      if (input.value.trim()) check(name);
    });
    input.addEventListener("input", function () {
      if (fieldEl(name).classList.contains("is-invalid") && !checks[name](input.value)) setError(name, "");
      saveDraft();
    });
  });

  function paintCount() {
    var n = reason.value.trim().length;
    counter.textContent = n.toLocaleString() + " / " + REASON_MAX.toLocaleString();
    counter.classList.toggle("is-over", n > REASON_MAX);
  }
  reason.addEventListener("input", paintCount);

  /* A half-written application survives a reload or a closed tab. */
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        discord: inputOf("discord").value, discordId: inputOf("discordId").value, folder: inputOf("folder").value, reason: reason.value
      }));
    } catch (e) { /* storage blocked: nothing to remember it in */ }
  }
  function loadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!d) return;
      inputOf("discord").value = d.discord || "";
      inputOf("discordId").value = d.discordId || "";
      inputOf("folder").value = d.folder || "";
      reason.value = d.reason || "";
    } catch (e) { /* storage blocked or garbled: start empty */ }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* nothing stored */ }
  }

  function showSummary(text) {
    summary.textContent = text;
    summary.hidden = !text;
  }

  function busy(on) {
    send.disabled = on;
    send.setAttribute("aria-busy", on ? "true" : "false");
    sendLabel.textContent = on ? "CHECKING YOUR FOLDER..." : "SEND APPLICATION";
  }

  function nudge() {
    send.classList.remove("is-nudged");
    void send.offsetWidth;
    send.classList.add("is-nudged");
  }

  function focusFirstInvalid() {
    var first = form.querySelector(".ch-field.is-invalid input, .ch-field.is-invalid textarea");
    if (first) first.focus();
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    showSummary("");

    var bad = Object.keys(checks).filter(function (name) { return check(name); });
    if (bad.length) {
      showSummary(bad.length === 1 ? "One thing needs fixing before this can go." : bad.length + " things need fixing before this can go.");
      nudge();
      focusFirstInvalid();
      return;
    }

    busy(true);
    fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        discord: inputOf("discord").value,
        discordId: inputOf("discordId").value,
        folder: inputOf("folder").value,
        reason: reason.value,
        website: inputOf("website").value
      })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.ok) return done(r.body);
        var fields = (r.body && r.body.fields) || {};
        Object.keys(fields).forEach(function (name) { setError(name, fields[name]); });
        showSummary(r.body && r.body.error ? r.body.error : "That did not go through. Try again in a moment.");
        busy(false);
        nudge();
        if (Object.keys(fields).length) focusFirstInvalid(); else summary.focus();
      })
      .catch(function () {
        busy(false);
        showSummary("Could not reach the server. Check your connection and send it again.");
        nudge();
        summary.focus();
      });
  });

  function done(body) {
    clearDraft();
    var n = body && body.charts;
    if (n) sentLine.textContent = "We found " + n.toLocaleString() + " chart" + (n === 1 ? "" : "s") + " in your folder, and your application is in the queue.";
    form.hidden = true;
    sent.hidden = false;
    sent.classList.add("is-in");
    sent.focus({ preventScroll: true });
    var box = sent.getBoundingClientRect();
    if (box.top < 80 || box.top > window.innerHeight) sent.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  loadDraft();
  paintCount();
})();
