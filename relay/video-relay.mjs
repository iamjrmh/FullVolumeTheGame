#!/usr/bin/env node
// The home relay for YouTube video details.
//
// From Netlify's data centre, YouTube answers a newer video with "sign in to
// confirm you're not a bot" and holds back the storyboard (the player's ambient
// glow) and the quality list. A home connection is not asked. This runs on the
// home server behind a Cloudflare Tunnel and answers one question for the video
// function: everything lib/youtube.mjs can read about a video, read from here.
//
//   GET /video?v=<id>   Authorization: Bearer <RELAY_SECRET>   -> the video's details
//   GET /health                                               -> "ok"
//
// The secret lives in the server's environment file and in Netlify's environment,
// never in this repository (which is public). Answers are cached for ten minutes
// and the whole relay is rate limited, so a leaked secret can make it ask YouTube
// a few times a minute at most, which is what YouTube sees from any home anyway.
//
// Environment: RELAY_SECRET (required, 32+ characters), RELAY_PORT (8093),
// RELAY_HOST (127.0.0.1 - cloudflared connects locally, nothing else should).

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import { fetchVideoMeta, parseYouTubeId } from "../netlify/lib/youtube.mjs";

const SECRET = process.env.RELAY_SECRET ?? "";
const PORT = Number(process.env.RELAY_PORT) || 8093;
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const MIN_SECRET_LENGTH = 32;
const CACHE_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;

if (SECRET.length < MIN_SECRET_LENGTH) {
  console.error(`RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  process.exit(1);
}

const secretDigest = createHash("sha256").update(SECRET).digest();
const cache = new Map();
let windowStart = Date.now();
let windowCount = 0;

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(createHash("sha256").update(presented).digest(), secretDigest);
}

function withinRateLimit() {
  const now = Date.now();
  if (now - windowStart > RATE_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount <= RATE_LIMIT;
}

function send(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function videoDetails(id) {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta;
  const meta = await fetchVideoMeta(id);
  cache.set(id, { at: Date.now(), meta });
  for (const [key, entry] of cache) if (Date.now() - entry.at >= CACHE_TTL_MS) cache.delete(key);
  return meta;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://relay");
  if (req.method !== "GET") return send(res, 405, "method not allowed");
  if (url.pathname === "/health") return send(res, 200, "ok");
  if (url.pathname !== "/video") return send(res, 404, "not found");
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
  if (!withinRateLimit()) return send(res, 429, { error: "rate limited" });

  const id = parseYouTubeId(url.searchParams.get("v"));
  if (!id) return send(res, 400, { error: "Pass a YouTube link or video id as ?v=" });

  try {
    const meta = await videoDetails(id);
    console.log(`video ${id}: chapters=${meta.chapters.length} storyboard=${Boolean(meta.storyboard)} qualities=${meta.qualities.length}`);
    send(res, 200, meta);
  } catch (err) {
    console.error(`video ${id}: ${err.message}`);
    send(res, 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => console.log(`video relay listening on ${HOST}:${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
