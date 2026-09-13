// The public side of the community listing.
//
//   GET /api/community-charts        the rows the Marketplace draws
//   GET /api/community-cover/:fileId album art cut out of a chart
//
// The listing is cached at Netlify's edge under a tag, and a finished refresh
// purges that tag, so a new chart shows up at once rather than on a timer.

import { json, problem } from "../lib/http.mjs";
import { CACHE_TAG, readIndex } from "../lib/refresh.mjs";
import { community } from "../lib/stores.mjs";

export default async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/api/community-charts") {
    const index = await readIndex();
    const body = index
      ? { generated: index.generated, source: "drive", count: index.count, cols: index.cols, rows: index.rows }
      : { generated: null, source: "drive", count: 0, cols: [], rows: [] };
    return json(body, 200, {
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=60",
      "Netlify-Cache-Tag": CACHE_TAG,
      "Access-Control-Allow-Origin": "*",
    });
  }

  const cover = /^\/api\/community-cover\/([\w-]{10,})$/.exec(pathname);
  if (cover) {
    const found = await community().getWithMetadata(`cover/${cover[1]}`, { type: "arrayBuffer" });
    if (!found) return problem("No cover.", 404);
    return new Response(found.data, {
      headers: {
        "Content-Type": String(found.metadata?.type || "image/jpeg"),
        "Cache-Control": "public, max-age=86400",
        "Netlify-CDN-Cache-Control": "public, s-maxage=604800",
        "Netlify-Cache-Tag": CACHE_TAG,
      },
    });
  }

  return problem("Not found.", 404);
};

export const config = { path: ["/api/community-charts", "/api/community-cover/*"], method: ["GET"] };
