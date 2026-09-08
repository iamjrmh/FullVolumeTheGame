/* ============================================================
   FULL VOLUME - Marketplace
   Browse and download vocal charts, from both places that have them.

   Chorus Encore - the catalogue CHSuite's song manager uses, and
   the one that has .sng charts:

       POST api.enchor.us/search/advanced   {"hasVocals": true}

   Rhythmverse - the Rock Band scene, and the only place with the
   .rb3con customs (a lot of songs nobody has ever charted for
   Clone Hero live here):

       POST rhythmverse.co/api/rb3xbox/songfiles/list/
       data_type=full&instrument=vocals

   Neither is queried from this page. Chorus has no free-text field
   on the endpoint that can filter vocals, Rhythmverse sends no CORS
   header at all so a browser on this domain cannot call it, and both
   rate-limit. So tools/collect-vocals.py and tools/collect-rb3.py
   sweep them into data/vocals.js and data/rb3.js, and the page
   searches those instantly. Re-run either to refresh.

   Charts download from files.enchor.us/<md5>.sng - fetched and
   renamed here, because a plain link saves the md5 as the filename -
   and from rhythmverse.co/download/<id>, which is a page rather
   than a file, since that is where the Drive and Dropbox links are
   resolved.
   ============================================================ */
(function () {
  "use strict";

  var FILES = "https://files.enchor.us";        // Chorus Encore's file host
  var RV = "https://rhythmverse.co";             // Rhythmverse
  var PAGE = 40;

  var list = document.getElementById("mktList");
  if (!list) return;

  var query   = document.getElementById("mktQuery");
  var clear   = document.getElementById("mktClear");
  var fLyrics = document.getElementById("fLyrics");
  var fSort   = document.getElementById("fSort");
  var countEl = document.getElementById("mktCount");
  var resetEl = document.getElementById("mktReset");
  var emptyEl = document.getElementById("mktEmpty");
  var moreEl  = document.getElementById("mktMore");
  var statsEl = document.getElementById("mktStats");
  var barEl   = document.getElementById("mktBar");

  var songs = [];
  var shown = [];
  var limit = PAGE;
  var openId = null;                       // the row whose drawer is down
  var byIdCache = null;

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fold(s) {
    // Accent-insensitive search: "bjork" should find "Bjork" spelled properly.
    s = String(s == null ? "" : s).toLowerCase();
    if (s.normalize) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return s;
  }

  function duration(sec) {
    if (!sec) return "-";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // Chorus hands over the file; Rhythmverse hands over a page, because that
  // is where a chart parked on Drive or Dropbox gets resolved.
  function chartUrl(song) {
    return song.rb ? RV + "/download/" + song.id : FILES + "/" + song.id + ".sng";
  }

  function artSrc(song) {
    if (!song.art) return "";
    // Rhythmverse mostly has no artwork of its own - its own pages fall back to
    // a placeholder too - so tools/fill-covers.py lends those rows the cover of
    // the same song on Chorus, marked "ch:". Everything else is a path on
    // whichever site the chart came from.
    if (song.art.indexOf("ch:") === 0) return FILES + "/" + song.art.slice(3) + ".jpg";
    return song.rb
      ? RV + "/assets/album_art/" + song.art
      : FILES + "/" + song.art + ".jpg";
  }

  // The tile colour is picked from the id, so a chart keeps the same one
  // between visits and a screenful never lands all in one colour.
  var TILES = ["gold", "coral", "sage"];
  function tileFor(id) {
    var n = 0, str = String(id || "");
    for (var i = 0; i < str.length; i++) n = (n * 31 + str.charCodeAt(i)) >>> 0;
    return TILES[n % TILES.length];
  }

  function letterOf(song) {
    return (song.title || "?").trim().charAt(0).toUpperCase() || "?";
  }

  function artHtml(song) {
    if (!song.art) {
      return '<span class="song__art song__tile song__tile--' + tileFor(song.id) +
             '" aria-hidden="true">' + esc(letterOf(song)) + "</span>";
    }
    // Covers are lazy - a screenful at a time, not ten thousand requests - and
    // each one falls back to its letter tile if the file is not there.
    return '<img class="song__art" src="' + esc(artSrc(song)) +
           '" alt="" width="46" height="46" loading="lazy" decoding="async" ' +
           'data-tile="' + tileFor(song.id) + '" data-letter="' + esc(letterOf(song)) + '">';
  }

  /* ---------- downloading ----------
     The catalogue stores every chart under its md5, so a plain link saves
     "0942a9ab8f158836a8ca84b7ee2b77fb.sng". The download attribute cannot fix
     that across origins, but files.enchor.us does send
     Access-Control-Allow-Origin: *, so the file can be fetched, named
     properly and handed to the browser from a blob instead. */

  function safeName(s) {
    return String(s == null ? "" : s)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")   // illegal in a Windows filename
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
  }

  function fileNameFor(song) {
    var title = safeName(song.title) || "song";
    var artist = safeName(song.artist);
    return (artist ? title + " - " + artist : title) + ".sng";
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function grab(song, plate) {
    if (!song || !plate || plate.dataset.busy) return;

    // Rhythmverse has no CORS header and its files often sit on someone
    // else's host, so its charts open on their download page instead. That
    // page is also what counts the download for the charter.
    if (song.rb) {
      window.open(chartUrl(song), "_blank", "noopener");
      return;
    }
    var label = plate.querySelector(".plate__label");
    var was = label ? label.textContent : "";
    var url = chartUrl(song);

    plate.dataset.busy = "1";
    var done = function () {
      if (label) label.textContent = was;
      delete plate.dataset.busy;
    };
    var say = function (text) { if (label) label.textContent = text; };

    say("0%");

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        var total = parseInt(res.headers.get("Content-Length") || "0", 10);
        if (!res.body || !res.body.getReader || !total) {
          say("...");
          return res.blob();
        }

        // Read it through so the plate can count up - a chart is tens of
        // megabytes and a button that sits there saying nothing reads broken.
        var reader = res.body.getReader();
        var chunks = [];
        var got = 0;
        return (function pump() {
          return reader.read().then(function (r) {
            if (r.done) return new Blob(chunks);
            chunks.push(r.value);
            got += r.value.length;
            say(Math.round((got / total) * 100) + "%");
            return pump();
          });
        })();
      })
      .then(function (blob) {
        save(blob, fileNameFor(song));
        say("SAVED");
        setTimeout(done, 1200);
      })
      .catch(function () {
        // Blocked or offline: fall back to the plain link, which still gets
        // the chart, just under its md5.
        done();
        location.href = url;
      });
  }

  /* ---------- render ---------- */

  // Chorus records whether a chart has lyric text as well as a vocals track.
  // For a karaoke game that is the distinction worth showing: a vocals track
  // with no words is a pitch line to hum along to, not a song to sing.
  function vocalTag(song) {
    if (song.parts > 1) {
      return '<span class="tag tag--harm" title="' + song.parts +
             ' vocal parts, harmonies included">HARMONIES</span>';
    }
    return song.lyrics
      ? '<span class="tag tag--harm" title="Has lyric text to sing">LYRICS</span>'
      : '<span class="tag tag--parts" title="Vocal track, no lyric text">VOCALS</span>';
  }

  // Which of the three the game will find it as. It reads all of them, so this
  // is a label rather than a choice to make.
  function formatTag(song) {
    return song.rb
      ? '<span class="tag tag--ext" title="Rock Band custom, from Rhythmverse">.RB3CON</span>'
      : '<span class="tag tag--fmt" title="One file, from Chorus Encore">.SNG</span>';
  }

  function rowHtml(song) {
    return '' +
      '<li class="song" data-id="' + esc(song.id) + '">' +
        '<button class="song__row" type="button" aria-expanded="false">' +
          '<span class="song__c-art">' + artHtml(song) + '</span>' +

          '<span class="song__c-song">' +
            '<span class="song__title">' + esc(song.title) + '</span>' +
            '<span class="song__artist">' + esc(song.artist) +
              (song.year ? " &middot; " + song.year : "") + '</span>' +
          '</span>' +

          '<span class="song__c-meta song__charter">' +
            '<span class="song__c-hide-inline">' + esc(song.charter || "unknown charter") + '</span>' +
          '</span>' +

          '<span class="song__c-hide song__c-parts">' + vocalTag(song) + '</span>' +
          '<span class="song__c-hide song__len">' + duration(song.length) + '</span>' +
          '<span class="song__c-hide">' + formatTag(song) + '</span>' +

          '<span class="song__c-get song__get">' +
            '<span class="plate plate--sm"><span class="plate__label">GET</span></span>' +
          '</span>' +
        '</button>' +
      '</li>';
  }

  // The narrow layout folds charter, vocals, length and genre into one chip
  // strip, so the same markup has to carry both.
  function metaChips(song) {
    var bits = [formatTag(song), vocalTag(song)];
    bits.push('<span class="song__len">' + duration(song.length) + '</span>');
    if (song.genre) bits.push('<span class="song__genre">' + esc(song.genre) + '</span>');
    return bits.join("");
  }

  function detailHtml(song) {
    var rows = [
      ["Album", song.album || "-"],
      ["Genre", song.genre || "-"],
      ["Year", song.year || "-"],
      ["Charter", song.charter || "unknown"],
      ["Length", duration(song.length)]
    ];

    if (song.rb) {
      rows.push(["Vocal parts", song.parts > 1 ? song.parts + " (harmonies)" : "1"]);
      rows.push(["Downloads", song.downloads ? song.downloads.toLocaleString() : "-"]);
      rows.push(["Format", ".rb3con, Rock Band custom"]);
      rows.push(["From", "Rhythmverse"]);
    } else {
      rows.push(["Vocal intensity", song.diff >= 0 ? song.diff + " of 6" : "not rated"]);
      rows.push(["Lyrics", song.lyrics ? "Yes, words to sing" : "Vocal track, no lyric text"]);
      rows.push(["Format", ".sng, one file"]);
      rows.push(["From", "Chorus Encore"]);
    }
    rows.push(["Added", song.added || "-"]);

    var facts = rows.map(function (r) {
      return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>";
    }).join("");

    return '' +
      '<div class="song__detail">' +
        '<dl class="song__facts">' + facts + '</dl>' +
        '<div class="song__detail-cta">' +
          '<a class="plate plate--md" href="' + esc(chartUrl(song)) + '"' +
            (song.rb ? ' target="_blank" rel="noopener"' : ' download') + '>' +
            '<span class="plate__label">DOWNLOAD</span>' +
          '</a>' +
          '<a class="song__link" href="' + esc(song.rb
              ? RV + "/songfile/" + song.id
              : "https://www.enchor.us/?name=" + encodeURIComponent(song.title)) +
            '" target="_blank" rel="noopener">View it on ' +
            (song.rb ? "Rhythmverse" : "Chorus Encore") + '</a>' +
        '</div>' +
      '</div>';
  }

  function paint() {
    var slice = shown.slice(0, limit);

    list.innerHTML = slice.map(rowHtml).join("");

    Array.prototype.forEach.call(list.querySelectorAll(".song"), function (li, i) {
      var meta = li.querySelector(".song__c-meta");
      if (!meta) return;
      var charter = meta.querySelector(".song__c-hide-inline");
      meta.innerHTML = (charter ? charter.outerHTML : "") +
                       '<span class="song__chips">' + metaChips(slice[i]) + "</span>";
    });

    // A cover that is missing becomes the letter tile rather than a broken image.
    Array.prototype.forEach.call(list.querySelectorAll("img.song__art"), function (img) {
      img.addEventListener("error", function () {
        var span = document.createElement("span");
        span.className = "song__art song__tile song__tile--" + img.getAttribute("data-tile");
        span.setAttribute("aria-hidden", "true");
        span.textContent = img.getAttribute("data-letter") || "?";
        if (img.parentNode) img.parentNode.replaceChild(span, img);
      }, { once: true });
    });

    if (openId) {
      var reopen = list.querySelector('.song[data-id="' + openId + '"]');
      if (reopen) openRow(reopen); else openId = null;
    }

    emptyEl.hidden = shown.length !== 0;
    moreEl.hidden = shown.length <= limit;

    var total = songs.length;
    countEl.innerHTML = shown.length === total
      ? "<b>" + total.toLocaleString() + "</b> vocal charts"
      : "<b>" + shown.length.toLocaleString() + "</b> of " + total.toLocaleString() + " charts";

    resetEl.hidden = !isFiltered();
  }

  function isFiltered() {
    return !!(query.value.trim() || fLyrics.value);
  }

  /* ---------- filter / sort ---------- */

  function apply(resetPage) {
    var q = fold(query.value.trim());
    var terms = q ? q.split(/\s+/) : [];
    var lyrics = fLyrics.value;

    shown = songs.filter(function (s) {
      if (lyrics === "yes" && !s.lyrics) return false;
      if (lyrics === "no" && s.lyrics) return false;

      if (!terms.length) return true;
      // Built once per row, on the first search that needs it - folding ten
      // thousand rows up front would cost the page its first paint.
      var hay = s._hay || (s._hay = fold([s.title, s.artist, s.album, s.charter, s.genre].join(" ")));
      for (var i = 0; i < terms.length; i++) {
        if (hay.indexOf(terms[i]) === -1) return false;
      }
      return true;
    });

    var by = fSort.value;
    shown.sort(function (a, b) {
      switch (by) {
        case "artist": return cmp(a.artist, b.artist) || cmp(a.title, b.title);
        case "title":  return cmp(a.title, b.title) || cmp(a.artist, b.artist);
        case "length": return (b.length || 0) - (a.length || 0);
        case "year":   return (b.year || 0) - (a.year || 0);
        default:       return cmp(b.added || "", a.added || "") || cmp(a.artist, b.artist);
      }
    });

    if (resetPage !== false) limit = PAGE;
    paint();
    remember();
  }

  function cmp(a, b) {
    a = fold(a).replace(/^(the|a|an)\s+/, "");
    b = fold(b).replace(/^(the|a|an)\s+/, "");
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /* ---------- URL state, so a search or a chart can be linked ---------- */

  function remember() {
    if (!window.history || !history.replaceState) return;
    var p = new URLSearchParams();
    if (query.value.trim()) p.set("q", query.value.trim());
    if (fLyrics.value) p.set("lyrics", fLyrics.value);
    if (fSort.value !== "added") p.set("sort", fSort.value);
    if (openId) p.set("song", openId);
    var qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  function restore() {
    var p = new URLSearchParams(location.search);
    if (p.get("q")) query.value = p.get("q");
    if (p.get("lyrics")) fLyrics.value = p.get("lyrics");
    if (p.get("sort")) fSort.value = p.get("sort");
    openId = p.get("song") || null;
  }

  /* ---------- head of the page ---------- */

  function stats() {
    var charters = {}, seconds = 0;
    songs.forEach(function (s) {
      if (s.charter) charters[s.charter] = 1;
      seconds += s.length || 0;
    });
    var set = function (key, value) {
      var el = statsEl.querySelector('[data-stat="' + key + '"]');
      if (el) el.textContent = value;
    };
    set("songs", songs.length.toLocaleString());
    set("charters", Object.keys(charters).length.toLocaleString());
    set("hours", Math.round(seconds / 3600).toLocaleString());
  }

  /* ---------- events ---------- */

  var typing;
  query.addEventListener("input", function () {
    clear.hidden = !query.value;
    clearTimeout(typing);
    typing = setTimeout(function () { apply(); }, 140);
  });

  query.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && query.value) {
      e.preventDefault();
      query.value = "";
      clear.hidden = true;
      apply();
    }
  });

  clear.addEventListener("click", function () {
    query.value = "";
    clear.hidden = true;
    query.focus();
    apply();
  });

  barEl.addEventListener("submit", function (e) { e.preventDefault(); });

  [fLyrics, fSort].forEach(function (el) {
    el.addEventListener("change", function () { apply(); });
  });

  resetEl.addEventListener("click", function () {
    query.value = ""; clear.hidden = true;
    fLyrics.value = "";
    apply();
  });

  moreEl.addEventListener("click", function () {
    limit += PAGE;
    apply(false);
  });

  // One drawer open at a time - two open panels push the row you were
  // looking at off the screen.
  list.addEventListener("click", function (e) {
    var row = e.target.closest(".song__row");
    if (!row) return;
    var li = row.closest(".song");
    if (!li) return;
    var song = byId(li.getAttribute("data-id"));

    // The GET plate is a download, not an expand.
    if (e.target.closest(".song__get")) {
      grab(song, row.querySelector(".song__get .plate"));
      return;
    }

    var open = li.classList.contains("is-open");
    Array.prototype.forEach.call(list.querySelectorAll(".song.is-open"), close);
    openId = open ? null : li.getAttribute("data-id");
    if (!open) openRow(li);
    remember();
  });

  list.addEventListener("click", function (e) {
    var cta = e.target.closest(".song__detail-cta .plate");
    if (!cta) return;
    e.preventDefault();
    var li = cta.closest(".song");
    grab(li && byId(li.getAttribute("data-id")), cta);
  });

  function close(li) {
    li.classList.remove("is-open");
    var d = li.querySelector(".song__detail");
    if (d) d.remove();
    var r = li.querySelector(".song__row");
    if (r) r.setAttribute("aria-expanded", "false");
  }

  function openRow(li) {
    var song = byId(li.getAttribute("data-id"));
    if (!song || li.querySelector(".song__detail")) return;
    li.classList.add("is-open");
    li.querySelector(".song__row").setAttribute("aria-expanded", "true");
    li.insertAdjacentHTML("beforeend", detailHtml(song));
  }

  function byId(id) {
    if (!byIdCache) {
      byIdCache = {};
      songs.forEach(function (s) { byIdCache[s.id] = s; });
    }
    return byIdCache[id] || null;
  }

  /* ---------- load ---------- */

  // Rows arrive as arrays in the order named by cols, which is a third of the
  // size of ten thousand repeated key names. Expanded once, here.
  function expand(index, isRb) {
    var cols = index.cols || [];
    return (index.rows || []).map(function (r) {
      var o = { rb: isRb };
      for (var i = 0; i < cols.length; i++) o[cols[i]] = r[i];
      // A Rock Band vocal part always carries its words, so those rows answer
      // the lyrics question the same way every time.
      if (isRb) o.lyrics = 1;
      return o;
    });
  }

  // The Rock Band index is the bigger of the two and most visits never search
  // it, so it arrives after the page is already usable rather than in front of
  // it. When it lands the list simply gets longer.
  function laterRb3() {
    var el = document.createElement("script");
    el.src = "../data/rb3.js";
    el.async = true;
    el.onload = function () {
      var rb = window.FV_RB3_CHARTS;
      if (!rb || !rb.rows || !rb.rows.length) return;
      songs = songs.concat(expand(rb, true));
      byIdCache = null;
      stats();
      apply(false);
      reveal();
    };
    document.body.appendChild(el);
  }

  function load() {
    var index = window.FV_VOCAL_CHARTS;
    if (!index || !index.rows || !index.rows.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = "The chart index did not load. Reload the page, or re-run tools/collect-vocals.py.";
      countEl.textContent = "";
      moreEl.hidden = true;
      return;
    }

    songs = expand(index, false);
    restore();
    stats();
    clear.hidden = !query.value;

    apply();
    reveal();
    laterRb3();
  }

  // A linked chart can sit past the first page, and a Rock Band one is not even
  // loaded when the page first paints - so this runs again once that index lands.
  function reveal() {
    if (!openId) return;
    var at = indexOfShown(openId);
    if (at < 0) return;
    if (at >= limit) { limit = Math.ceil((at + 1) / PAGE) * PAGE; paint(); }
    var el = list.querySelector('.song[data-id="' + openId + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  }

  function indexOfShown(id) {
    for (var i = 0; i < shown.length; i++) if (shown[i].id === id) return i;
    return -1;
  }

  load();
})();
