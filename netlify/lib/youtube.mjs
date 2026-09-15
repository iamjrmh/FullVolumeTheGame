// What the site's video player needs to know about a YouTube video, read off
// YouTube itself so that swapping the link is the only thing anybody has to do.
//
//   title, lengthSeconds   the caption under the player
//   chapters               the chapter list and the seek bar's segments
//   storyboard             the seek-preview sprite sheets the ambient glow is
//                          painted from (the player is a cross-origin iframe, so
//                          its pixels can never be read directly)
//   qualities              the quality menu, with real frame rates ("1080p60")
//
// Where it comes from, and what YouTube lets a data centre have (measured from
// Netlify, September 2026):
//
//   player API, as the iOS / Android apps call it   everything, but for newer or
//                                                   low-view videos YouTube asks a
//                                                   data-centre address to "sign in
//                                                   to confirm you're not a bot"
//   watch page                                      chapters survive that bot check;
//                                                   the storyboard does not
//   oEmbed                                          title and channel, always
//
// So from Netlify a new video reliably gets only its title and chapters. The
// storyboard and quality list come through the home relay (relay/video-relay.mjs,
// which runs this same file on a home connection; see lib/videometa.mjs), or from
// tools/seed-video.mjs run on a home computer if the relay is down. The function keeps the
// best answer it has ever had (see mergeVideoMeta), and copies the sprite sheets
// onto the site (mirrorStoryboard) so a signed YouTube URL can never go stale.
//
// No dependency on Netlify here; the seed tool and the local test server import
// this file as-is.

const PLAYER_API = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const OEMBED = "https://www.youtube.com/oembed?format=json&url=";
const ID_PATTERN = /^[\w-]{11}$/;
const REQUEST_TIMEOUT_MS = 8000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

// In the order they are tried. The web client is last: it answers title, length
// and description but never the storyboard or formats without a proof-of-origin token.
const PLAYER_CLIENTS = [
  {
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    context: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" },
  },
  {
    userAgent: "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    context: { clientName: "ANDROID_VR", clientVersion: "1.62.27", androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
  },
  {
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
    context: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, osName: "Android", osVersion: "14" },
  },
  {
    userAgent: BROWSER_UA,
    context: { clientName: "WEB", clientVersion: "2.20250910.00.00" },
  },
];

