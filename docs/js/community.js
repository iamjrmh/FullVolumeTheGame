/* ============================================================
   FULLVOLUME - /community/

   One request, two answers: how many people are in the Discord,
   and which rooms are sitting open in the game. Both come from
   /api/pulse, which asks Discord and the game's room directory
   on the server's behalf because a browser can do neither from
   an HTTPS page.

   Rules this file keeps to:
     - nothing invented. A half of the answer that did not come
       back leaves its numbers as they are and says so.
     - nothing jumps. The placeholders are the same width as the
       figures that replace them, and the count-up only runs the
       first time, so a refresh does not make the page twitch.
     - room names and song titles are typed by players, so they
       only ever reach the page as text, never as markup.
   ============================================================ */
(function () {
  "use strict";

  var ENDPOINT = "/api/pulse";

  /* Long enough that a tab left open all evening stays roughly true, short
     enough that somebody deciding whether to join is looking at now. The edge
     holds the answer for a minute, so this mostly costs nothing. */
  var REFRESH_MS = 60000;

  var board = document.querySelector("[data-pulse]");
  if (!board) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var state = document.querySelector("[data-pulse-state]");
  var checked = document.querySelector("[data-pulse-checked]");
  var roomList = document.querySelector("[data-rooms]");
  var roomNote = document.querySelector("[data-rooms-note]");

  var first = true;
  var timer = null;

  /* ----------------------------------------------------------
     NUMBERS
     Counting up is a one-time flourish. On every refresh after
     that the figure is simply set, because a number that
     animates while you are reading it is a number you cannot
     read.
     ---------------------------------------------------------- */
  function setNumber(key, value) {
    var el = document.querySelector('[data-pulse="' + key + '"]');
    if (!el || typeof value !== "number" || isNaN(value)) return;

    var show = function (n) { el.textContent = n.toLocaleString(); };

    if (!first || reduceMotion.matches || value === 0) { show(value); return; }

    var duration = 900, started = null;
    var step = function (now) {
      if (started === null) started = now;
      var t = Math.min((now - started) / duration, 1);
      // ease-out cubic, the same curve character as the CSS
      show(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ----------------------------------------------------------
     ROOMS
     ---------------------------------------------------------- */
  /* Dots, because four of something is faster to count than to read. They are
     a picture of the number, so the row carries the number in words for
     anybody not looking at it. */
  function pips(taken, total) {
    var wrap = document.createElement("div");
    wrap.className = "room__seats";
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", taken + " of " + total + " seats taken");

    // A room advertising forty seats is advertising a broken number, and it
    // would wrap the card into a paragraph of dots either way.
    var seats = Math.max(0, Math.min(total || 0, 8));

    for (var i = 0; i < seats; i++) {
      var pip = document.createElement("span");
      pip.className = "pip" + (i < taken ? " pip--taken" : "");
      wrap.appendChild(pip);
    }

    return wrap;
  }

  function badgeFor(room) {
    if (room.locked) return { text: "LOCKED", mod: "locked" };
    if (room.capacity && room.players >= room.capacity) return { text: "FULL", mod: "full" };
    if (room.players > 0) return { text: "SINGING", mod: "busy" };
    return { text: "OPEN", mod: "" };
  }

  function roomCard(room) {
    var li = document.createElement("li");
    li.className = "room" + (room.players > 0 ? " room--busy" : "");

    var head = document.createElement("div");
    head.className = "room__head";

    var name = document.createElement("p");
    name.className = "room__name";
    name.textContent = room.name;        // typed by a player: text, never markup
    head.appendChild(name);

    var badge = badgeFor(room);
    var tag = document.createElement("span");
    tag.className = "room__badge" + (badge.mod ? " room__badge--" + badge.mod : "");
    tag.textContent = badge.text;
    head.appendChild(tag);

    li.appendChild(head);
    li.appendChild(pips(room.players, room.capacity));

    if (room.song) {
      var song = document.createElement("p");
      song.className = "room__song";
      song.textContent = room.song;      // likewise
      li.appendChild(song);
    }

    return li;
  }

  function drawRooms(rooms) {
    if (!roomList || !roomNote) return;

    // Null is not the same answer as an empty list. Null means the directory
    // could not be asked, and the page has nothing honest to say about rooms.
    if (!rooms) {
      roomList.hidden = true;
      roomNote.hidden = false;
      roomNote.textContent =
        "The room list is not answering at the moment. Press MULTIPLAYER in the game " +
        "and you will get it straight from the source.";
      return;
    }

    if (!rooms.list || !rooms.list.length) {
      roomList.hidden = true;
      roomNote.hidden = false;
      roomNote.textContent =
        "Nothing is up right now. Host a room in the game and it appears on this page " +
        "within the minute.";
      return;
    }

    var next = document.createDocumentFragment();
    rooms.list.forEach(function (room) { next.appendChild(roomCard(room)); });

    roomList.replaceChildren(next);
    roomList.hidden = false;
    roomNote.hidden = true;
  }

  /* ----------------------------------------------------------
     THE READ
     ---------------------------------------------------------- */
  function said(when) {
    if (!checked) return;

    var seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
    var ago = seconds < 45 ? "a moment ago"
            : seconds < 90 ? "a minute ago"
            : Math.round(seconds / 60) + " minutes ago";

    checked.textContent = "Read " + ago;
  }

  function mark(kind) {
    if (state) state.setAttribute("data-pulse-state", kind);
  }

  function apply(data) {
    if (data.discord) {
      setNumber("online", data.discord.online);
      setNumber("members", data.discord.members);
    }

    if (data.rooms) {
      setNumber("rooms", data.rooms.open);
      setNumber("singing", data.rooms.singing);
      setNumber("seats", data.rooms.seats);
    }

    drawRooms(data.rooms);

    // Green only when both halves answered. If one did not, the figures on
    // show are still true, but they are not all of the picture.
    mark(data.discord && data.rooms ? "live" : "stale");
    said(Date.parse(data.checked) || Date.now());
    first = false;
  }

  function read() {
    fetch(ENDPOINT, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        return res.json();
      })
      .then(apply)
      .catch(function () {
        mark("stale");
        if (checked) checked.textContent = "Could not reach the server just now";
        drawRooms(null);
      });
  }

  /* A tab in the background is not being read, so it is not worth refreshing.
     Coming back to one is, and it should be current by the time it is looked
     at rather than a minute later. */
  function schedule() {
    clearInterval(timer);
    if (document.hidden) return;
    timer = setInterval(read, REFRESH_MS);
  }

  document.addEventListener("visibilitychange", function () {
    schedule();
    if (!document.hidden) read();
  });

  read();
  schedule();
})();
