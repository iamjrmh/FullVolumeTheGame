// The daily refresh.
//
// Runs every hour, but only starts a new sweep once the last finished one is
// a day old. The other runs exist to carry on a sweep too big for one pass,
// so a large sweep finishes within hours instead of creeping along a day at a
// time. A run with nothing to do costs two blob reads.

import { readIndex, refreshPass } from "../lib/refresh.mjs";
import { rateLimits } from "../lib/stores.mjs";

const DAY_MS = 24 * 3600 * 1000;
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
  const due = !index || Date.now() - Date.parse(index.generated) > DAY_MS - SLACK_MS;
  const result = await refreshPass({ budgetMs: 22_000, start: due, trigger: "daily" });
  console.log("daily refresh:", JSON.stringify(result));
};

export const config = { schedule: "@hourly" };