// YouTube's rules for description chapters: the first starts at 0:00, there
// are at least three, and they run in order.
const MIN_DESCRIPTION_CHAPTERS = 3;
const TIMESTAMP_FIRST = /^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|.)]*\s*(.+?)\s*$/;
const TIMESTAMP_LAST = /^\s*(.+?)\s*[-–—:|(\[]*\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*$/;

/** The 11-character id out of any YouTube link (watch, youtu.be, embed, shorts, live) or a bare id. */
export function parseYouTubeId(input) {
  const text = String(input ?? "").trim();
  if (ID_PATTERN.test(text)) return text;
  const match = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(text);
  return match ? match[1] : null;
}

function toSeconds(stamp) {
  return stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** Chapters written into a video's description, or [] if it does not follow YouTube's rules. */
export function chaptersFromDescription(description, lengthSeconds = Infinity) {
  const chapters = [];
  for (const line of String(description ?? "").split(/\r?\n/)) {
    const first = TIMESTAMP_FIRST.exec(line);
    const last = first ? null : TIMESTAMP_LAST.exec(line);
    if (!first && !last) continue;
    const t = toSeconds(first ? first[1] : last[2]);
    const title = (first ? first[2] : last[1]).trim();
    if (!title || t >= lengthSeconds) continue;
    if (chapters.length && t <= chapters[chapters.length - 1].t) continue;
    chapters.push({ t, title });
  }
  if (chapters.length < MIN_DESCRIPTION_CHAPTERS || chapters[0].t !== 0) return [];
  return chapters;
}

/**
 * The storyboard spec string turned into sprite sheets. The level with 80x45
 * frames is plenty for a glow that gets blurred by 60px, and it is two or three
 * small images for a whole video.
 */
export function parseStoryboard(spec, lengthSeconds) {
  if (!spec) return null;
  const [base, ...levels] = spec.split("|");
  const parsed = levels.map((entry, index) => {
    const [width, height, count, cols, rows, intervalMs, name, sigh] = entry.split("#");
    return { index, width: +width, height: +height, count: +count, cols: +cols, rows: +rows, intervalMs: +intervalMs, name, sigh };
  }).filter((l) => l.count > 0 && l.cols > 0 && l.rows > 0 && l.name);
  const level = parsed.find((l) => l.width === 80) ?? parsed[parsed.length - 1];
  if (!level) return null;

  const perSheet = level.cols * level.rows;
  const sheets = [];
  for (let sheet = 0; sheet * perSheet < level.count; sheet++) {
    const framesInSheet = Math.min(perSheet, level.count - sheet * perSheet);
    const path = base.replace("$L", String(level.index)).replace("$N", level.name.replace("$M", String(sheet)));
    const url = level.sigh ? `${path}${path.includes("?") ? "&" : "?"}sigh=${encodeURIComponent(level.sigh)}` : path;
    sheets.push({ url, rows: Math.ceil(framesInSheet / level.cols) });
  }
  // An interval of 0 means the frames are spread evenly over the whole video.
  const intervalMs = level.intervalMs || (lengthSeconds * 1000) / level.count;
  return { count: level.count, cols: level.cols, perSheet, intervalMs, sheets };
}

/** One entry per quality the video is encoded at, best first: { quality: "hd1080", label: "1080p60", width, height, fps }. */
export function qualitiesFromFormats(formats) {
  const byQuality = new Map();
  for (const f of formats ?? []) {
    if (!f.qualityLabel || !f.quality || !f.width || !f.height) continue;
    const current = byQuality.get(f.quality);
    if (!current || (f.fps ?? 0) > current.fps) {
      byQuality.set(f.quality, { quality: f.quality, label: f.qualityLabel, width: f.width, height: f.height, fps: f.fps ?? 30 });
    }
  }
  return [...byQuality.values()].sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function askPlayerApi(id, client) {
  const res = await fetchWithTimeout(PLAYER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": client.userAgent, "Accept-Language": "en-US,en;q=0.9" },
    body: JSON.stringify({ videoId: id, context: { client: { ...client.context, hl: "en" } } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

async function readWatchPage(id) {
  const res = await fetchWithTimeout(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const chapters = [];
  const seen = new Set();
  const chapterPattern = /"chapterRenderer":\{"title":\{"simpleText":"((?:[^"\\]|\\.)*)"\},"timeRangeStartMillis":(\d+)/g;
  for (let m; (m = chapterPattern.exec(html)); ) {
    const t = Math.round(Number(m[2]) / 1000);
    if (seen.has(t)) continue;
    seen.add(t);
    chapters.push({ t, title: unescapeJsonString(m[1]) });
  }
  const spec = /"playerStoryboardSpecRenderer":\{"spec":"((?:[^"\\]|\\.)*)"/.exec(html);
  const length = /"lengthSeconds":"(\d+)"/.exec(html);
  return {
    chapters: chapters.sort((a, b) => a.t - b.t),
    storyboardSpec: spec ? unescapeJsonString(spec[1]) : "",
    lengthSeconds: length ? Number(length[1]) : 0,
    botCheck: /confirm you.re not a bot/i.test(html),
  };
}

async function readOEmbed(id) {
  const res = await fetchWithTimeout(`${OEMBED}${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "embedding is turned off for this video" : `HTTP ${res.status}`);
  return res.json();
}

/**
 * Everything YouTube will tell this address about one video. Throws only when
 * not even the title could be read (a private, deleted or non-embeddable video);
 * anything less comes back as an empty field, named in `warnings`.
 */
export async function fetchVideoMeta(id) {
  if (!ID_PATTERN.test(id)) throw new Error("Not a YouTube video id");
  const warnings = [];

  let player = null;
  for (const client of PLAYER_CLIENTS) {
    const name = client.context.clientName;
    try {
      const answer = await askPlayerApi(id, client);
      if (!answer.videoDetails) {
        warnings.push(`player API ${name}: ${answer.playabilityStatus?.reason || answer.playabilityStatus?.status || "no video details"}`);
        continue;
      }
      if (!player || (answer.storyboards && !player.storyboards)) player = answer;
      if (player.storyboards && player.streamingData) break;
    } catch (err) {
      warnings.push(`player API ${name}: ${err.message}`);
    }
  }

  const details = player?.videoDetails;
  let lengthSeconds = Number(details?.lengthSeconds) || 0;
  let chapters = chaptersFromDescription(details?.shortDescription, lengthSeconds || Infinity);
  let storyboardSpec = player?.storyboards?.playerStoryboardSpecRenderer?.spec ?? "";

  if (!chapters.length || !storyboardSpec || !lengthSeconds) {
    try {
      const page = await readWatchPage(id);
      if (!chapters.length) chapters = page.chapters;
      if (!storyboardSpec) storyboardSpec = page.storyboardSpec;
      if (!lengthSeconds) lengthSeconds = page.lengthSeconds;
      if (page.botCheck) warnings.push("watch page: YouTube asked for a bot check");
    } catch (err) {
      warnings.push(`watch page: ${err.message}`);
    }
  }

  let title = details?.title ?? "";
  let author = details?.author ?? "";
  if (!title) {
    try {
      const embed = await readOEmbed(id);
      title = embed.title ?? "";
      author = embed.author_name ?? "";
    } catch (err) {
      warnings.push(`oEmbed: ${err.message}`);
    }
  }
  if (!title) throw new Error(`YouTube would not describe the video (${warnings.join("; ")})`);

  const storyboard = parseStoryboard(storyboardSpec, lengthSeconds);
  const qualities = qualitiesFromFormats(player?.streamingData?.adaptiveFormats);
  if (!storyboard) warnings.push("no storyboard: the glow falls back to YouTube's frame thumbnails");
  if (!qualities.length) warnings.push("no quality list: the player's own list is used, without frame rates");

  return {
    id,
    title,
    author,
    lengthSeconds,
    chapters,
    storyboard,
    qualities,
    fetchedAt: new Date().toISOString(),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** True once a video has everything the player can use. */
export const isCompleteMeta = (meta) => Boolean(meta?.storyboard && meta.qualities?.length && meta.lengthSeconds);

/**
 * A fresh read laid over the best one kept. A field YouTube withheld this time
 * (it is usually the storyboard, behind a bot check) keeps its last good value,
 * and a storyboard already copied onto the site is never swapped back for
 * YouTube's own signed URLs.
 */
export function mergeVideoMeta(fresh, kept) {
  if (!fresh) return kept ?? null;
  if (!kept || kept.id !== fresh.id) return fresh;
  const merged = {
    ...fresh,
    title: fresh.title || kept.title,
    author: fresh.author || kept.author,
    lengthSeconds: fresh.lengthSeconds || kept.lengthSeconds,
    chapters: fresh.chapters.length ? fresh.chapters : kept.chapters ?? [],
    storyboard: kept.storyboard?.mirrored ? kept.storyboard : fresh.storyboard ?? kept.storyboard ?? null,
    qualities: fresh.qualities.length ? fresh.qualities : kept.qualities ?? [],
  };
  const stillMissing = (fresh.warnings ?? []).filter((w) =>
    !(w.startsWith("no storyboard") && merged.storyboard) && !(w.startsWith("no quality list") && merged.qualities.length));
  if (stillMissing.length) merged.warnings = stillMissing;
  else delete merged.warnings;
  return merged;
}

/**
 * Copies a storyboard's sprite sheets out of YouTube's signed URLs and onto the
 * site. `put(key, bytes, contentType)` stores one sheet; `urlFor(key)` is where
 * the site serves it back. Returns the storyboard pointing at the copies.
 */
export async function mirrorStoryboard(id, storyboard, { put, urlFor }) {
  const version = Date.now().toString(36);
  const sheets = [];
  for (const [index, sheet] of storyboard.sheets.entries()) {
    const res = await fetchWithTimeout(sheet.url, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) throw new Error(`sprite sheet ${index} returned HTTP ${res.status}`);
    const key = `${id}/${index}`;
    await put(key, await res.arrayBuffer(), res.headers.get("content-type") || "image/webp");
    sheets.push({ url: `${urlFor(key)}?v=${version}`, rows: sheet.rows });
  }
  return { ...storyboard, sheets, mirrored: version };
}
