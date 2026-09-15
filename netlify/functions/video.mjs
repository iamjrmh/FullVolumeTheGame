// GET /api/video
//
// The charter page's video: which YouTube video the admin picked, with its
// title, length, chapters, storyboard sprites and quality levels (see
// lib/youtube.mjs for where each comes from, lib/videometa.mjs for how it is
// kept). A browser cannot ask YouTube for any of this itself, so the page asks
// here.
//
// Only the chosen video is ever answered. Taking any id off the query string
// would let anybody point the function, and the home relay behind it, at any
// video they liked and fill Blobs with its sprites. Admins read other videos
// through /api/admin/video.
//
// A complete answer sits on the CDN for six hours and is served stale for a week
// while it refreshes. An incomplete one (YouTube held something back) is cached
// for fifteen minutes, so it gets another try soon. Choosing a video in /admin
// purges both tags below.

import { isCompleteMeta } from "../lib/youtube.mjs";
import { refreshVideoMeta, currentCharterVideo, cacheTagFor, CURRENT_VIDEO_TAG } from "../lib/videometa.mjs";
import { problem } from "../lib/http.mjs";

const COMPLETE_CDN_CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=604800";
const PARTIAL_CDN_CACHE = "public, max-age=0, s-maxage=900, stale-while-revalidate=3600";

export default async function handler() {
  const { id } = await currentCharterVideo();
  try {
    const { meta, fresh } = await refreshVideoMeta(id);
    return new Response(JSON.stringify(fresh ? meta : { ...meta, stale: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "Netlify-CDN-Cache-Control": isCompleteMeta(meta) ? COMPLETE_CDN_CACHE : PARTIAL_CDN_CACHE,
        "Netlify-Cache-Tag": `${CURRENT_VIDEO_TAG},${cacheTagFor(id)}`,
      },
    });
  } catch (err) {
    console.error(`video-meta: ${id}: ${err.message}`);
    // The page still has the id: it plays the video without chapters or the glow.
    return problem(`Could not read the video from YouTube: ${err.message}`, 502, { id });
  }
}

export const config = { path: "/api/video", method: ["GET"] };
