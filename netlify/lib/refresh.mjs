// Sweeping every verified charter's Drive folder into the community listing.
//
// A function gets 30 seconds, and a sweep of many charters takes longer than
// that, so a sweep is resumable: each pass does what it can inside its time
// budget, saves where it got to under "refresh", and the next pass carries on.
// The admin page calls pass after pass until one reports done; the scheduled
// function resumes an unfinished sweep on its next hourly run.
//
// Only one pass runs at a time. The lock is a create-only blob that expires,
// so a pass that dies mid-way cannot wedge refreshing for good.

import { randomUUID } from "node:crypto";
import { purgeCache } from "@netlify/functions";
import { COLS, chartSize, folderUrl, layoutProblem, listCharts, openChart } from "./fvchart.mjs";
import { allJson, charters, community } from "./stores.mjs";

export const INDEX_KEY = "index";
export const CACHE_TAG = "community-charts";
const STATE_KEY = "refresh";
const LOCK_KEY = "refresh-lock";
const LOCK_MS = 40_000;
const PARALLEL = 6;
const SIZE = COLS.indexOf("size");
const ART = COLS.indexOf("art");

export async function readIndex() {
  return (await community().get(INDEX_KEY, { type: "json" })) || null;
}

// The lock says who is sweeping, not merely that somebody is.
//
// It used to say only "taken until", and that let two passes write over each
// other: the lock expires while a pass is still working, a second pass picks it
// up, reads the state blob as it was before the first pass started, and whichever
// finishes last publishes its own idea of the listing. The loser's work is not
// lost noisily - it is lost silently, as an index with fewer charts in it than
// the same sweep's own folder count, and no error anywhere. That is exactly what
// happened on 2026-09-14: perCharter said 2, rows had 1, errors was empty.
//
// So a holder now stamps the lock with a token nobody else can guess, keeps it
// alive while it works, and checks the lock is still its own before every write.
// A pass that has lost the lock throws its work away rather than publishing it;
// the sweep is resumable, so the next pass simply does that part again.
async function takeLock() {
  const store = community();
  const token = randomUUID();
  const mine = { token, until: Date.now() + LOCK_MS };

  if ((await store.setJSON(LOCK_KEY, mine, { onlyIfNew: true })).modified) return token;

  const held = await store.get(LOCK_KEY, { type: "json" });
  if (held && held.until > Date.now()) return null;

  await store.delete(LOCK_KEY);
  return (await store.setJSON(LOCK_KEY, mine, { onlyIfNew: true })).modified ? token : null;
}

/** Pushes our lock's expiry back, so working for a while cannot lose it. */
async function keepLock(token) {
  const store = community();
  const held = await store.get(LOCK_KEY, { type: "json" });
  if (!held || held.token !== token) return false;

  await store.setJSON(LOCK_KEY, { token, until: Date.now() + LOCK_MS });
  return true;
}

/** Whether the lock is still ours, which is what makes a write safe. */
async function stillOurs(token) {
  const held = await community().get(LOCK_KEY, { type: "json" });
  return !!held && held.token === token;
}

async function releaseLock(token) {
  const store = community();
  const held = await store.get(LOCK_KEY, { type: "json" });

  // Only ever our own. Deleting a lock somebody else now holds would invite the
  // very overwrite this is here to stop.
  if (held && held.token === token) await store.delete(LOCK_KEY);
}

async function newSweep(trigger) {
  const list = await allJson(charters());
  return {
    startedAt: new Date().toISOString(),
    trigger,
    toList: list.map((c) => ({ id: c.id, discord: c.discord })),
    queue: [],
    seen: {},
    rows: [],
    owner: {},
    perCharter: {},
    warnings: [],
    errors: [],
    listed: 0,
    opened: 0,
    reused: 0,
  };
}

/** Where a sweep has got to, for the admin page. */
export function progressOf(state, done) {
  if (!state) return { running: false };
  const handled = state.rows.length + state.errors.filter((e) => e.fileId).length;
  return {
    running: !done,
    startedAt: state.startedAt,
    trigger: state.trigger,
    foldersLeft: state.toList.length,
    chartsFound: handled + state.queue.length,
    chartsDone: handled,
    opened: state.opened,
    reused: state.reused,
    errors: state.errors.length,
  };
}

export async function currentProgress() {
  return progressOf(await community().get(STATE_KEY, { type: "json" }), false);
}

/**
 * One pass. `start` begins a new sweep when none is running (otherwise only an
 * unfinished one is resumed). Returns { busy } when another pass holds the
 * lock, { idle } when there was nothing to do, else the sweep's progress.
 */
