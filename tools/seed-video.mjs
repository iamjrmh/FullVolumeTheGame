#!/usr/bin/env node
// Fills in a video's details on the live site from this computer.
//
// From Netlify's data centre, YouTube often answers a newer video with "sign in
// to confirm you're not a bot" and holds back the storyboard (the ambient glow)
// and the quality list. A home connection is not asked. This reads the video
// here with the same code the function runs, copies the sprite sheets into the
// site's Blobs, keeps the result as the video's best copy, and purges the CDN so
// the next visitor gets it. The function never swaps a kept storyboard back out,
// so this only ever needs doing once per video.
//
//   node tools/seed-video.mjs <YouTube link or id>
//   node tools/seed-video.mjs <link> --dry-run    read and report, store nothing
//
// Credentials: the site id comes from .netlify/state.json (netlify link), the
// token from NETLIFY_AUTH_TOKEN or the Netlify CLI's own login (netlify login).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { fetchVideoMeta, parseYouTubeId, isCompleteMeta } from "../netlify/lib/youtube.mjs";
import { refreshVideoMeta, cacheTagFor, CURRENT_VIDEO_TAG } from "../netlify/lib/videometa.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NETLIFY_API = "https://api.netlify.com/api/v1";

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function netlifyCredentials() {
  const state = await readJsonFile(join(ROOT, ".netlify", "state.json"));
  const siteID = process.env.NETLIFY_SITE_ID || state?.siteId;
  if (!siteID) throw new Error("No site id: run `netlify link` in the repository, or set NETLIFY_SITE_ID");

  let token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    const configDir = process.env.APPDATA ? join(process.env.APPDATA, "netlify", "Config") : join(homedir(), ".config", "netlify");
    const config = await readJsonFile(join(configDir, "config.json"));
    token = config?.users?.[config.userId]?.auth?.token;
  }
  if (!token) throw new Error("No token: run `netlify login`, or set NETLIFY_AUTH_TOKEN");
  return { siteID, token };
}

async function purgeCache({ siteID, token }, id) {
  const res = await fetch(`${NETLIFY_API}/purge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ site_id: siteID, cache_tags: [CURRENT_VIDEO_TAG, cacheTagFor(id)] }),
  });
  if (!res.ok) throw new Error(`cache purge returned HTTP ${res.status}: ${await res.text()}`);
}

function report(meta) {
  const glow = meta.storyboard ? (meta.storyboard.mirrored ? "copied onto the site" : "YouTube's own URLs") : "MISSING";
  console.log(`  ${meta.title}${meta.author ? ` (${meta.author})` : ""}`);
  console.log(`  length     ${meta.lengthSeconds || "unknown"}s`);
  console.log(`  chapters   ${meta.chapters.length}`);
  console.log(`  storyboard ${glow}`);
  console.log(`  qualities  ${meta.qualities.map((q) => q.label).join(", ") || "MISSING"}`);
  for (const warning of meta.warnings ?? []) console.log(`  note       ${warning}`);
}

async function main() {
  const args = process.argv.slice(2);
  const id = parseYouTubeId(args.find((a) => !a.startsWith("--")));
  if (!id) {
    console.error("Usage: node tools/seed-video.mjs <YouTube link or id> [--dry-run]");
    process.exit(2);
  }

  if (args.includes("--dry-run")) {
    report(await fetchVideoMeta(id));
    return;
  }

  const credentials = await netlifyCredentials();
  const { meta } = await refreshVideoMeta(id, credentials);
  report(meta);
  await purgeCache(credentials, id);
  console.log(`  cache      purged ${cacheTagFor(id)}`);
  if (!isCompleteMeta(meta)) {
    console.error("\nYouTube held something back even from here; the player turns those features off for this video.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`seed-video: ${err.message}`);
  process.exit(1);
});
