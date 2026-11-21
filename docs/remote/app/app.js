// FullVolume phone remote. Plain script, no build step: the game serves this file as is.
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const KEY = params.get("k") || sessionStorage.getItem("fv.key") || "";
  if (KEY) sessionStorage.setItem("fv.key", KEY);

  const $ = (id) => document.getElementById(id);
  const PAGE = 80;
  const RETRY_MS = 2000;

  let state = null;
  let library = [];
  let libraryRev = -1;
  let shown = [];
  let shownCount = 0;
  let pendingAdd = null;
  let dragging = null;

  // ------------------------------------------------------------------ util

  const store = {
    get: (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // Relative, so the same page works served by the game at / on the Wi-Fi and by the
  // website at /x/<code>/ for phones elsewhere, where the website relays it to the game.
  const api = (path) => "." + path + (path.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(KEY);

  async function call(path, body) {
    const response = await fetch(api(path), body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 403: wrong key (a new run of the game). 410: the relayed link has closed.
    if (response.status === 403 || response.status === 410) { expired(); throw new Error("expired"); }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || "The game did not answer.");
    return json;
  }

  function expired() { $("gone").hidden = false; }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fold = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  function time(seconds) {
    if (!seconds) return "";
    const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  let toastTimer = 0;
  function toast(text, bad = false) {
    const t = $("toast");
    t.textContent = text;
    t.classList.toggle("is-bad", bad);
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-on"), bad ? 3600 : 2400);
  }

  function buzz() { try { navigator.vibrate?.(12); } catch { /* not supported */ } }

  // Covers load only as they scroll into view: a library can be thousands of songs.
  const coverObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      coverObserver.unobserve(img);
      img.src = img.dataset.src;
    }
  }, { rootMargin: "300px" }) : null;

  function cover(src) {
    if (!src) return `<span class="cover" aria-hidden="true"></span>`;
    return `<span class="cover" aria-hidden="true"><img alt="" data-src="${esc(src)}" decoding="async"></span>`;
  }

  function wireCovers(root) {
    root.querySelectorAll(".cover img[data-src]:not([data-wired])").forEach((img) => {
      img.dataset.wired = "1";
      img.addEventListener("load", () => img.classList.add("is-in"), { once: true });
      img.addEventListener("error", () => img.remove(), { once: true });
      if (coverObserver) coverObserver.observe(img); else img.src = img.dataset.src;
    });
  }

  const localCover = (id) => id ? api("/cover/" + encodeURIComponent(id)) : "";

  // ------------------------------------------------------------------ layout

  const wide = matchMedia("(min-width: 960px)");
  function applyWide() { document.body.classList.toggle("wide", wide.matches); }
  wide.addEventListener?.("change", applyWide);
  applyWide();

  function go(view) {
    document.body.dataset.view = view;
    document.querySelectorAll(".dock__btn").forEach((b) => {
      if (b.dataset.goto === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });

    if (view === "library" || view === "shop") {
      const shop = view === "shop";
      $("library").hidden = shop;
      $("shop").hidden = !shop;
      $("tabLibrary").setAttribute("aria-selected", String(!shop));
      $("tabShop").setAttribute("aria-selected", String(shop));
      $("tabInk").style.transform = shop ? "translateX(100%)" : "none";
      if (shop && !wide.matches) setTimeout(() => $("shopSearch").focus({ preventScroll: true }), 50);
    }

    if (!wide.matches) window.scrollTo({ top: 0 });
  }

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-goto]");
    if (target) go(target.dataset.goto);
  });
  $("tabLibrary").addEventListener("click", () => go("library"));
  $("tabShop").addEventListener("click", () => go("shop"));
  go("queue");

  // ------------------------------------------------------------------ state

  async function follow() {
    let rev = 0;
    for (;;) {
      try {
        const next = await call(rev ? `/api/wait?rev=${rev}` : "/api/state");
        $("link").classList.remove("is-lost");
        $("link").textContent = "Connected";
        rev = next.rev;
        apply(next);
      } catch (error) {
        if (error.message === "expired") return;
        $("link").classList.add("is-lost");
        $("link").textContent = "Reconnecting";
        rev = 0;
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }

  function apply(next) {
    state = next;
    renderMode();
    renderStage();
    if (!dragging) renderQueue();
    renderDownloads();
    if (next.libraryRev !== libraryRev) loadLibrary(next.libraryRev);
  }

  function renderMode() {
    const label = state.mode === "venue" ? "Venue night" : state.mode === "room" ? (state.room || "Online room") : "";
    $("mode").textContent = label;
  }

  function renderStage() {
    const now = state.now;
    const head = state.queue[0];
    const stage = $("stage");
    const art = $("stageArt");

    stage.classList.toggle("is-live", !!now);

    let title, artist, label, id;
    if (now) {
      label = now.singer ? `Singing now: ${now.singer}` : "Singing now";
      ({ title, artist, id } = now);
    } else if (head) {
      label = head.singer ? `Up next: ${head.singer}` : "Up next";
      ({ title, artist, id } = head);
    } else {
      label = "Up next";
      title = "Nothing queued yet";
      artist = "Add a song from the library";
      id = "";
    }

    $("stageLabel").textContent = label;
    if ($("stageTitle").textContent !== title) $("stageTitle").textContent = title;
    $("stageArtist").textContent = artist;

    const src = localCover(id);
    if (art.dataset.src !== src) {
      art.dataset.src = src;
      art.textContent = "";
      if (src) {
        // A listener, not an onerror attribute: the website's copy runs under a CSP without inline script.
        const img = document.createElement("img");
        img.alt = "";
        img.addEventListener("error", () => img.remove(), { once: true });
        img.src = src;
        art.append(img);
      }
    }
  }

  // ------------------------------------------------------------------ setlist

  const GRIP = `<svg viewBox="0 0 24 24"><path d="M5 8h14M5 12h14M5 16h14"/></svg>`;
  const CROSS = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
  const PLUS = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`;
  const TICK = `<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>`;

  function renderQueue() {
    const rows = state.queue;
    const list = $("queue");
    const canMove = rows.length > 1;

    $("queueCount").textContent = rows.length ? String(rows.length) : "";
    $("queueEmpty").hidden = rows.length > 0;
    $("dockCount").hidden = rows.length === 0;
    $("dockCount").textContent = rows.length;
    $("playNext").hidden = !state.canPlay;

    list.innerHTML = rows.map((row, i) => {
      const who = row.singer ? `<span class="qrow__singer">${esc(row.singer)}${row.partner ? " &amp; " + esc(row.partner) : ""}</span> · ` : "";
      const by = !row.singer && row.by ? ` · added by ${esc(row.by)}` : "";
      const missing = row.have ? "" : ` · <span class="qrow__missing">not on this computer</span>`;
      return `<li class="qrow" data-index="${i}">
        <span class="qrow__pos">${i + 1}</span>
        ${cover(localCover(row.id))}
        <div class="qrow__body">
          <div class="qrow__title">${esc(row.title)}</div>
          <div class="qrow__meta">${who}${esc(row.artist)}${by}${missing}</div>
        </div>
        <button class="qrow__grip" aria-label="Move ${esc(row.title)}. Drag, or use the arrow keys" ${canMove ? "" : "hidden"}>${GRIP}</button>
        <button class="qrow__remove" aria-label="Remove ${esc(row.title)}" ${row.removable ? "" : "disabled"}>${CROSS}</button>
      </li>`;
    }).join("");

    wireCovers(list);
  }

  $("queue").addEventListener("click", async (e) => {
    const remove = e.target.closest(".qrow__remove");
    if (!remove) return;
    const li = remove.closest(".qrow");
    const index = +li.dataset.index;
    const row = state.queue[index];
    li.classList.add("is-leaving");
    buzz();
    try {
      apply(await call("/api/queue/remove", { index, title: row.title }));
      toast(`Removed ${row.title}`);
    } catch (error) {
      li.classList.remove("is-leaving");
      toast(error.message, true);
    }
  });

  // Keyboard reordering, for anyone not dragging.
  $("queue").addEventListener("keydown", (e) => {
    const grip = e.target.closest(".qrow__grip");
    if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const index = +grip.closest(".qrow").dataset.index;
    const to = index + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= state.queue.length) return;
    move(index, to, true);
  });

  // Drag to reorder: the row follows the finger, the rest slide aside to make room.
  $("queue").addEventListener("pointerdown", (e) => {
    const grip = e.target.closest(".qrow__grip");
    if (!grip || dragging || e.button > 0) return;
    e.preventDefault();

    const li = grip.closest(".qrow");
    const rows = [...$("queue").children];
    const index = rows.indexOf(li);
    const step = li.offsetHeight + parseFloat(getComputedStyle(li).marginBottom || "0");

    grip.setPointerCapture(e.pointerId);
    li.classList.add("is-dragging");
    dragging = { li, rows, index, to: index, step, startY: e.clientY, pointer: e.pointerId };
    buzz();
  });

  $("queue").addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== dragging.pointer) return;
    const { li, rows, index, step, startY } = dragging;

    // Friction past either end, rather than a wall.
    let dy = e.clientY - startY;
    const min = -index * step, max = (rows.length - 1 - index) * step;
    if (dy < min) dy = min - Math.sqrt(min - dy) * 3;
    if (dy > max) dy = max + Math.sqrt(dy - max) * 3;

    li.style.transform = `translateY(${dy}px) scale(1.02)`;

    const to = Math.max(0, Math.min(rows.length - 1, Math.round(index + dy / step)));
    if (to !== dragging.to) buzz();
    dragging.to = to;

    rows.forEach((row, i) => {
      if (row === li) return;
      let shift = 0;
      if (to > index && i > index && i <= to) shift = -step;
      if (to < index && i < index && i >= to) shift = step;
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  });

  function endDrag(e) {
    if (!dragging || e.pointerId !== dragging.pointer) return;
    const { li, rows, index, to, step } = dragging;

    // Land the row in its slot before handing over to the new order.
    li.style.transition = "transform 160ms cubic-bezier(.23,1,.32,1)";
    li.style.transform = `translateY(${(to - index) * step}px)`;

    setTimeout(() => {
      dragging = null;
      rows.forEach((row) => { row.style.transform = ""; row.style.transition = ""; });
      li.classList.remove("is-dragging");
      if (to !== index) move(index, to, false); else renderQueue();
    }, 160);
  }
  $("queue").addEventListener("pointerup", endDrag);
  $("queue").addEventListener("pointercancel", endDrag);

  async function move(index, to, refocus) {
    const row = state.queue[index];

    // Shown moved at once; the game's answer replaces it a moment later.
    const optimistic = state.queue.slice();
    optimistic.splice(to, 0, optimistic.splice(index, 1)[0]);
    state.queue = optimistic;
    renderQueue();
    renderStage();
    if (refocus) $("queue").children[to]?.querySelector(".qrow__grip")?.focus();

    try {
      apply(await call("/api/queue/move", { index, title: row.title, to }));
      if (refocus) $("queue").children[to]?.querySelector(".qrow__grip")?.focus();
    } catch (error) {
      toast(error.message, true);
      apply(await call("/api/state"));
    }
  }

  $("playNext").addEventListener("click", async () => {
    try {
      apply(await call("/api/play", {}));
      toast("Starting the next song");
    } catch (error) {
      toast(error.message, true);
    }
  });

  function renderDownloads() {
    const list = state.downloads || [];
    $("downloads").hidden = list.length === 0;
    $("downloadList").innerHTML = list.map((d) => `
      <li class="dl ${d.failed ? "is-failed" : ""} ${d.done ? "is-done" : ""}">
        ${cover(d.art)}
        <div>
          <div class="qrow__title">${esc(d.title)}</div>
          <div class="qrow__meta dl__stage">${esc(d.artist)} · ${esc(d.done ? "On the setlist" : d.stage)}</div>
          <div class="dl__bar"><i style="transform: scaleX(${d.done ? 1 : (d.progress || 0) / 100})"></i></div>
        </div>
      </li>`).join("");
    wireCovers($("downloadList"));
  }

  // ------------------------------------------------------------------ adding

  async function addSong(song, singer, partner) {
    try {
      apply(await call("/api/queue/add", { id: song.id, singer, partner, by: store.get("fv.name") }));
      toast(`Added ${song.t}`);
      buzz();
      return true;
    } catch (error) {
      toast(error.message, true);
      return false;
    }
  }

  // A venue's list is of people, so adding there asks who is singing first.
  function askSinger(what, done) {
    pendingAdd = done;
    $("singerSong").textContent = what;
    $("singerName").value = store.get("fv.singer");
    $("partnerName").value = "";
    $("singerSheet").showModal();
    setTimeout(() => $("singerName").focus(), 30);
  }

  $("singerSheet").addEventListener("close", () => {
    const done = pendingAdd;
    pendingAdd = null;
    if ($("singerSheet").returnValue !== "ok" || !done) return;
    const singer = $("singerName").value.trim();
    if (!singer) return;
    store.set("fv.singer", singer);
    if (!store.get("fv.name")) store.set("fv.name", singer);
    done(singer, $("partnerName").value.trim());
  });

  function requestAdd(song, button) {
    const finish = async (singer = "", partner = "") => {
      if (await addSong(song, singer, partner) && button) flash(button);
    };
    if (state?.needsSinger) askSinger(`${song.t} · ${song.a}`, finish); else finish();
  }

  function flash(button) {
    button.classList.add("is-done");
    button.innerHTML = TICK;
    setTimeout(() => { button.classList.remove("is-done"); button.innerHTML = PLUS; }, 1400);
  }

  // ------------------------------------------------------------------ library

  async function loadLibrary(rev) {
    libraryRev = rev;
    try {
      const data = await call("/api/library");
      library = data.songs.map((s) => ({ ...s, key: fold(`${s.t} ${s.a} ${s.al} ${s.ch || ""}`) }));
      filterLibrary();
    } catch (error) {
      libraryRev = -1;
    }
  }

  function filterLibrary() {
    const words = fold($("libSearch").value).split(/\s+/).filter(Boolean);
    const sort = $("libSort").value;

    shown = library.filter((s) => words.every((w) => s.key.includes(w)));
    const by = (f) => (x, y) => fold(x[f]).localeCompare(fold(y[f])) || fold(x.t).localeCompare(fold(y.t));
    if (sort === "a") shown.sort(by("a"));
    else if (sort === "y") shown.sort((x, y) => (y.y || 0) - (x.y || 0) || by("t")(x, y));
    else shown.sort(by("t"));

    $("libCount").textContent = `${shown.length.toLocaleString()} ${shown.length === 1 ? "song" : "songs"}`;
    $("libEmpty").hidden = shown.length > 0 || library.length === 0;
    shownCount = 0;
    $("libList").innerHTML = "";
    moreLibrary();
  }

  function moreLibrary() {
    const slice = shown.slice(shownCount, shownCount + PAGE);
    shownCount += slice.length;
    $("libList").insertAdjacentHTML("beforeend", slice.map((s) => {
      const chips = (s.p > 1 ? `<span class="chip chip--gold">${s.p} parts</span>` : "");
      const meta = [s.a, s.ch && `charted by ${s.ch}`, s.al, time(s.len)].filter(Boolean).map(esc).join(" · ");
      return `<li class="song" data-id="${esc(s.id)}">
        ${cover(s.c ? localCover(s.id) : "")}
        <div class="song__body">
          <div class="song__title">${esc(s.t)}</div>
          <div class="song__meta">${chips}${meta}</div>
        </div>
        <button class="plate plate--icon" aria-label="Add ${esc(s.t)} to the setlist">${PLUS}</button>
      </li>`;
    }).join(""));
    wireCovers($("libList"));
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && shownCount < shown.length) moreLibrary();
    }, { rootMargin: "600px" }).observe($("libMore"));
  }

  let searchTimer = 0;
  $("libSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(filterLibrary, 120); });
  $("libSort").addEventListener("change", filterLibrary);

  $("libList").addEventListener("click", (e) => {
    const button = e.target.closest(".plate--icon");
    if (!button) return;
    const id = button.closest(".song").dataset.id;
    const song = library.find((s) => s.id === id);
    if (song) requestAdd(song, button);
  });

  // ------------------------------------------------------------------ shop

  let shopResults = [];
  let shopAsked = 0;

  $("shopForm").addEventListener("submit", (e) => { e.preventDefault(); searchShop(); });

  async function searchShop() {
    const q = $("shopSearch").value.trim();
    if (q.length < 2) return;
    $("shopSearch").blur();
    const asked = ++shopAsked;
    $("shopStatus").textContent = "Searching the catalogues";
    $("shopList").innerHTML = `<li class="song"><span class="cover"></span><div class="song__body"><div class="song__title muted">Looking for "${esc(q)}"</div></div></li>`;
    try {
      const data = await call("/api/shop?q=" + encodeURIComponent(q));
      if (asked !== shopAsked) return;
      shopResults = data.results;
      const problem = data.problems.length ? ` (${data.problems.length} catalogue${data.problems.length > 1 ? "s" : ""} did not answer)` : "";
      $("shopStatus").textContent = shopResults.length
        ? `${shopResults.length} charts found${problem}`
        : `Nothing found for "${q}"${problem}. Try the artist's name alone.`;
      renderShop();
    } catch (error) {
      if (asked !== shopAsked) return;
      $("shopStatus").textContent = error.message;
      $("shopList").innerHTML = "";
    }
  }

  function renderShop() {
    const chipFor = { "FullVolume": "chip--gold", "Clone Hero": "chip--sage", "Rock Band": "chip--coral" };
    $("shopList").innerHTML = shopResults.map((r, i) => {
      const meta = [r.artist, r.charter && `charted by ${r.charter}`, time(r.len)].filter(Boolean).map(esc).join(" · ");
      const parts = r.parts > 1 ? `<span class="chip chip--gold">${r.parts} parts</span>` : "";
      const action = r.have
        ? `<button class="plate plate--sm" data-have="${esc(r.have)}"><span class="plate__label">ADD</span></button>`
        : `<button class="plate plate--sm" data-get="${i}"><span class="plate__label">GET</span></button>`;
      return `<li class="song">
        ${cover(r.art)}
        <div class="song__body">
          <div class="song__title">${esc(r.title)}</div>
          <div class="song__meta"><span class="chip ${chipFor[r.source] || ""}">${esc(r.source)}</span>${parts}${meta}</div>
        </div>
        ${action}
      </li>`;
    }).join("");
    wireCovers($("shopList"));
  }

  $("shopList").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;

    if (button.dataset.have) {
      const song = library.find((s) => s.id === button.dataset.have);
      if (song) requestAdd(song, null);
      return;
    }

    const result = shopResults[+button.dataset.get];
    if (!result) return;

    const start = async (singer = "", partner = "") => {
      button.disabled = true;
      try {
        apply(await call("/api/shop/get", { key: result.key, singer, partner, by: store.get("fv.name") }));
        button.querySelector(".plate__label").textContent = "GETTING";
        toast(`Getting ${result.title}. It joins the setlist when it lands.`);
        buzz();
      } catch (error) {
        button.disabled = false;
        toast(error.message, true);
      }
    };

    if (state?.needsSinger) askSinger(`${result.title} · ${result.artist}`, start); else start();
  });

  // ------------------------------------------------------------------ go

  if (!KEY) expired(); else follow();
})();