export async function refreshPass({ budgetMs = 20_000, start = false, trigger = "admin" } = {}) {
  const deadline = Date.now() + budgetMs;
  const token = await takeLock();
  if (!token) return { busy: true };

  try {
    const store = community();
    let state = await store.get(STATE_KEY, { type: "json" });
    if (!state) {
      if (!start) return { idle: true };
      state = await newSweep(trigger);
    }
    const previous = await readIndex();
    const oldRows = new Map((previous?.rows || []).map((r) => [r[0], r]));

    // 1. List the folders.
    while (state.toList.length && Date.now() < deadline) {
      const charter = state.toList[0];
      try {
        const found = await listCharts(charter.id, deadline);
        if (!found.complete && Date.now() >= deadline) break;          // out of time: redo it next pass
        if (!found.complete) state.warnings.push({ charter: charter.discord, message: "part of the folder could not be read" });
        state.perCharter[charter.id] = found.charts.length;
        for (const chart of found.charts) {
          if (state.seen[chart.fileId]) continue;
          state.seen[chart.fileId] = true;
          state.queue.push({ ...chart, charterId: charter.id, discord: charter.discord });
          const layout = layoutProblem(chart.name, chart.folder);
          if (layout) state.warnings.push({ charter: charter.discord, message: layout });
        }
      } catch (err) {
        // A folder that fails to list keeps last sweep's charts rather than
        // vanishing from the Marketplace over one bad request.
        state.errors.push({ charter: charter.discord, message: err.message });
        for (const [fileId, ownerId] of Object.entries(previous?.owner || {})) {
          if (ownerId !== charter.id || state.seen[fileId] || !oldRows.has(fileId)) continue;
          state.seen[fileId] = true;
          state.rows.push(oldRows.get(fileId));
          state.owner[fileId] = charter.id;
        }
      }
      state.toList.shift();
      state.listed++;
    }

    // 2. Open the charts, reusing any whose size has not changed.
    // A chart takes a few seconds to open, so a batch only starts with room
    // left to finish inside the function's 30 second limit.
    while (!state.toList.length && state.queue.length && Date.now() < deadline - 8000) {
      // Opening a batch is the slow part, so the lock is pushed back before each
      // one rather than being left to run out while charts are being read.
      if (!(await keepLock(token))) return { busy: true };

      const batch = state.queue.splice(0, PARALLEL);
      await Promise.all(batch.map(async (chart) => {
        try {
          const old = oldRows.get(chart.fileId);
          // A row written before a column was added is opened again once, or a
          // chart that never changes would never gain the new column.
          if (old && old.length === COLS.length && (await chartSize(chart.fileId)) === old[SIZE]) {
            state.rows.push(old);
            state.reused++;
          } else {
            const { row, cover } = await openChart(chart, chart.discord);
            if (cover) await store.set(`cover/${chart.fileId}`, cover.bytes, { metadata: { type: cover.type, size: row[SIZE] } });
            state.rows.push(row);
            state.opened++;
          }
          state.owner[chart.fileId] = chart.charterId;
        } catch (err) {
          state.errors.push({ charter: chart.discord, fileId: chart.fileId, message: `${chart.name}: ${err.message}` });
        }
      }));
    }

    // Nothing below here may be written by a pass that no longer holds the lock:
    // somebody else has been working from the state as it was before this pass
    // started, and saving over them is how a sweep loses charts silently.
    if (!(await stillOurs(token))) return { busy: true };

    if (state.toList.length || state.queue.length) {
      await store.setJSON(STATE_KEY, state);
      return progressOf(state, false);
    }

    // 3. Done: publish the listing and tidy up covers nobody uses any more.
    const rows = state.rows.sort((a, b) => a[2].localeCompare(b[2], "en", { sensitivity: "base" })
      || a[1].localeCompare(b[1], "en", { sensitivity: "base" }));
    await store.setJSON(INDEX_KEY, {
      generated: new Date().toISOString(),
      startedAt: state.startedAt,
      trigger: state.trigger,
      cols: COLS,
      count: rows.length,
      rows,
      owner: state.owner,
      perCharter: state.perCharter,
      warnings: state.warnings.slice(0, 200),
      errors: state.errors.slice(0, 200),
    });

    const keep = new Set(rows.map((r) => r[ART]).filter(Boolean));
    const { blobs } = await store.list({ prefix: "cover/" });
    await Promise.all(blobs.filter((b) => !keep.has(b.key.slice(6))).map((b) => store.delete(b.key)));
    await store.delete(STATE_KEY);

    try {
      await purgeCache({ tags: [CACHE_TAG] });
    } catch (err) {
      console.warn("cache purge skipped:", err.message);
    }
    return { ...progressOf(state, true), done: true, count: rows.length };
  } finally {
    await releaseLock(token);
  }
}

/** Drop a removed charter's charts from the listing straight away. */
export async function dropCharter(charterId) {
  const store = community();

  // Under the lock, because this reads the listing, edits it and writes it back -
  // exactly the read-modify-write a sweep publishing at the same moment would
  // undo, or be undone by. Removing somebody is rare and a few seconds' wait for
  // the lock costs nothing; getting it wrong puts a removed charter's songs back
  // on the Marketplace.
  let token = null;
  for (let attempt = 0; attempt < 6 && !token; attempt++) {
    token = await takeLock();
    if (!token) await new Promise((settle) => setTimeout(settle, 1500));
  }

  // Still nothing: the charter is already out of the store, so the next sweep
  // leaves their charts out anyway. Better late than written over a good listing.
  if (!token) return;

  try {
    await removeRowsOwnedBy(store, charterId);
  } finally {
    await releaseLock(token);
  }
}

async function removeRowsOwnedBy(store, charterId) {
  const index = await readIndex();
  if (!index) return;
  const gone = new Set(Object.entries(index.owner || {}).filter(([, o]) => o === charterId).map(([f]) => f));
  if (!gone.size) return;
  index.rows = index.rows.filter((r) => !gone.has(r[0]));
  for (const fileId of gone) delete index.owner[fileId];
  delete index.perCharter?.[charterId];
  index.count = index.rows.length;
  await store.setJSON(INDEX_KEY, index);
  await Promise.all([...gone].map((f) => store.delete(`cover/${f}`)));
  try {
    await purgeCache({ tags: [CACHE_TAG] });
  } catch (err) {
    console.warn("cache purge skipped:", err.message);
  }
}

export { folderUrl };
