// Reading .fvchart files that sit in charters' public Google Drive folders.
//
// Nothing is downloaded whole. Drive's file host answers byte ranges, so a
// chart is read as: the zip's central directory off the end of the file, then
// just the manifest and the cover. A few hundred KB out of a 60 MB song.
//
// The container is described in FullVolumeCharter's docs/FVCHART.md:
// "FVCHART", a version byte, then an ordinary zip with every byte XORed by a
// keystream that restarts every 4096 bytes.

import { inflateRawSync } from "node:zlib";

const FOLDER_VIEW = "https://drive.google.com/embeddedfolderview?id=";
const FILE_URL = "https://drive.usercontent.google.com/download?export=download&confirm=t&id=";
const UA = "FullVolumeMarketplace/1.0 (fullvolumethegame.xyz)";

const HEADER = "FVCHART";
const HEADER_LEN = 8;
const BLOCK = 4096;
const SEED = 0x5f564348;
const SALT = 0x9e3779b9;
const MAX_FOLDER_DEPTH = 4;
const MAX_COVER_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

export const COLS = ["id", "title", "artist", "album", "charter", "genre", "year",
  "length", "art", "added", "size", "notes", "color", "name"];

// ---------------------------------------------------------------- the veil

const blockCache = new Map();

function keystreamBlock(block) {
  let keys = blockCache.get(block);
  if (keys) return keys;
  let state = (SEED ^ Math.imul(block, SALT) ^ Math.floor(block / 2 ** 32)) >>> 0;
  if (state === 0) state = 1;
  keys = new Uint8Array(BLOCK);
  for (let j = 0; j < BLOCK; j++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    keys[j] = state >>> 24;
  }
  if (blockCache.size > 256) blockCache.clear();
  blockCache.set(block, keys);
  return keys;
}

export function unveil(bytes, payloadOffset) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const pos = payloadOffset + i;
    out[i] = bytes[i] ^ keystreamBlock(Math.floor(pos / BLOCK))[pos % BLOCK];
  }
  return out;
}

// ---------------------------------------------------------------- http

async function get(url, range) {
  const headers = { "User-Agent": UA };
  if (range) headers.Range = `bytes=${range[0]}-${range[1] ?? ""}`;
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Drive answered ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
}

class RemoteChart {
  static async open(fileId) {
    const chart = new RemoteChart();
    chart.url = FILE_URL + encodeURIComponent(fileId);
    const { bytes, headers } = await get(chart.url, [0, HEADER_LEN - 1]);
    const total = /\/(\d+)$/.exec(headers.get("content-range") || "");
    if (!total || bytes.length !== HEADER_LEN) {
      throw new Error("Drive did not answer a byte range (is the file shared publicly?)");
    }
    if (new TextDecoder().decode(bytes.subarray(0, 7)) !== HEADER) throw new Error("not a .fvchart (header missing)");
    chart.size = Number(total[1]);
    const name = /filename="([^"]+)"/.exec(headers.get("content-disposition") || "");
    chart.fileName = name ? name[1] : "";
    return chart;
  }

  get zipSize() { return this.size - HEADER_LEN; }

  async read(offset, length) {
    if (length <= 0) return new Uint8Array(0);
    const start = HEADER_LEN + offset;
    const { bytes } = await get(this.url, [start, start + length - 1]);
    return unveil(bytes, offset);
  }
}

/** The size of a chart on Drive, for telling an unchanged one from a new one. */
export async function chartSize(fileId) {
  return (await RemoteChart.open(fileId)).size;
}

// ---------------------------------------------------------------- zip

function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

function lastIndexOf(bytes, sig, before = bytes.length) {
  for (let i = Math.min(before, bytes.length - sig.length); i >= 0; i--) {
    if (bytes[i] === sig[0] && bytes[i + 1] === sig[1] && bytes[i + 2] === sig[2] && bytes[i + 3] === sig[3]) return i;
  }
  return -1;
}

const EOCD = [0x50, 0x4b, 0x05, 0x06];
const EOCD64_LOCATOR = [0x50, 0x4b, 0x06, 0x07];

