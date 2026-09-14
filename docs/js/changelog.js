/* ============================================================
   CHANGELOG - /changelog/

   Paints the release notes twice: once from changelog/releases.js, which
   is baked at build time and already in the page, and again from
   /api/releases if that comes back with anything the baked copy has
   not got. So the page is full on first paint, current a moment
   later, and still full when opened off disk or when GitHub is down.

   Every string that reaches innerHTML was escaped by the parser that
   made it (netlify/lib/releasenotes.mjs); nothing here trusts the
   notes any further than that.
   ============================================================ */
(function () {
  "use strict";

  var ENDPOINT = "/api/releases";
  var log = document.getElementById("log");
  if (!log) return;

  var meta = document.getElementById("logMeta");
  var live = document.getElementById("logLive");
  var none = document.getElementById("logNone");
  var rail = document.getElementById("rail");
  var railList = document.getElementById("railList");
  var railMarker = document.getElementById("railMarker");
  var railFoot = document.getElementById("railFoot");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- Small DOM helpers ---------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "html") node.innerHTML = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  var LONG = { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" };
  var SHORT = { day: "numeric", month: "short", timeZone: "UTC" };
  function fmtDate(iso, opts) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00Z");
    return isNaN(d) ? iso : d.toLocaleDateString("en-GB", opts);
  }

  var WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  function countWord(n) {
    var w = WORDS[n] || String(n);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  /* ---------- Rendering one release ---------- */

  function renderBlocks(blocks) {
    return blocks.map(function (b) {
      if (b.type === "list") {
        return el("ul", { "class": "ticks" }, b.items.map(function (i) { return el("li", { html: i }); }));
      }
      if (b.type === "code") return el("pre", { text: b.body });
      if (b.type === "item") return el("p", { html: "<strong>" + b.title + ".</strong> " + b.body });
      return el("p", { html: b.body });
    });
  }

  /* The "New in" section: a list of headlined changes. A paragraph that
     follows a change without a headline of its own carries on from it,
     which is how the notes are written. */
  function renderNews(section) {
    var list = el("ol", { "class": "rel__changes" });
    var current = null;
    var i = 0;

    section.blocks.forEach(function (b) {
      if (b.type === "item") {
        current = el("li", { "class": "change" }, [
          el("p", { "class": "change__t", html: b.title }),
          el("p", { "class": "change__b", html: b.body })
        ]);
        current.style.setProperty("--i", Math.min(i++, 7));
        list.appendChild(current);
      } else if (current) {
        renderBlocks([b]).forEach(function (n) {
          n.classList.add("change__b");
          current.appendChild(n);
        });
      } else {
        var lead = el("li", { "class": "change" }, renderBlocks([b]).map(function (n) {
          n.classList.add("change__b"); return n;
        }));
        lead.style.setProperty("--i", Math.min(i++, 7));
        list.appendChild(lead);
      }
    });

    return list;
  }

  function renderSection(section) {
    var kids = [el("h3", { "class": "rel__sec-t", text: section.title })];
    if (section.image) {
      kids.push(el("figure", { "class": "rel__img" }, [
        el("img", { src: section.image.src, alt: section.image.alt || "", loading: "lazy", decoding: "async", width: "1280", height: "720" })
      ]));
    }
    return el("section", { "class": "rel__sec" }, kids.concat(renderBlocks(section.blocks)));
  }

  function renderAssets(r) {
    if (!r.assets.length && !r.url) return null;

    var kids = r.assets.map(function (a) {
      return el("a", { "class": "plate plate--sm", href: a.url, "aria-label": "Download " + a.label + " " + r.version + ", " + a.size }, [
        el("span", { "class": "plate__label", html: a.label.toUpperCase() + "<small>" + a.size + "</small>" })
      ]);
    });
    if (r.url) {
      kids.push(el("a", { "class": "rel__more", href: r.url, target: "_blank", rel: "noopener", text: "Full notes on GitHub" }));
    }
    return el("div", { "class": "rel__get" }, kids);
  }

  function renderRelease(r, index) {
    var id = "v" + r.version;
    var latest = index === 0;

    var chips = [];
    if (latest) chips.push(el("span", { "class": "chip chip--latest", text: "Latest" }));
    if (r.first) chips.push(el("span", { "class": "chip chip--launch", text: "Launch" }));
    if (r.channel) chips.push(el("span", { "class": "chip", text: r.channel }));

    var metaBits = [el("time", { datetime: r.date, text: fmtDate(r.date, LONG) })];
    var game = r.assets.filter(function (a) { return a.name === "FullVolumeSetup.exe"; })[0];
    if (game) metaBits.push(el("span", { text: game.size + " installer" }));

    var body = [];
    var news = r.sections.filter(function (s) { return s.kind === "news"; });
    var extra = r.sections.filter(function (s) { return s.kind !== "news"; });

    news.forEach(function (s) { body.push(renderNews(s)); });

    if (r.first && extra.length > 1) {
      // The launch build's notes are the whole pitch. The opening section
      // says what it is; the rest is what it shipped with, folded.
      body.push(renderSection(extra[0]));
      body.push(el("details", { "class": "rel__launch" }, [
        el("summary", { text: "Everything it launched with" }),
        el("div", { "class": "rel__launch-body" }, extra.slice(1).map(renderSection))
      ]));
    } else {
      extra.forEach(function (s) { body.push(renderSection(s)); });
    }

    var card = el("article", { "class": "rel__card", "aria-labelledby": id + "-h" }, [
      el("header", { "class": "rel__head" }, [
        el("h2", { "class": "rel__v", id: id + "-h" }, [el("a", { href: "#" + id, text: "v" + r.version })]),
        chips.length ? el("span", { "class": "rel__chips" }, chips) : null
      ]),
      el("p", { "class": "rel__meta" }, metaBits),
      r.tagline ? el("p", { "class": "rel__tagline", text: r.tagline }) : null
    ].concat(body, [renderAssets(r)]));

    var cls = "rel" + (latest ? " rel--latest" : "") + (r.first ? " rel--launch" : "");
    return el("li", { "class": cls, id: id, "data-reveal": true }, [
      el("span", { "class": "rel__node", "aria-hidden": "true" }),
      card
    ]);
  }

  /* ---------- The whole page ---------- */

  var painted = null;   // fingerprint of what is on the page
  var railLinks = [];
  var observer = null;

  function fingerprint(doc) {
    return doc.releases.map(function (r) {
      return r.tag + "|" + r.date + "|" + JSON.stringify(r.sections) + "|" +
        r.assets.map(function (a) { return a.name + a.size; }).join(",");
    }).join("\n");
  }

  function paintMeta(doc) {
    if (!meta) return;
    var n = doc.releases.length;
    var top = doc.releases[0];
    var count = meta.querySelector("[data-meta=count]");
    var latest = meta.querySelector("[data-meta=latest]");
    var date = meta.querySelector("[data-meta=date]");
    if (count) count.textContent = countWord(n) + (n === 1 ? " release" : " releases");
    if (latest && top) { latest.textContent = "Latest v" + top.version; latest.hidden = false; }
    if (date && top) { date.textContent = "Updated " + fmtDate(top.date, LONG); date.hidden = false; }
  }

  function paintRail(doc) {
    if (!rail || !railList) return;
    railList.textContent = "";
    railLinks = doc.releases.map(function (r) {
      var a = el("a", { href: "#v" + r.version }, [
        el("b", { text: "v" + r.version }),
        el("span", { text: fmtDate(r.date, SHORT) })
      ]);
      railList.appendChild(el("li", null, [a]));
      return a;
    });
    if (railFoot) {
      railFoot.innerHTML = 'Read off <a href="https://github.com/' + doc.repo + '/releases" target="_blank" rel="noopener">the GitHub releases</a>. A new one is here the moment it is published.';
    }
    rail.hidden = false;
  }

  function paint(doc, settled) {
    var frag = document.createDocumentFragment();
    doc.releases.forEach(function (r, i) { frag.appendChild(renderRelease(r, i)); });
    log.textContent = "";
    log.appendChild(frag);

    // A repaint after the first is a content swap, not an arrival, so
    // nothing gets to animate in a second time.
    if (settled) {
      Array.prototype.forEach.call(log.querySelectorAll("[data-reveal]"), function (n) { n.classList.add("is-in"); });
    }

    paintMeta(doc);
    paintRail(doc);
    watchCurrent();
    painted = fingerprint(doc);
    if (none) none.hidden = true;
  }

  /* ---------- Which release is under the reader ---------- */

  function moveMarker(link) {
    if (!railMarker || !rail) return;
    var y = link.getBoundingClientRect().top - rail.getBoundingClientRect().top - 2;
    railMarker.style.setProperty("--y", y.toFixed(1) + "px");
    railMarker.style.height = link.offsetHeight + "px";
    rail.classList.add("has-current");
  }

  // Centre a chip inside the strip's own scroll box, clamped to its ends so
  // the first and last chips sit flush rather than half off.
  function centreChip(a) {
    var max = railList.scrollWidth - railList.clientWidth;
    if (max <= 0) return;
    var want = a.offsetLeft - (railList.clientWidth - a.offsetWidth) / 2;
    var left = Math.max(0, Math.min(want, max));
    if (Math.abs(left - railList.scrollLeft) < 1) return;
    if (railList.scrollTo) {
      railList.scrollTo({ left: left, behavior: reduceMotion.matches ? "auto" : "smooth" });
    } else {
      railList.scrollLeft = left;
    }
  }

  function setCurrent(id) {
    railLinks.forEach(function (a) {
      var on = a.getAttribute("href") === "#" + id;
      a.classList.toggle("is-current", on);
      if (on) {
        a.setAttribute("aria-current", "true");
        moveMarker(a);
        // On a phone the rail is a strip; keep the current chip in view.
        // Not scrollIntoView: that walks every scrollable ancestor, and the
        // strip sits at the top of the page here, so once it has scrolled
        // out of view "block: nearest" drags the whole page back up to it
        // as you read. Scroll the strip itself and nothing else moves.
        if (window.matchMedia("(max-width: 900px)").matches && railList) {
          centreChip(a);
        }
      } else {
        a.removeAttribute("aria-current");
      }
    });
  }

  function watchCurrent() {
    if (observer) observer.disconnect();
    var items = Array.prototype.slice.call(log.querySelectorAll(".rel"));
    if (!items.length) return;

    if (!("IntersectionObserver" in window)) { setCurrent(items[0].id); return; }

    // The band is the upper-middle of the viewport, so a card counts as
    // "current" once its top has crossed a third of the way down.
    var visible = new Set();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target);
      });
      var first = items.filter(function (n) { return visible.has(n); })[0];
      if (first) setCurrent(first.id);
    }, { rootMargin: "-30% 0px -55% 0px", threshold: 0 });

    items.forEach(function (n) { observer.observe(n); });
    setCurrent(items[0].id);
  }

  // The marker's resting place is measured, so a resize has to re-measure.
  var resizeTick = false;
  window.addEventListener("resize", function () {
    if (resizeTick) return;
    resizeTick = true;
    requestAnimationFrame(function () {
      resizeTick = false;
      var on = railLinks.filter(function (a) { return a.classList.contains("is-current"); })[0];
      if (on) moveMarker(on);
    });
  });

  /* ---------- Go ---------- */

  var baked = window.FV_CHANGELOG;
  if (baked && baked.releases && baked.releases.length) {
    paint(baked, false);
  }

  // Off disk there is no function to ask, and the baked copy is the page.
  if (!/^https?:$/.test(location.protocol)) return;

  fetch(ENDPOINT, { headers: { Accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
    .then(function (doc) {
      if (!doc || !doc.releases || !doc.releases.length) return;
      if (fingerprint(doc) === painted) return;

      var wasEmpty = painted === null;
      paint(doc, !wasEmpty);

      if (live && !wasEmpty) {
        live.textContent = "Just updated from GitHub";
        live.hidden = false;
        requestAnimationFrame(function () { live.classList.add("is-shown"); });
      }
    })
    .catch(function () {
      // The baked copy is still on the page. Only say something if it is not.
      if (painted === null && none) none.hidden = false;
    });

})();
