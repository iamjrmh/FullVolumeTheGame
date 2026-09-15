/* ============================================================
   FULLVOLUME - The charter page's video guide

   Which video plays is chosen in /admin. /api/video answers with
   that video and everything read off YouTube about it: title,
   length, chapters, the storyboard frames behind the glow, and the
   qualities it is encoded at. If that call fails the page still
   plays the video in data-video, just without the extras.

   Nothing loads until the section is close to the screen: the
   YouTube API and two players are a lot to pay for on arrival at
   a page most people scroll straight down to the download on.
   ============================================================ */
(function () {
  "use strict";

  var root = document.getElementById("guide");
  if (!root) return;

  var $ = function (id) { return document.getElementById(id); };

  var FALLBACK_VIDEO = root.getAttribute("data-video");
  var LOOP_CHAPTER = /gameplay|in game|showcase|demo|result/i;
  var RATES = [1, 1.25, 1.5, 2, 0.5, 0.75];
  var SEEK_STEP = 5;
  var JUMP_STEP = 10;
  var TICK_MS = 250;
  var PLAYING = 1;
  var ENDED = 0;
  var START_MARGIN = "900px";
  var QUALITY_KEY = "fv.videoQuality";
  var BEST = "best";
  var AUTO = "auto";
  // Until the video's own list is known: big enough that YouTube never picks less than the best it has.
  var DEFAULT_RENDER = { width: 3840, height: 2160 };
  var KNOWN_QUALITIES = {
    highres: [7680, 4320, "4320p"], hd2160: [3840, 2160, "2160p"], hd1440: [2560, 1440, "1440p"],
    hd1080: [1920, 1080, "1080p"], hd720: [1280, 720, "720p"], large: [854, 480, "480p"],
    medium: [640, 360, "360p"], small: [426, 240, "240p"], tiny: [256, 144, "144p"]
  };

  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
    exitFullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg>'
  };

  var state = {
    id: FALLBACK_VIDEO,
    meta: null,
    duration: 0,
    chapters: [],
    qualities: [],
    qualityPref: readPreference(),
    playingQuality: "",
    loopStart: 0,
    main: null,
    loop: null,
    mainReady: false,
    loopReady: false,
    started: false,
    loopInView: false,
    playWhenReady: false
  };

  /* ---------- helpers ---------- */

  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var ss = (s < 10 ? "0" : "") + s;
    return h ? h + ":" + (m < 10 ? "0" : "") + m + ":" + ss : m + ":" + ss;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function readPreference() {
    try { return localStorage.getItem(QUALITY_KEY) || BEST; } catch (e) { return BEST; }
  }

  function savePreference(value) {
    try { localStorage.setItem(QUALITY_KEY, value); } catch (e) { /* private mode: the choice lasts the visit */ }
  }

  // maxresdefault exists only for HD uploads; for the rest YouTube serves a
  // 120px grey placeholder with a 200, so the size is the only tell.
  function thumbnailFor(id, done) {
    var maxres = "https://i.ytimg.com/vi/" + id + "/maxresdefault.jpg";
    var fallback = "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
    var img = new Image();
    img.onload = function () { done(img.naturalWidth > 120 ? maxres : fallback); };
    img.onerror = function () { done(fallback); };
    img.src = maxres;
  }

  /* ---------- the glow ---------- */

  // The player is a YouTube iframe, so its pixels can never be read. The
  // storyboard - the frames YouTube shows over its own seek bar, one every few
  // seconds - is the video's colour at almost any moment, and blurred by 60px
  // nobody can tell it is not live.
  var glow = {
    layers: root.querySelectorAll(".vg-glow__layer"),
    active: 0,
    frame: -1,
    show: function (css) {
      var next = this.layers[1 - this.active];
      Object.keys(css).forEach(function (k) { next.style[k] = css[k]; });
      next.classList.add("is-on");
      this.layers[this.active].classList.remove("is-on");
      this.active = 1 - this.active;
    },
    showImage: function (url) {
      this.frame = -1;
      this.show({ backgroundImage: 'url("' + url + '")', backgroundSize: "cover", backgroundPosition: "center" });
    },
    // No storyboard: YouTube's three automatic frame grabs, about a quarter, a
    // half and three quarters in. They are letterboxed 4:3, so the bars are cropped.
    fromThumbnails: function (time) {
      if (!state.duration) return;
      var p = time / state.duration;
      var frame = p < 0.375 ? 1 : p < 0.625 ? 2 : 3;
      if (frame === this.frame) return;
      this.frame = frame;
      this.show({ backgroundImage: 'url("https://i.ytimg.com/vi/' + state.id + "/hq" + frame + '.jpg")', backgroundSize: "100% 134%", backgroundPosition: "center" });
    },
    update: function (time) {
      if (!state.started) return;
      var sb = state.meta && state.meta.storyboard;
      if (!sb) { this.fromThumbnails(time); return; }
      var frame = Math.min(sb.count - 1, Math.floor((time * 1000) / sb.intervalMs));
      if (frame === this.frame) return;
      this.frame = frame;
      var sheetIndex = Math.floor(frame / sb.perSheet);
      var sheet = sb.sheets[sheetIndex];
      if (!sheet) return;
      var inSheet = frame - sheetIndex * sb.perSheet;
      var col = inSheet % sb.cols, row = Math.floor(inSheet / sb.cols);
      this.show({
        backgroundImage: 'url("' + sheet.url + '")',
        backgroundSize: sb.cols * 100 + "% " + sheet.rows * 100 + "%",
        backgroundPosition: (sb.cols > 1 ? (col / (sb.cols - 1)) * 100 : 0) + "% " + (sheet.rows > 1 ? (row / (sheet.rows - 1)) * 100 : 0) + "%"
      });
    },
    preload: function (sb) {
      if (sb) sb.sheets.forEach(function (s) { new Image().src = s.url; });
    }
  };

  /* ---------- quality ---------- */

  // YouTube's setPlaybackQuality has done nothing for years: the stream follows
  // the iframe's size in physical pixels. So each quality is a render size, and
  // the iframe is drawn at it and scaled into its box.

  function qualityFromLevel(level) {
    var k = KNOWN_QUALITIES[level];
    return k ? { quality: level, label: k[2], width: k[0], height: k[1], fps: 0 } : null;
  }

  function qualityInfo(key) {
    for (var i = 0; i < state.qualities.length; i++) if (state.qualities[i].quality === key) return state.qualities[i];
    return qualityFromLevel(key);
  }

  function isHd(q) { return !!q && Math.min(q.width, q.height) >= 720; }

  /** The quality in force: a remembered one this video has, else its best. */
  function selectedQuality() {
    if (state.qualityPref === AUTO) return AUTO;
    if (state.qualityPref !== BEST && state.qualities.some(function (q) { return q.quality === state.qualityPref; })) return state.qualityPref;
    return state.qualities.length ? state.qualities[0].quality : BEST;
  }

  function renderSize(selection) {
    if (selection === AUTO) return null;
    var q = selection === BEST ? null : qualityInfo(selection);
    return q ? { width: q.width, height: q.height } : DEFAULT_RENDER;
  }

  function layoutStage(stage, box, size, fit) {
    var bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    if (!size) {
      stage.style.width = bw + "px";
      stage.style.height = bh + "px";
      stage.style.transform = "none";
      return;
    }
    var dpr = window.devicePixelRatio || 1;
    var w = size.width / dpr, h = size.height / dpr;
    var scale = fit === "cover" ? Math.max(bw / w, bh / h) : Math.min(bw / w, bh / h);
    stage.style.width = w + "px";
    stage.style.height = h + "px";
    stage.style.transform = "translate(" + (bw - w * scale) / 2 + "px, " + (bh - h * scale) / 2 + "px) scale(" + scale + ")";
  }

  function layoutPlayers() {
    layoutStage($("vgMainStage"), $("vgScreen"), renderSize(selectedQuality()), "contain");
    // The loop behind the heading is always the best quality: it is the first thing seen.
    layoutStage($("vgLoopStage"), $("vgHero"), renderSize(state.qualities.length ? state.qualities[0].quality : BEST), "cover");
  }

  function paintQualityButton() {
    var selection = selectedQuality();
    var q = selection === AUTO ? null : qualityInfo(selection);
    var playing = qualityInfo(state.playingQuality);
    var label = selection === AUTO ? (playing ? "Auto " + playing.label : "Auto") : q ? q.label : "Best";
    var hd = selection === AUTO ? isHd(playing) : isHd(q);
    $("vgQualityLabel").innerHTML = esc(label) + (hd ? '<span class="vg-hd">HD</span>' : "");
    $("vgQuality").setAttribute("aria-label", "Quality: " + label);
  }

  function paintQualityMenu() {
    var selection = selectedQuality();
    var playing = qualityInfo(state.playingQuality);
    var items = state.qualities.map(function (q) { return { key: q.quality, label: q.label, hd: isHd(q) }; });
    items.push({ key: AUTO, label: "Auto", hint: "fits the player" });
    $("vgQualityMenu").innerHTML =
      '<div class="vg-qmenu__title"><span>Quality</span>' + (playing ? "<span>Playing <b>" + esc(playing.label) + "</b></span>" : "") + "</div>" +
      items.map(function (it) {
        return '<button type="button" role="menuitemradio" aria-checked="' + (it.key === selection) + '" data-quality="' + it.key + '">' +
          '<span class="vg-qmenu__check">' + ICON.check + "</span>" + esc(it.label) +
          (it.hd ? '<span class="vg-hd">HD</span>' : "") +
          (it.hint ? '<span class="vg-qmenu__hint">' + it.hint + "</span>" : "") +
        "</button>";
      }).join("");
  }

  function setMenuOpen(open) {
    var menu = $("vgQualityMenu");
    menu.hidden = !open;
    $("vgQuality").setAttribute("aria-expanded", String(open));
    if (!open) return;
    paintQualityMenu();
    var focus = menu.querySelector('[aria-checked="true"]') || menu.querySelector("button");
    if (focus) focus.focus();
  }

  function chooseQuality(key) {
    state.qualityPref = state.qualities.length && key === state.qualities[0].quality ? BEST : key;
    savePreference(state.qualityPref);
    layoutPlayers();
    paintQualityButton();
  }

  /* ---------- chapters ---------- */

  var lastChapter = -2;
  var listHovered = false;

  function chapterAt(time) {
    var idx = -1;
    for (var i = 0; i < state.chapters.length; i++) if (time >= state.chapters[i].t) idx = i;
    return idx;
  }

  function paintChapters() {
    var list = $("vgChapterList");
    var chapters = state.chapters;
    $("vgChapterCount").textContent = chapters.length ? chapters.length + " chapters" : "";
    list.innerHTML = chapters.length
      ? chapters.map(function (c, i) {
          return '<li><button class="vg-chapter" type="button" data-chapter="' + i + '" aria-current="false">' +
            '<span class="vg-chapter__n">' + (i + 1) + "</span>" +
            '<span class="vg-chapter__text"><b>' + fmt(c.t) + "</b>" + esc(c.title) + "</span>" +
            '<span class="vg-chapter__progress"></span></button></li>';
        }).join("")
      : '<li class="vg-chapters__empty">Watch it start to finish: this one has no chapters.</li>';

    var track = $("vgSeekTrack");
    Array.prototype.forEach.call(track.querySelectorAll(".vg-seek__tick"), function (t) { t.remove(); });
    if (state.duration) {
      chapters.slice(1).forEach(function (c) {
        var tick = document.createElement("div");
        tick.className = "vg-seek__tick";
        tick.style.left = (c.t / state.duration) * 100 + "%";
        track.appendChild(tick);
      });
    }
    lastChapter = -2;
  }

  function updateChapters(time) {
    var idx = chapterAt(time);
    var buttons = $("vgChapterList").querySelectorAll(".vg-chapter");
    if (idx !== lastChapter) {
      Array.prototype.forEach.call(buttons, function (b, i) {
        b.setAttribute("aria-current", i === idx ? "true" : "false");
        if (i !== idx) b.querySelector(".vg-chapter__progress").style.width = "0";
      });
      $("vgNow").textContent = idx >= 0 ? state.chapters[idx].title : "";
      // Keep the current chapter in view inside its own list, never by moving
      // the page, and never while somebody is reading the list themselves.
      var scroller = $("vgChapterScroll");
      if (idx >= 0 && !listHovered && getComputedStyle(scroller).position === "absolute") {
        var li = buttons[idx].parentElement;
        scroller.scrollTo({ top: Math.max(0, li.offsetTop - scroller.clientHeight / 2 + li.offsetHeight / 2), behavior: "smooth" });
      }
      lastChapter = idx;
    }
    if (idx >= 0 && buttons[idx]) {
      var start = state.chapters[idx].t;
      var end = idx + 1 < state.chapters.length ? state.chapters[idx + 1].t : state.duration;
      var pct = end > start ? Math.min(100, ((time - start) / (end - start)) * 100) : 0;
      buttons[idx].querySelector(".vg-chapter__progress").style.width = pct + "%";
    }
  }

  /* ---------- playback ---------- */

  function isPlaying() { return state.mainReady && state.main.getPlayerState() === PLAYING; }
  function currentTime() { return state.mainReady ? state.main.getCurrentTime() || 0 : 0; }

  function play() {
    if (!state.mainReady) { state.playWhenReady = true; return; }
    if (state.main.getPlayerState() === ENDED) state.main.seekTo(0, true);
    state.main.playVideo();
  }

  function togglePlay() { if (isPlaying()) state.main.pauseVideo(); else play(); }

  function seekTo(t, andPlay) {
    if (!state.mainReady) return;
    var clamped = Math.max(0, Math.min(state.duration - 0.5, t));
    state.main.seekTo(clamped, true);
    if (andPlay) play();
    paint(clamped);
  }

  function toggleMute() {
    if (!state.mainReady) return;
    if (state.main.isMuted()) state.main.unMute(); else state.main.mute();
    setTimeout(function () { paint(); }, 50);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    var el = $("vgPlayer");
    if (el.requestFullscreen) el.requestFullscreen().catch(function () { /* refused, e.g. inside a frame */ });
  }

  var seek = $("vgSeek");
  var dragging = false, dragTime = 0;

  function timeFromPointer(e) {
    var r = $("vgSeekTrack").getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * state.duration;
  }

  function showTip(t) {
    var pct = state.duration ? (t / state.duration) * 100 : 0;
    var idx = chapterAt(t);
    $("vgSeekTip").innerHTML = "<b>" + fmt(t) + "</b>" + (idx >= 0 ? esc(state.chapters[idx].title) : "");
    $("vgSeekTip").style.left = "clamp(80px, " + pct + "%, calc(100% - 80px))";
    $("vgSeekHover").style.width = pct + "%";
  }

  function paint(forcedTime) {
    if (!state.duration && state.mainReady) {
      // No length from /api/video; the player knows it once the video is cued.
      var d = state.main.getDuration ? state.main.getDuration() : 0;
      if (d > 0) { state.duration = d; paintChapters(); paintCaption(); }
    }
    var playing = isPlaying();
    var t = forcedTime != null ? forcedTime : dragging ? dragTime : currentTime();
    var dur = state.duration;
    var pct = dur ? Math.min(100, (t / dur) * 100) : 0;
    $("vgSeekFill").style.width = pct + "%";
    $("vgSeekThumb").style.left = pct + "%";
    seek.setAttribute("aria-valuemax", String(Math.floor(dur)));
    seek.setAttribute("aria-valuenow", String(Math.floor(t)));
    seek.setAttribute("aria-valuetext", fmt(t) + " of " + fmt(dur));
    $("vgTime").textContent = fmt(t) + " / " + fmt(dur);

    var ended = state.mainReady && state.main.getPlayerState() === ENDED;
    var playButton = $("vgPlay");
    var wantIcon = playing ? "pause" : ended ? "replay" : "play";
    if (playButton.getAttribute("data-icon") !== wantIcon) {
      playButton.innerHTML = ICON[wantIcon];
      playButton.setAttribute("data-icon", wantIcon);
      playButton.setAttribute("aria-label", playing ? "Pause" : ended ? "Replay" : "Play");
    }
    var muted = state.mainReady && state.main.isMuted();
    var muteButton = $("vgMute");
    if (muteButton.getAttribute("data-icon") !== (muted ? "muted" : "volume")) {
      muteButton.innerHTML = muted ? ICON.muted : ICON.volume;
      muteButton.setAttribute("data-icon", muted ? "muted" : "volume");
      muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    }
    $("vgAmbient").classList.toggle("is-paused", !playing);
    updateChapters(t);
    glow.update(t);
  }

  function paintCaption() {
    $("vgTitle").textContent = (state.meta && state.meta.title) || "The FullVolumeCharter guide";
    $("vgPosterLabel").textContent = (state.meta && state.meta.title) || "";
    var parts = [];
    if (state.duration) parts.push(fmt(state.duration));
    if (state.chapters.length) parts.push(state.chapters.length + " chapters");
    $("vgLength").textContent = parts.join(" · ");
  }

  /* ---------- the loop behind the heading ---------- */

  function syncLoop() {
    if (!state.loopReady) return;
    var shouldPlay = state.loopInView && !isPlaying();
    var loopState = state.loop.getPlayerState();
    if (shouldPlay && loopState !== PLAYING) state.loop.playVideo();
    if (!shouldPlay && loopState === PLAYING) state.loop.pauseVideo();
  }

  /* ---------- wiring ---------- */

  function wire() {
    $("vgPlay").addEventListener("click", togglePlay);
    $("vgShield").addEventListener("click", togglePlay);
    $("vgShield").addEventListener("dblclick", toggleFullscreen);
    $("vgPoster").addEventListener("click", play);
    $("vgMute").addEventListener("click", toggleMute);
    $("vgFullscreen").addEventListener("click", toggleFullscreen);
    $("vgVolume").addEventListener("input", function () {
      if (!state.mainReady) return;
      state.main.setVolume(+this.value);
      if (+this.value > 0 && state.main.isMuted()) state.main.unMute();
    });
    $("vgRate").addEventListener("click", function () {
      if (!state.mainReady) return;
      var next = RATES[(RATES.indexOf(state.main.getPlaybackRate()) + 1) % RATES.length];
      state.main.setPlaybackRate(next);
      this.textContent = next + "x";
    });

    document.addEventListener("fullscreenchange", function () {
      var on = document.fullscreenElement === $("vgPlayer");
      $("vgFullscreen").innerHTML = on ? ICON.exitFullscreen : ICON.fullscreen;
      $("vgFullscreen").setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
      setTimeout(layoutPlayers, 60);
    });

    $("vgPlayer").addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT" || e.target.closest(".vg-qmenu")) return;
      var key = e.key.toLowerCase();
      var actions = {
        " ": togglePlay, k: togglePlay, m: toggleMute, f: toggleFullscreen,
        arrowleft: function () { seekTo(currentTime() - SEEK_STEP); },
        arrowright: function () { seekTo(currentTime() + SEEK_STEP); },
        j: function () { seekTo(currentTime() - JUMP_STEP); },
        l: function () { seekTo(currentTime() + JUMP_STEP); },
        home: function () { seekTo(0); },
        end: function () { seekTo(state.duration); }
      };
      if (!actions[key]) return;
      e.preventDefault();
      actions[key]();
    });

    seek.addEventListener("pointermove", function (e) {
      var t = timeFromPointer(e);
      showTip(t);
      if (dragging) { dragTime = t; paint(t); }
    });
    seek.addEventListener("pointerleave", function () { if (!dragging) $("vgSeekHover").style.width = "0"; });
    seek.addEventListener("pointerdown", function (e) {
      if (!state.duration) return;
      dragging = true;
      seek.classList.add("is-dragging");
      seek.setPointerCapture(e.pointerId);
      dragTime = timeFromPointer(e);
      showTip(dragTime);
      paint(dragTime);
    });
    seek.addEventListener("pointerup", function () {
      if (!dragging) return;
      dragging = false;
      seek.classList.remove("is-dragging");
      seekTo(dragTime, !state.started || isPlaying());
    });
    seek.addEventListener("keydown", function (e) {
      var step = { ArrowLeft: -SEEK_STEP, ArrowRight: SEEK_STEP, PageDown: -JUMP_STEP * 3, PageUp: JUMP_STEP * 3 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      seekTo(currentTime() + step);
    });

    $("vgChapterList").addEventListener("click", function (e) {
      var b = e.target.closest(".vg-chapter");
      if (b) seekTo(state.chapters[+b.getAttribute("data-chapter")].t, true);
    });
    $("vgChapterScroll").addEventListener("pointerenter", function () { listHovered = true; });
    $("vgChapterScroll").addEventListener("pointerleave", function () { listHovered = false; });

    $("vgQuality").addEventListener("click", function () { setMenuOpen($("vgQualityMenu").hidden); });
    $("vgQualityMenu").addEventListener("click", function (e) {
      var item = e.target.closest("[data-quality]");
      if (!item) return;
      chooseQuality(item.getAttribute("data-quality"));
      setMenuOpen(false);
      $("vgQuality").focus();
    });
    $("vgQualityMenu").addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(this.querySelectorAll("button"));
      var at = items.indexOf(document.activeElement);
      if (e.key === "Escape") { setMenuOpen(false); $("vgQuality").focus(); }
      else if (e.key === "ArrowDown") items[(at + 1) % items.length].focus();
      else if (e.key === "ArrowUp") items[(at - 1 + items.length) % items.length].focus();
      else if (e.key === "Tab") setMenuOpen(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener("pointerdown", function (e) {
      if (!$("vgQualityMenu").hidden && !$("vgQualityMenu").contains(e.target) && !$("vgQuality").contains(e.target)) setMenuOpen(false);
    });

    $("vgWatch").addEventListener("click", function (e) {
      e.preventDefault();
      $("vgPlayer").scrollIntoView({ behavior: "smooth", block: "center" });
      if (state.mainReady) state.main.unMute();
      play();
      setTimeout(function () { $("vgPlayer").focus({ preventScroll: true }); }, 500);
    });

    if ("ResizeObserver" in window) {
      new ResizeObserver(layoutPlayers).observe($("vgScreen"));
      new ResizeObserver(layoutPlayers).observe($("vgHero"));
    } else {
      window.addEventListener("resize", layoutPlayers);
    }
    new IntersectionObserver(function (entries) {
      state.loopInView = entries[0].isIntersecting;
      syncLoop();
    }, { threshold: 0.05 }).observe($("vgHero"));
  }

  /* ---------- starting up ---------- */

  function applyMeta(meta) {
    state.meta = meta;
    state.id = meta.id || state.id;
    state.duration = meta.lengthSeconds || 0;
    state.chapters = meta.chapters || [];
    state.qualities = meta.qualities || [];
    var loopChapter = state.chapters.filter(function (c) { return LOOP_CHAPTER.test(c.title); })[0];
    state.loopStart = loopChapter ? loopChapter.t : 0;
    glow.preload(meta.storyboard);
  }

  function createPlayers() {
    var vars = { rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, controls: 0, fs: 0 };

    state.main = new YT.Player("vgMainPlayer", {
      videoId: state.id,
      playerVars: vars,
      events: {
        onReady: function () {
          state.mainReady = true;
          state.main.setVolume(+$("vgVolume").value);
          layoutPlayers();
          paint();
          if (state.playWhenReady) { state.playWhenReady = false; state.main.unMute(); play(); }
        },
        onStateChange: function (e) {
          if (e.data === PLAYING && !state.started) {
            state.started = true;
            $("vgPoster").hidden = true;
            if (!state.qualities.length) {
              // No quality list from /api/video: take the player's own, which has no frame rates.
              state.qualities = (state.main.getAvailableQualityLevels() || []).map(qualityFromLevel).filter(Boolean);
              layoutPlayers();
              paintQualityButton();
            }
          }
          if (e.data === ENDED) {
            $("vgPoster").hidden = false;
            state.started = false;
          }
          paint();
          syncLoop();
        },
        onPlaybackQualityChange: function (e) {
          state.playingQuality = e.data;
          paintQualityButton();
          if (!$("vgQualityMenu").hidden) paintQualityMenu();
        }
      }
    });

    var loopVars = {};
    Object.keys(vars).forEach(function (k) { loopVars[k] = vars[k]; });
    loopVars.mute = 1;
    loopVars.autoplay = 1;
    loopVars.start = state.loopStart;
    state.loop = new YT.Player("vgLoopPlayer", {
      videoId: state.id,
      playerVars: loopVars,
      events: {
        onReady: function () { state.loopReady = true; state.loop.mute(); syncLoop(); },
        onStateChange: function (e) {
          if (e.data === PLAYING) $("vgLoopMedia").classList.add("is-live");
          if (e.data === ENDED) state.loop.seekTo(state.loopStart, true);
        }
      }
    });

    setInterval(function () { paint(); }, TICK_MS);
  }

  function loadYouTubeApi(ready) {
    if (window.YT && window.YT.Player) { ready(); return; }
    var previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof previous === "function") previous();
      ready();
    };
    var s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    document.head.appendChild(s);
  }

  function start() {
    wire();
    fetch("/api/video", { credentials: "omit" })
      .then(function (res) {
        return res.json().then(function (body) {
          if (res.ok) applyMeta(body);
          else if (body && body.id) state.id = body.id;
        });
      })
      .catch(function () { /* the video still plays from data-video */ })
      .then(function () {
        thumbnailFor(state.id, function (url) {
          $("vgPoster").style.backgroundImage = 'url("' + url + '")';
          $("vgHero").style.backgroundImage = 'url("' + url + '")';
          glow.showImage(url);
        });
        paintCaption();
        paintChapters();
        paintQualityButton();
        paint(0);
        layoutPlayers();
        loadYouTubeApi(createPlayers);
      });
  }

  if ("IntersectionObserver" in window) {
    var starter = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      starter.disconnect();
      start();
    }, { rootMargin: START_MARGIN + " 0px" });
    starter.observe(root);
  } else {
    start();
  }
})();
