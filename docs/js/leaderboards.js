/* FullVolume - the public leaderboards page.
 *
 * Reads the game's own score server through the site's read-only proxy
 * (/api/lb/summary, /api/lb/boards, /api/lb/board in netlify.toml). The
 * server answers in tab-separated key=value lines, the first key naming the
 * kind of line, exactly what the game and the Discord bot parse.
 *
 * Everything a player typed (names, titles, artists) is put on the page as
 * text, never as HTML.
 */
(() => {
  'use strict';

  const API = '/api/lb';
  const REFRESH_MS = 30000;
  const OVERALL_ROWS = 50;
  const SONG_ROWS = 100;
  const DIFFS = ['Easy', 'Medium', 'Hard', 'Expert'];

  const $ = (id) => document.getElementById(id);
  const els = {
    stats: $('lbStats'), live: $('lbLive'), liveText: $('lbLiveText'),
    mode: $('lbMode'), diff: $('lbDiff'),
    title: $('lbTitle'), sub: $('lbSub'), rows: $('lbRows'),
    songs: $('lbSongs'), search: $('lbSearch'), songList: $('lbSongList'),
    recent: $('lbRecent'),
  };

  const state = {
    mode: 'overall', diff: 3, song: null, songs: [], summary: null,
    boards: {}, lastOk: 0, down: false, diffChosen: false,
  };

  // ------------------------------------------------------------ parsing
  const parseLines = (body) => String(body).split('\n').filter((l) => l.trim()).map((line) => {
    const r = {};
    line.split('\t').forEach((field, i) => {
      const at = field.indexOf('=');
      if (at <= 0) return;
      const k = field.slice(0, at), v = field.slice(at + 1);
      if (i === 0) { r.kind = k; r.value = v; } else r[k] = v;
    });
    return r;
  });

  const get = async (path) => {
    const res = await fetch(API + path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseLines(await res.text());
  };

  // ------------------------------------------------------------ formatting
  const num = (n) => (Number(n) || 0).toLocaleString('en-US');
  const pct = (acc) => `${((Number(acc) || 0) / 10).toFixed(1)}%`;
  const stars = (n) => '★'.repeat(Math.max(0, Math.min(5, Number(n) || 0)));
  const ago = (unix) => {
    const s = Math.max(0, Date.now() / 1000 - Number(unix));
    if (!Number(unix)) return '';
    if (s < 60) return 'just now';
    const m = s / 60, h = m / 60, d = h / 24;
    if (m < 60) return `${Math.floor(m)} min ago`;
    if (h < 24) return `${Math.floor(h)} h ago`;
    if (d < 30) return `${Math.floor(d)} d ago`;
    return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const CROWN = 'M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-2 11H5z';
  const crown = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'lb-crown');
    svg.setAttribute('aria-label', 'Full combo');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', CROWN); p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
    return svg;
  };

  const fact = (value, label) => {
    const span = el('span');
    span.append(el('b', null, value), ` ${label}`);
    return span;
  };

  const row = (i, rank, name, fc, facts, score, starCount) => {
    const li = el('li', 'lb-row');
    li.style.setProperty('--i', i);
    if (Number(rank) <= 3) li.dataset.top = rank;
    li.append(el('span', 'lb-rank', rank));
    const who = el('div', 'lb-who');
    const n = el('p', 'lb-name');
    n.append(el('span', null, name || '?'));
    if (fc) n.append(crown());
    const f = el('p', 'lb-facts');
    f.append(...facts);
    who.append(n, f);
    const s = el('div');
    s.append(el('span', 'lb-score', num(score)));
    if (starCount != null) s.append(el('span', 'lb-stars', stars(starCount)));
    li.append(who, s);
    return li;
  };

  const empty = (title, text) => {
    const div = el('div', 'lb-empty');
    div.append(el('b', null, title), text);
    return div;
  };

  const skeleton = (n = 6) => Array.from({ length: n }, () => el('div', 'lb-skel'));

  // ------------------------------------------------------------ drawing
  const drawStats = () => {
    const s = state.summary;
    if (!s) return;
    const names = new Set();
    s.players.forEach((p) => names.add(p.name));
    const scores = state.songs.reduce((n, song) => n + (Number(song.entries) || 0), 0);
    const set = (k, v) => { const b = els.stats.querySelector(`[data-stat="${k}"]`); if (b) b.textContent = v; };
    set('singers', num(names.size));
    set('songs', num(state.songs.length));
    set('scores', num(scores));
  };

  const drawDiffCounts = (counts) => {
    els.diff.querySelectorAll('button').forEach((b) => {
      const d = Number(b.dataset.diff);
      let n = b.querySelector('.lb-seg__n');
      if (counts == null) { n?.remove(); return; }
      if (!n) { n = el('span', 'lb-seg__n'); b.append(n); }
      n.textContent = counts[d] || 0;
    });
  };

  const drawOverall = () => {
    els.songs.hidden = true;
    els.title.textContent = `${DIFFS[state.diff]} · overall`;
    els.sub.textContent = 'Every singer\'s best on every song, added up';
    const s = state.summary;
    if (!s) { els.rows.replaceChildren(...skeleton()); return; }
    const list = s.players.filter((p) => Number(p.value) === state.diff);
    drawDiffCounts(DIFFS.map((_, d) => s.players.filter((p) => Number(p.value) === d).length));
    if (list.length === 0) {
      els.rows.replaceChildren(empty('Nobody yet.', `Be the first name on the ${DIFFS[state.diff]} board.`));
      return;
    }
    els.rows.replaceChildren(...list.map((p, i) => row(i, p.rank, p.name, Number(p.crowns) > 0, [
      fact(num(p.songs), Number(p.songs) === 1 ? 'song' : 'songs'),
      fact(num(p.crowns), 'FC'),
      fact(num(p.golds), '× #1'),
      fact(pct(p.acc), 'acc'),
      fact(`${num(p.stars)}★`, 'stars'),
      fact(num(p.streak), 'streak'),
    ], p.total, null)));
  };

  const drawSongList = () => {
    const q = els.search.value.trim().toLowerCase();
    const list = state.songs.filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q));
    if (list.length === 0) {
      els.songList.replaceChildren(el('li', 'lb-empty', state.songs.length ? 'No song by that name has a score yet.' : 'No songs have scores yet.'));
      return;
    }
    els.songList.replaceChildren(...list.map((s) => {
      const li = el('li');
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(state.song === s.value));
      const left = el('span');
      left.append(el('span', 't', s.title || s.value), el('span', 'a', s.artist || ''));
      b.append(left, el('span', 'n', `${num(s.entries)} ${Number(s.entries) === 1 ? 'score' : 'scores'}`));
      b.addEventListener('click', () => pickSong(s.value));
      li.append(b);
      return li;
    }));
  };

  const drawSong = () => {
    els.songs.hidden = false;
    drawSongList();
    const song = state.songs.find((s) => s.value === state.song);
    if (!song) {
      els.title.textContent = 'Pick a song';
      els.sub.textContent = '';
      drawDiffCounts(null);
      els.rows.replaceChildren(empty('Choose a song above.', 'Every song anyone has posted a score on has its own board.'));
      return;
    }
    els.title.textContent = song.title || song.value;
    els.sub.textContent = `${song.artist || ''} · ${DIFFS[state.diff]}`;
    const boards = state.boards[state.song];
    if (!boards) { els.rows.replaceChildren(...skeleton()); return; }
    drawDiffCounts(boards.map((b) => b.rows.length));
    const board = boards[state.diff];
    if (board.rows.length === 0) {
      els.rows.replaceChildren(empty('No scores here yet.', `Sing it on ${DIFFS[state.diff]} and take number one.`));
      return;
    }
    els.rows.replaceChildren(...board.rows.map((r, i) => row(i, r.rank, r.name, r.fc === '1', [
      fact(pct(r.acc), 'acc'),
      fact(num(r.streak), 'streak'),
      ...(Number(r.vt) > 0 ? [fact(`${r.vh}/${r.vt}`, 'vibrato')] : []),
      el('span', null, ago(r.when)),
    ], r.score, r.stars)));
  };

  const drawRecent = () => {
    const s = state.summary;
    if (!s) { els.recent.replaceChildren(...skeleton(4)); return; }
    if (s.recent.length === 0) { els.recent.replaceChildren(empty('Nothing yet.', 'New bests show up here.')); return; }
    els.recent.replaceChildren(...s.recent.map((r, i) => {
      const li = el('li', 'lb-row');
      li.style.setProperty('--i', i);
      const who = el('div', 'lb-who');
      const n = el('p', 'lb-name');
      n.append(el('span', null, r.name || '?'));
      if (r.fc === '1') n.append(crown());
      const f = el('p', 'lb-facts');
      f.append(el('span', null, `${r.title || '?'} · ${r.artist || ''}`));
      const tags = el('p', 'lb-facts');
      tags.append(el('span', 'lb-tag', DIFFS[Number(r.value)] || '?'));
      if (r.rank === '1') tags.append(el('span', 'lb-tag lb-tag--gold', 'New #1'));
      else tags.append(el('span', 'lb-tag', `#${r.rank}`));
      who.append(n, f, tags);
      const sc = el('div');
      sc.append(el('span', 'lb-score', num(r.score)), el('span', 'lb-when', ago(r.when)));
      li.append(who, sc);
      return li;
    }));
  };

  const draw = () => {
    els.mode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    els.diff.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.diff) === state.diff)));
    if (state.mode === 'overall') drawOverall(); else drawSong();
    drawRecent();
    drawStats();
  };

  const drawLive = () => {
    els.live.classList.toggle('is-down', state.down);
    if (state.down) {
      els.liveText.textContent = state.lastOk
        ? `The score server is not answering. Showing the boards from ${ago(state.lastOk / 1000)}.`
        : 'The score server is not answering right now. Try again in a minute.';
      return;
    }
    const s = Math.round((Date.now() - state.lastOk) / 1000);
    els.liveText.textContent = `Live. Updated ${s < 5 ? 'just now' : `${s}s ago`}, checked every 30 seconds.`;
  };

  // ------------------------------------------------------------ loading
  const loadSummary = async () => {
    const records = await get(`/summary?n=${OVERALL_ROWS}`);
    state.summary = {
      version: records.find((r) => r.kind === 'version')?.value ?? '',
      players: records.filter((r) => r.kind === 'player'),
      recent: records.filter((r) => r.kind === 'recent'),
    };
  };

  const loadSongs = async () => {
    state.songs = (await get('/boards?n=500')).filter((r) => r.kind === 'song');
  };

  const loadSong = async (key) => {
    const boards = await Promise.all(DIFFS.map((_, d) =>
      get(`/board?song=${encodeURIComponent(key)}&diff=${d}&n=${SONG_ROWS}`).then((recs) => ({
        rows: recs.filter((r) => r.kind === 'row'),
      }))));
    state.boards[key] = boards;
    return boards;
  };

  const refresh = async () => {
    try {
      const jobs = [loadSummary(), loadSongs()];
      if (state.mode === 'song' && state.song) jobs.push(loadSong(state.song));
      await Promise.all(jobs);
      state.down = false;
      state.lastOk = Date.now();
      // Open on the hardest difficulty anybody has scores on, until the visitor picks one.
      if (!state.diffChosen && state.mode === 'overall') {
        const best = [3, 2, 1, 0].find((d) => state.summary.players.some((p) => Number(p.value) === d));
        if (best != null) state.diff = best;
      }
    } catch {
      state.down = true;
    }
    draw();
    drawLive();
  };

  // ------------------------------------------------------------ the address bar
  // #song=<key>&diff=<n> or #overall&diff=<n>, so a board can be linked to.
  const writeHash = () => {
    const parts = state.mode === 'song' && state.song ? [`song=${encodeURIComponent(state.song)}`] : [state.mode];
    parts.push(`diff=${state.diff}`);
    history.replaceState(null, '', `#${parts.join('&')}`);
  };

  const readHash = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    const d = Number(h.get('diff'));
    if (d >= 0 && d <= 3 && h.has('diff')) { state.diff = d; state.diffChosen = true; }
    if (h.has('song')) { state.mode = 'song'; state.song = h.get('song') || null; }
  };

  const pickSong = async (key) => {
    state.song = key;
    writeHash();
    draw();
    try {
      const boards = state.boards[key] ?? await loadSong(key);
      // Land on the hardest difficulty anybody has actually sung, unless one was linked.
      if (boards[state.diff].rows.length === 0) {
        const best = [3, 2, 1, 0].find((d) => boards[d].rows.length > 0);
        if (best != null) state.diff = best;
        writeHash();
      }
    } catch { state.down = true; drawLive(); }
    draw();
  };

  // ------------------------------------------------------------ wiring
  els.mode.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    writeHash();
    if (state.mode === 'song' && state.song && !state.boards[state.song]) pickSong(state.song);
    draw();
  });
  els.diff.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-diff]');
    if (!b) return;
    state.diff = Number(b.dataset.diff);
    state.diffChosen = true;
    writeHash();
    draw();
  });
  els.search.addEventListener('input', drawSongList);

  readHash();
  draw();
  refresh().then(() => { if (state.mode === 'song' && state.song) pickSong(state.song); });
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  setInterval(drawLive, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
