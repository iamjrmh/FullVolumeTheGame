// GET /api/releases
//
// The release notes off GitHub, parsed into the shape /changelog/ renders. This
// is what keeps the page current on its own: publish a release and the next
// visitor sees it, with nothing rebuilt and nothing committed.
//
// GitHub allows sixty unauthenticated requests an hour per address, which a
// popular page would burn through in minutes, so the answer is held on the CDN
// for ten minutes and served stale for a day while it is refreshed behind the
// scenes. One GitHub call per ten minutes, however many people are reading.
// A GITHUB_TOKEN in the site's environment lifts the limit to five thousand
// but is not required.

import { fetchReleases, buildChangelog } from "../lib/releasenotes.mjs";
import { env, problem } from "../lib/http.mjs";

const CDN_CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=86400";

export default async function handler() {
  try {
    const raw = await fetchReleases({ token: env("GITHUB_TOKEN") });
    const doc = buildChangelog(raw);

    if (!doc.releases.length) return problem("GitHub returned no releases", 502);

    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "Netlify-CDN-Cache-Control": CDN_CACHE,
        "Netlify-Vary": "query",
      },
    });
  } catch (err) {
    // The page falls back to the baked copy in docs/changelog/releases.js, so a
    // failure here costs freshness, not the page. Say why in the body anyway.
    return problem(`Could not read the releases: ${err.message}`, 502);
  }
}

export const config = { path: "/api/releases", method: ["GET"] };
