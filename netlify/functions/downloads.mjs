// GET /api/downloads
//
// How many times each installer has been downloaded, added up across every
// release. GitHub keeps a download_count on each release asset; this reads the
// releases list once, sums FullVolumeSetup.exe into "game" and
// FullVolumeCharterSetup.exe into "charter", and hands the pages a number
// each. The pages poll it, so the tally on the site moves within a minute of
// somebody clicking GET IT.
//
// Same rate-limit shape as /api/releases: the answer is held on the CDN for a
// minute and served stale for ten while it is refreshed behind the scenes, so
// however many tabs are polling, GitHub sees one request a minute at most.

import { fetchReleases } from "../lib/releasenotes.mjs";
import { env, problem } from "../lib/http.mjs";

const CDN_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=600";

/** Which asset filename feeds which tally. Source zips are not counted. */
const PRODUCTS = {
  game: "FullVolumeSetup.exe",
  charter: "FullVolumeCharterSetup.exe",
};

/**
 * Fold the raw releases into one tally per product: the grand total, the
 * latest release's own count, and a per-release breakdown newest first.
 */
export function tally(releases) {
  const out = {};
  for (const [product, filename] of Object.entries(PRODUCTS)) {
    const perRelease = [];
    for (const rel of releases) {
      if (rel.draft) continue;
      const asset = (rel.assets || []).find((a) => a.name === filename);
      if (!asset) continue;
      perRelease.push({ tag: rel.tag_name, count: asset.download_count | 0 });
    }
    out[product] = {
      total: perRelease.reduce((sum, r) => sum + r.count, 0),
      latest: perRelease.length ? perRelease[0].count : 0,
      releases: perRelease,
    };
  }
  return out;
}

export default async function handler() {
  try {
    const raw = await fetchReleases({ token: env("GITHUB_TOKEN"), limit: 100 });
    const doc = { ...tally(raw), updated: new Date().toISOString() };

    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30",
        "Netlify-CDN-Cache-Control": CDN_CACHE,
        "Netlify-Vary": "query",
      },
    });
  } catch (err) {
    // The tally simply stays hidden on the page when this fails; there is no
    // number worth showing in its place.
    return problem(`Could not read the download counts: ${err.message}`, 502);
  }
}

export const config = { path: "/api/downloads", method: ["GET"] };
