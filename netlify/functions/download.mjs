// GET /api/download/game
// GET /api/download/charter
//
// The GET IT buttons. Each one sends the browser to the newest release that
// actually carries that product's installer, whichever release that happens to
// be.
//
// It used to be a plain link to
// /releases/latest/download/FullVolumeSetup.exe, which GitHub resolves against
// its single newest release. That was right while the game and the charter
// shipped in the same one. Now that each is released on its own, "newest
// release" is whichever of the two went out last, and the other product's
// button would be a 404 until the next time it happened to be the one
// published. So the answer is worked out per product - see latestFor() in
// ../lib/releasenotes.mjs.
//
// A 302, not a JSON answer the page then follows: the href stays a real link,
// so it is right-clickable, copyable, and works with JavaScript off. The
// redirect is held on the CDN for five minutes, so a release is on the site
// within five minutes of being published and GitHub sees one call in that time
// however many people are clicking.
//
// GitHub counts the download against the asset either way, so /api/downloads
// keeps counting exactly as it did.

import { fetchReleases, latestFor, PRODUCTS, REPO } from "../lib/releasenotes.mjs";
import { env, problem } from "../lib/http.mjs";

const CDN_CACHE = "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";

/** Where to send somebody when GitHub cannot be reached: the releases page. */
const FALLBACK = `https://github.com/${REPO}/releases`;

export default async function handler(request) {
  const product = new URL(request.url).pathname.split("/").filter(Boolean).pop();

  if (!PRODUCTS[product]) {
    return problem(`No such download: ${product}`, 404);
  }

  let target = FALLBACK;
  let resolved = false;

  try {
    const releases = await fetchReleases({ token: env("GITHUB_TOKEN"), limit: 100 });
    const latest = latestFor(releases, product);
    if (latest) {
      target = latest.url;
      resolved = true;
    }
  } catch {
    // Fall through to the releases page. A button that lands somewhere a
    // person can still get the file is worth more than an error page, and the
    // header below says which of the two happened.
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      // A failed lookup must not be cached for five minutes - the next click
      // should try GitHub again.
      "Cache-Control": resolved ? "public, max-age=60" : "no-store",
      "Netlify-CDN-Cache-Control": resolved ? CDN_CACHE : "no-store",
      "X-FV-Resolved": resolved ? "asset" : "fallback",
    },
  });
}

export const config = {
  path: ["/api/download/game", "/api/download/charter"],
  method: ["GET", "HEAD"],
};
