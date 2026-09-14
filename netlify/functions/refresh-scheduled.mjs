// The scheduled refresh.
//
// Runs every hour, but only *starts* a new sweep once the last finished one is
// twelve hours old. The other runs exist to carry on a sweep too big for one
// pass, so a large sweep finishes within hours instead of creeping along half a
// day at a time. A run with nothing to do costs two blob reads.
//
// Twice a day rather than once, from 2026-09-13. The cost of a sweep is not the
// number of charts, it is the number that changed: a chart whose size on Drive
// is what it was last time is reused without being opened, so a quiet twelve
// hours costs one cheap request per chart and nothing else. That is what makes
// this affordable to run more often, and it is also the thing to watch if it is
// ever made more frequent still.
//
// Forcing one is a separate path and always available: REFRESH NOW on /admin
// posts to /api/admin/refresh with { start: true }, which begins a sweep
// whatever the index's age.

import { readIndex, refreshPass } from "../lib/refresh.mjs";
import { rateLimits } from "../lib/stores.mjs";

/** How stale the listing has to be before a run starts a new sweep. */
const REFRESH_EVERY_MS = 12 * 3600 * 1000;

// The scheduler fires on the hour and a sweep never finishes exactly on one, so
// without this the twelve-hour mark is always missed by minutes and the sweep
// lands on the thirteenth hour instead.
const SLACK_MS = 30 * 60 * 1000;

// The privacy page promises the application form's rate-limit entries (a
// scrambled IP) last a day. Keys end in their date; anything not dated today
// goes.
async function forgetOldRateLimits() {
  const today = new Date().toISOString().slice(0, 10);
  const store = rateLimits();
  const { blobs } = await store.list({ prefix: "apply/" });
  await Promise.all(blobs.filter((b) => !b.key.endsWith(`/${today}`)).map((b) => store.delete(b.key)));
}

export default async () => {
  await forgetOldRateLimits().catch((err) => console.warn("rate-limit cleanup failed:", err.message));
  const index = await readIndex();
  const due = !index || Date.now() - Date.parse(index.generated) > REFRESH_EVERY_MS - SLACK_MS;
  const result = await refreshPass({ budgetMs: 22_000, start: due, trigger: "scheduled" });
  console.log("scheduled refresh:", JSON.stringify({ due, ...result }));
};

export const config = { schedule: "@hourly" };