async function centralDirectory(chart) {
  // Every round trip to Drive costs about a second, so the tail read is big
  // enough that a normal chart's central directory arrives with it.
  const tailLen = Math.min(chart.zipSize, 256 * 1024);
  const tailAt = chart.zipSize - tailLen;
  const tail = await chart.read(tailAt, tailLen);
  const at = lastIndexOf(tail, EOCD);
  if (at < 0) throw new Error("zip end record not found");
  const dv = view(tail);
  let count = dv.getUint16(at + 10, true);
  let cdSize = dv.getUint32(at + 12, true);
  let cdOffset = dv.getUint32(at + 16, true);

  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locator = lastIndexOf(tail, EOCD64_LOCATOR, at);
    if (locator < 0) throw new Error("zip64 locator not found");
    const record = view(await chart.read(Number(dv.getBigUint64(locator + 8, true)), 56));
    count = Number(record.getBigUint64(32, true));
    cdSize = Number(record.getBigUint64(40, true));
    cdOffset = Number(record.getBigUint64(48, true));
  }

  const cd = cdOffset >= tailAt && cdOffset + cdSize <= chart.zipSize
    ? tail.subarray(cdOffset - tailAt, cdOffset - tailAt + cdSize)
    : await chart.read(cdOffset, cdSize);
  const cv = view(cd);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = cv.getUint16(p + 10, true);
    let csize = cv.getUint32(p + 20, true);
    let usize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let local = cv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));

    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const tag = cv.getUint16(e, true);
      const size = cv.getUint16(e + 2, true);
      if (tag === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(cv.getBigUint64(q, true)); }
      }
      e += 4 + size;
    }
    entries.push({ name, method, csize, usize, local });
    p = extraEnd + commentLen;
  }
  return entries;
}

// A local header's name and extra field are nearly always the same length as
// the central directory's copy, so the header and the data are asked for in one
// range with some slack, and a second request only happens if that guess was short.
const LOCAL_SLACK = 1024;

