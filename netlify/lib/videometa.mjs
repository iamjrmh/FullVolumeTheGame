// The charter page's video: which one it is, and everything the player needs
// to know about it. Shared by functions/video.mjs (the page), functions/admin.mjs
// (choosing it) and tools/seed-video.mjs (filling one in from home).
//
// Two ways to ask YouTube, best first:
//
//   the home relay (relay/video-relay.mjs, behind a Cloudflare Tunnel)
//       a home connection, which YouTube does not put a bot check in front of.
//       Used when VIDEO_RELAY_URL and VIDEO_RELAY_SECRET are set.
//   directly, from wherever this runs
//       from Netlify, a newer video comes back without its storyboard or quality
//       list; from a home computer (the seed tool), it comes back whole.
//
// A relay answer that is already complete is used as it is; anything less is
// topped up with a direct read, and whatever is still missing keeps its last
// good value from Blobs (see mergeVideoMeta).

import { purgeCache } from "@netlify/functions";

import { fetchVideoMeta, mergeVideoMeta, mirrorStoryboard, isCompleteMeta, parseYouTubeId } from "./youtube.mjs";
import { videoMeta, videoSprites, siteSettings } from "./stores.mjs";
import { env } from "./http.mjs";

const RELAY_TIMEOUT_MS = 15000;
const SETTINGS_KEY = "charter-video";

/** What the charter page plays until an admin picks something else: the official charting guide. */
export const DEFAULT_CHARTER_VIDEO = "xz3xTRKMnO8";

export const spriteUrl = (key) => `/api/video-sprite/${key}`;

/** CDN cache tags on /api/video answers, so a change or a seed can purge them. */
export const CURRENT_VIDEO_TAG = "video-current";
export const cacheTagFor = (id) => `video-${id}`;

/** Empties the CDN copies of /api/video. Only works inside a Netlify function. */
export async function purgeVideoCache(id) {
  try {
    await purgeCache({ tags: [CURRENT_VIDEO_TAG, cacheTagFor(id)] });
  } catch (err) {
    console.error(`video-meta: could not purge the cache for ${id}: ${err.message}`);
  }
}

/** { id, url, setAt, setBy } for the video the charter page plays. */
export async function currentCharterVideo(outside) {
  const chosen = await siteSettings(outside).get(SETTINGS_KEY, { type: "json" }).catch(() => null);
  if (chosen && parseYouTubeId(chosen.id)) return chosen;
  return { id: DEFAULT_CHARTER_VIDEO, url: `https://www.youtube.com/watch?v=${DEFAULT_CHARTER_VIDEO}`, setAt: null, setBy: null };
}

export async function setCharterVideo(id, admin) {
  const chosen = { id, url: `https://www.youtube.com/watch?v=${id}`, setAt: new Date().toISOString(), setBy: admin.name };
  await siteSettings().setJSON(SETTINGS_KEY, chosen);
  return chosen;
}

/** The kept details for a video, or null. */
export const keptVideoMeta = (id, outside) => videoMeta(outside).get(id, { type: "json" }).catch(() => null);

/** The relay's answer, or null when no relay is configured. Throws when one is configured and fails. */
async function readFromRelay(id) {
  const base = env("VIDEO_RELAY_URL").replace(/\/+$/, "");
  const secret = env("VIDEO_RELAY_SECRET");
  if (!base || !secret) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/video?v=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return { ...body, via: "relay" };
  } finally {
    clearTimeout(timer);
  }
}

async function readFresh(id) {
  let relayed = null;
  let relayProblem = "";
  try {
    relayed = await readFromRelay(id);
  } catch (err) {
    relayProblem = `relay: ${err.name === "AbortError" ? "timed out" : err.message}`;
    console.error(`video-meta: ${id}: ${relayProblem}`);
  }
  if (isCompleteMeta(relayed)) return relayed;

  try {
    const direct = { ...(await fetchVideoMeta(id)), via: relayed ? "relay+direct" : "direct" };
    const merged = mergeVideoMeta(direct, relayed);
    if (relayProblem) merged.warnings = [relayProblem, ...(merged.warnings ?? [])];
    return merged;
  } catch (err) {
    if (relayed) return relayed;
    throw relayProblem ? new Error(`${relayProblem}; direct: ${err.message}`) : err;
  }
}

/**
 * Asks YouTube, lays the answer over what is kept, copies a new storyboard onto
 * the site, and keeps the result. Returns { meta, fresh } where fresh is false
 * when YouTube could not be read and the kept copy is all there is; throws when
 * there is neither.
 *
 * `reread` starts over from the fresh answer when that answer is complete, so a
 * video that has been changed on YouTube (new chapters, a re-cut) gets a new
 * storyboard copy instead of keeping the old one forever.
 */
export async function refreshVideoMeta(id, outside, { reread = false } = {}) {
  const store = videoMeta(outside);
  const kept = await store.get(id, { type: "json" }).catch(() => null);

  let fresh = null;
  let failure = null;
  try {
    fresh = await readFresh(id);
  } catch (err) {
    failure = err;
  }
  if (!fresh) {
    if (kept) return { meta: kept, fresh: false };
    throw failure;
  }

  const meta = mergeVideoMeta(fresh, reread && isCompleteMeta(fresh) ? null : kept);
  if (meta.storyboard && !meta.storyboard.mirrored) {
    const sprites = videoSprites(outside);
    try {
      meta.storyboard = await mirrorStoryboard(id, meta.storyboard, {
        put: (key, bytes, contentType) => sprites.set(key, bytes, { metadata: { contentType } }),
        urlFor: spriteUrl,
      });
    } catch (err) {
      // YouTube's signed URLs still work for now; the copy is retried next time.
      console.error(`video-meta: could not copy the storyboard for ${id}: ${err.message}`);
    }
  }

  try {
    await store.setJSON(id, meta);
  } catch (err) {
    console.error(`video-meta: could not keep ${id}: ${err.message}`);
  }
  return { meta, fresh: true };
}