async function readEntry(chart, entry) {
  const want = Math.min(30 + LOCAL_SLACK + entry.csize, chart.zipSize - entry.local);
  const chunk = await chart.read(entry.local, want);
  const local = view(chunk);
  if (local.getUint32(0, true) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const skip = 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = skip + entry.csize <= chunk.length
    ? chunk.subarray(skip, skip + entry.csize)
    : await chart.read(entry.local + skip, entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`${entry.name} uses zip method ${entry.method}`);
}

// ---------------------------------------------------------------- drive folders

/** { kind: "folder" | "file", id } from any shape of Drive link, or null. */
export function parseDriveLink(url) {
  const text = String(url || "").trim();
  if (!/^https:\/\/(drive|docs)\.google\.com\//i.test(text)) return null;
  let m = /\/folders\/([\w-]{10,})/.exec(text);
  if (m) return { kind: "folder", id: m[1] };
  m = /\/file\/d\/([\w-]{10,})/.exec(text) || /[?&]id=([\w-]{10,})/.exec(text);
  return m ? { kind: "file", id: m[1] } : null;
}

export const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

async function readFolder(folderId) {
  const res = await fetch(FOLDER_VIEW + encodeURIComponent(folderId), {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const page = await res.text();
  // A private or missing folder answers with a sign-in page, not the listing.
  if (!res.ok || !page.includes("flip-")) throw new Error("folder is not shared publicly, or does not exist");
  const title = /<title>([\s\S]*?)<\/title>/.exec(page);
  const entries = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?flip-entry-title">([\s\S]*?)<\/div>/g;
  for (let m; (m = re.exec(page));) {
    entries.push({ id: m[1], title: decodeHtml(m[2]).trim(), isFolder: m[0].includes(`/drive/folders/${m[1]}`) });
  }
  return { name: title ? decodeHtml(title[1]).trim() : "", entries };
}

/**
 * Every .fvchart under a shared folder, subfolders included:
 * [{ fileId, name, folder }]. Charters lay a folder out as
 * Artist > "Song - Artist.fvchart", so `folder` is normally the artist.
 * Stops walking once `deadline` (a Date.now() value) has passed and reports
 * complete: false.
 */
export async function listCharts(folderId, deadline = Infinity) {
  const charts = [];
  let folders = 0;
  let complete = true;
  let level = [folderId];

  for (let depth = 0; level.length && depth <= MAX_FOLDER_DEPTH; depth++) {
    const next = [];
    for (let i = 0; i < level.length; i += 6) {
      if (Date.now() > deadline) { complete = false; return { charts, folders, complete }; }
      const batch = await Promise.all(level.slice(i, i + 6).map((id) => readFolder(id).then(
        (f) => f,
        (err) => { if (id === folderId) throw err; complete = false; return null; },
      )));
      for (const folder of batch) {
        if (!folder) continue;
        folders++;
        for (const entry of folder.entries) {
          if (entry.isFolder) next.push(entry.id);
          else if (entry.title.toLowerCase().endsWith(".fvchart")) {
            charts.push({ fileId: entry.id, name: entry.title, folder: folder.name });
          }
        }
      }
    }
    level = next;
  }
  if (level.length) complete = false;
  return { charts, folders, complete };
}

/** ["Song", "Artist"] out of "Song - Artist.fvchart", or null. */
export function namedParts(fileName) {
  const stem = fileName.replace(/\.fvchart$/i, "");
  const at = stem.lastIndexOf(" - ");
  if (at <= 0) return null;
  const song = stem.slice(0, at).trim();
  const artist = stem.slice(at + 3).trim();
  return song && artist ? [song, artist] : null;
}

/** Why a chart breaks the Artist > "Song - Artist.fvchart" layout, or "". */
export function layoutProblem(fileName, folderName) {
  const parts = namedParts(fileName);
  if (!parts) return `named "${fileName}", expected "Song - Artist.fvchart"`;
  if (folderName && parts[1].toLowerCase() !== folderName.toLowerCase()) {
    return `"${fileName}" sits in folder "${folderName}", expected an artist folder named "${parts[1]}"`;
  }
  return "";
}

// ---------------------------------------------------------------- manifest

function plainCharter(rich) {
  const colour = /<color=(#[0-9a-f]{6})[0-9a-f]{0,2}>/i.exec(rich || "");
  return { name: String(rich || "").replace(/<[^>]+>/g, "").trim(), color: colour ? colour[1].toUpperCase() : "" };
}

function yearOf(text) {
  const digits = String(text ?? "").replace(/\D/g, "").slice(0, 4);
  if (digits.length !== 4) return null;
  const year = Number(digits);
  return year >= 1900 && year <= new Date().getUTCFullYear() + 1 ? year : null;
}

function coverType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  return "";
}

/**
 * Open one chart: its index row (in COLS order) and its cover, if it has one
 * the browser can show: { row, cover: { bytes, type } | null }.
 */
export async function openChart({ fileId, name }, fallbackCharter) {
  const chart = await RemoteChart.open(fileId);
  const entries = await centralDirectory(chart);
  const manifestEntry = entries.find((e) => e.name.toLowerCase().endsWith(".json") && !e.name.includes("/"));
  if (!manifestEntry) throw new Error("no manifest at the archive root");
  const manifest = JSON.parse(new TextDecoder().decode(await readEntry(chart, manifestEntry)).replace(/^﻿/, ""));
  if (manifest.format !== "fvchart") throw new Error("manifest does not name the fvchart format");

  const song = manifest.song || {};
  const charter = plainCharter(song.charter);
  const named = namedParts(name || chart.fileName) || ["", ""];

  let cover = null;
  const coverName = manifest.art?.cover;
  const coverEntry = coverName && entries.find((e) => e.name === coverName);
  if (coverEntry && coverEntry.usize <= MAX_COVER_BYTES) {
    const bytes = await readEntry(chart, coverEntry);
    const type = coverType(bytes);
    if (type) cover = { bytes, type };
  }

  const row = [
    fileId,
    String(song.title || "").trim() || named[0] || (name || chart.fileName).replace(/\.fvchart$/i, ""),
    String(song.artist || "").trim() || named[1],
    String(song.album || "").trim(),
    charter.name || fallbackCharter || "",
    String(song.genre || "").trim(),
    yearOf(song.year),
    Math.round(Number(song.duration) || 0),
    cover ? fileId : "",
    String(manifest.exportedAt || "").slice(0, 10),
    chart.size,
    Number(manifest.counts?.notes) || 0,
    charter.color,
    chart.fileName || name || "",
  ];
  return { row, cover };
}
