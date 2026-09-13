"""Build the Marketplace's index of community .fvchart files hosted on Google Drive.

Rhythmverse and Chorus Encore host other games' charts; this is the same idea
for FullVolume's own format. Charters keep their files in their own public
Drive folders, listed in ``tools/fvchart-sources.json``, and this script walks
those folders and writes what it finds into ``data/fvchart.js``.

Nothing is downloaded whole. Drive's file host answers byte ranges, so for each
chart this reads the zip's central directory off the end of the file, then just
the manifest and the cover - a few hundred KB out of a 60 MB song. The cover is
shrunk and saved beside the index as ``data/fvcovers/<file id>.jpg``.

A folder is listed through ``drive.google.com/embeddedfolderview``, the static
page Drive serves for embedding a shared folder. It needs no API key and no
sign-in, which is the point: a charter only has to share a folder as "anyone
with the link".

A chart already in the index with the same file size is kept as it is, so a
re-run only opens charts that are new or changed.

The container is described in FullVolumeCharter's docs/FVCHART.md: "FVCHART",
a version byte, then an ordinary zip with every byte XORed by a keystream that
restarts every 4096 bytes.

Usage:
    python tools/collect-fvchart.py           # every source
    python tools/collect-fvchart.py --fresh   # reopen every chart, ignore the old index
"""

from __future__ import annotations

import argparse
import html
import io
import json
import re
import struct
import sys
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "docs"
SOURCES = ROOT / "tools" / "fvchart-sources.json"
OUT = SITE / "data" / "fvchart.js"
COVERS = SITE / "data" / "fvcovers"

UA = "FullVolumeMarketplace/0.9 (fullvolumethegame.xyz)"
FOLDER_VIEW = "https://drive.google.com/embeddedfolderview?id={id}"
FILE_URL = "https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t"

COVER_PX = 256
MAX_FOLDER_DEPTH = 4

# Column order for a row. Mirrored in js/marketplace.js - change both together.
COLS = ["id", "title", "artist", "album", "charter", "genre", "year", "length",
        "art", "added", "size", "notes", "color", "name"]

HEADER = b"FVCHART"
HEADER_LEN = 8
BLOCK = 4096
SEED = 0x5F564348
SALT = 0x9E3779B9
MASK = 0xFFFFFFFF


# ---------------------------------------------------------------- the veil

def keystream_block(block: int) -> bytes:
    """The 4096 keystream bytes of one block, per FVCHART.md."""
    state = (SEED ^ ((block * SALT) & MASK) ^ ((block >> 32) & MASK)) & MASK
    if state == 0:
        state = 1
    out = bytearray(BLOCK)
    for j in range(BLOCK):
        state ^= (state << 13) & MASK
        state ^= state >> 17
        state ^= (state << 5) & MASK
        out[j] = state >> 24
    return bytes(out)


_blocks: dict[int, bytes] = {}


def unveil(data: bytes, payload_offset: int) -> bytes:
    """XOR bytes that start at ``payload_offset`` past the 8-byte header."""
    out = bytearray(len(data))
    i = 0
    while i < len(data):
        pos = payload_offset + i
        block, within = divmod(pos, BLOCK)
        keys = _blocks.get(block)
        if keys is None:
            keys = _blocks[block] = keystream_block(block)
            if len(_blocks) > 256:
                _blocks.clear()
                _blocks[block] = keys
        n = min(BLOCK - within, len(data) - i)
        chunk = int.from_bytes(data[i:i + n], "little") ^ int.from_bytes(keys[within:within + n], "little")
        out[i:i + n] = chunk.to_bytes(n, "little")
        i += n
    return bytes(out)


# ---------------------------------------------------------------- http

def get(url: str, start: int | None = None, end: int | None = None) -> tuple[bytes, dict]:
    headers = {"User-Agent": UA}
    if start is not None:
        headers["Range"] = f"bytes={start}-{'' if end is None else end}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), {k.lower(): v for k, v in r.headers.items()}


class RemoteChart:
    """A .fvchart on Drive, read a range at a time."""

    def __init__(self, file_id: str):
        self.url = FILE_URL.format(id=file_id)
        head, headers = get(self.url, 0, HEADER_LEN - 1)
        total = re.search(r"/(\d+)$", headers.get("content-range", ""))
        if not total or len(head) != HEADER_LEN:
            raise ValueError("Drive did not answer a byte range (is the file shared publicly?)")
        if head[:7] != HEADER:
            raise ValueError("not a .fvchart (header missing)")
        self.version = head[7]
        self.size = int(total.group(1))
        disposition = headers.get("content-disposition", "")
        name = re.search(r'filename="([^"]+)"', disposition)
        self.file_name = name.group(1) if name else ""

    def read(self, offset: int, length: int) -> bytes:
        """Unveiled payload bytes; ``offset`` is inside the zip, not the file."""
        if length <= 0:
            return b""
        start = HEADER_LEN + offset
        raw, _ = get(self.url, start, start + length - 1)
        return unveil(raw, offset)

    @property
    def zip_size(self) -> int:
        return self.size - HEADER_LEN


# ---------------------------------------------------------------- zip

def central_directory(chart: RemoteChart) -> list[dict]:
    tail_len = min(chart.zip_size, 65557 + 20)
    tail_at = chart.zip_size - tail_len
    tail = chart.read(tail_at, tail_len)

    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("zip end record not found")
    _, _, _, _, count, cd_size, cd_offset, _ = struct.unpack("<4sHHHHIIH", tail[eocd:eocd + 22])

    if cd_offset == 0xFFFFFFFF or count == 0xFFFF:
        locator = tail.rfind(b"PK\x06\x07", 0, eocd)
        if locator < 0:
            raise ValueError("zip64 locator not found")
        (eocd64_at,) = struct.unpack("<Q", tail[locator + 8:locator + 16])
        record = chart.read(eocd64_at, 56)
        count, cd_size, cd_offset = struct.unpack("<QQQ", record[32:56])

    cd = chart.read(cd_offset, cd_size)
    entries, p = [], 0
    for _ in range(count):
        if cd[p:p + 4] != b"PK\x01\x02":
            raise ValueError("bad central directory entry")
        (method, csize, usize, name_len, extra_len, comment_len, local_at) = struct.unpack(
            "<6xH8xIIHHH8xI", cd[p + 4:p + 46])
        name = cd[p + 46:p + 46 + name_len].decode("utf-8", "replace")
        extra = cd[p + 46 + name_len:p + 46 + name_len + extra_len]
        csize, usize, local_at = zip64_sizes(extra, csize, usize, local_at)
        entries.append({"name": name, "method": method, "csize": csize,
                        "usize": usize, "local": local_at})
        p += 46 + name_len + extra_len + comment_len
    return entries


def zip64_sizes(extra: bytes, csize: int, usize: int, local_at: int) -> tuple[int, int, int]:
    p = 0
    while p + 4 <= len(extra):
        tag, size = struct.unpack("<HH", extra[p:p + 4])
        if tag == 1:
            values, q = extra[p + 4:p + 4 + size], 0
            if usize == 0xFFFFFFFF:
                (usize,) = struct.unpack("<Q", values[q:q + 8]); q += 8
            if csize == 0xFFFFFFFF:
                (csize,) = struct.unpack("<Q", values[q:q + 8]); q += 8
            if local_at == 0xFFFFFFFF:
                (local_at,) = struct.unpack("<Q", values[q:q + 8])
        p += 4 + size
    return csize, usize, local_at


def read_entry(chart: RemoteChart, entry: dict) -> bytes:
    local = chart.read(entry["local"], 30)
    if local[:4] != b"PK\x03\x04":
        raise ValueError(f"bad local header for {entry['name']}")
    name_len, extra_len = struct.unpack("<HH", local[26:30])
    data = chart.read(entry["local"] + 30 + name_len + extra_len, entry["csize"])
    if entry["method"] == 0:
        return data
    if entry["method"] == 8:
        return zlib.decompress(data, -15)
    raise ValueError(f"{entry['name']} uses zip method {entry['method']}")


# ---------------------------------------------------------------- drive folders

def drive_id(url: str) -> tuple[str, str]:
    """("folder" | "file", id) from any shape of Drive link."""
    m = re.search(r"/folders/([\w-]+)", url)
    if m:
        return "folder", m.group(1)
    m = re.search(r"/file/d/([\w-]+)", url) or re.search(r"[?&]id=([\w-]+)", url)
    if m:
        return "file", m.group(1)
    raise ValueError(f"not a Google Drive link: {url}")


def list_folder(folder_id: str, depth: int = 0) -> list[tuple[str, str, str]]:
    """Every (file id, file name, folder name) under a shared folder, subfolders included.

    Charters lay a folder out as Artist > "Song - Artist.fvchart", so the folder
    a chart sits in is normally its artist."""
    body, _ = get(FOLDER_VIEW.format(id=folder_id))
    page = body.decode("utf-8", "replace")
    folder_name = re.search(r"<title>(.*?)</title>", page, re.S)
    folder_name = html.unescape(folder_name.group(1)).strip() if folder_name else ""
    found: list[tuple[str, str, str]] = []
    for entry in re.finditer(r'<div class="flip-entry" id="entry-([\w-]+)".*?flip-entry-title">(.*?)</div>', page, re.S):
        entry_id, title = entry.group(1), html.unescape(entry.group(2))
        if f"/drive/folders/{entry_id}" in entry.group(0):
            if depth < MAX_FOLDER_DEPTH:
                found += list_folder(entry_id, depth + 1)
        elif title.lower().endswith(".fvchart"):
            found.append((entry_id, title, folder_name))
    return found


def named_parts(file_name: str) -> tuple[str, str]:
    """(song, artist) out of "Song - Artist.fvchart", or ("", "") if it is not named that way."""
    stem = file_name[:-len(".fvchart")] if file_name.lower().endswith(".fvchart") else file_name
    song, sep, artist = stem.rpartition(" - ")
    return (song.strip(), artist.strip()) if sep and song.strip() and artist.strip() else ("", "")


def layout_warning(file_name: str, folder_name: str) -> str:
    song, artist = named_parts(file_name)
    if not song:
        return f'named "{file_name}", expected "Song - Artist.fvchart"'
    if folder_name and artist.casefold() != folder_name.casefold():
        return f'sits in folder "{folder_name}", expected an artist folder named "{artist}"'
    return ""


# ---------------------------------------------------------------- manifest

COLOR_TAG = re.compile(r"<color=(#[0-9a-fA-F]{6})[0-9a-fA-F]{0,2}>", re.I)
ANY_TAG = re.compile(r"<[^>]+>")


def plain_charter(rich: str) -> tuple[str, str]:
    """The charter's name without TextMeshPro tags, and its first colour if any."""
    colour = COLOR_TAG.search(rich or "")
    return ANY_TAG.sub("", rich or "").strip(), colour.group(1).upper() if colour else ""


def year_of(text) -> int | None:
    digits = "".join(ch for ch in str(text or "") if ch.isdigit())[:4]
    if len(digits) != 4:
        return None
    year = int(digits)
    return year if 1900 <= year <= datetime.now(timezone.utc).year + 1 else None


def save_cover(file_id: str, data: bytes) -> str:
    try:
        from PIL import Image
    except ImportError:
        print("  Pillow is not installed; covers are skipped (pip install pillow)")
        return ""
    COVERS.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(data)) as img:
        img = img.convert("RGB")
        img.thumbnail((COVER_PX, COVER_PX), Image.LANCZOS)
        img.save(COVERS / f"{file_id}.jpg", "JPEG", quality=84, optimize=True, progressive=True)
    return file_id


def open_chart(file_id: str, file_name: str, fallback_charter: str) -> list:
    chart = RemoteChart(file_id)
    entries = central_directory(chart)
    manifests = [e for e in entries if e["name"].lower().endswith(".json") and "/" not in e["name"]]
    if not manifests:
        raise ValueError("no manifest at the archive root")
    manifest = json.loads(read_entry(chart, manifests[0]).decode("utf-8-sig"))
    if manifest.get("format") != "fvchart":
        raise ValueError("manifest does not name the fvchart format")

    song = manifest.get("song") or {}
    counts = manifest.get("counts") or {}
    charter, colour = plain_charter(song.get("charter") or "")

    art = ""
    cover_name = (manifest.get("art") or {}).get("cover")
    cover = next((e for e in entries if e["name"] == cover_name), None) if cover_name else None
    if cover:
        try:
            art = save_cover(file_id, read_entry(chart, cover))
        except Exception as e:                                   # noqa: BLE001
            print(f"  cover unreadable: {e}")

    named_song, named_artist = named_parts(file_name)
    return [
        file_id,
        (song.get("title") or "").strip() or named_song or Path(file_name).stem,
        (song.get("artist") or "").strip() or named_artist,
        (song.get("album") or "").strip(),
        charter or fallback_charter,
        (song.get("genre") or "").strip(),
        year_of(song.get("year")),
        round(float(song.get("duration") or 0)),
        art,
        (manifest.get("exportedAt") or "")[:10],
        chart.size,
        int(counts.get("notes") or 0),
        colour,
        chart.file_name or file_name,
    ]


# ---------------------------------------------------------------- index

def previous_rows() -> dict[str, list]:
    if not OUT.exists():
        return {}
    text = OUT.read_text(encoding="utf-8")
    start = text.find("{", text.find("window.FV_COMMUNITY_CHARTS"))
    try:
        index = json.loads(text[start:text.rstrip().rstrip(";").rfind("}") + 1])
    except ValueError:
        return {}
    cols = index.get("cols") or []
    if cols != COLS:
        return {}
    return {row[0]: row for row in index.get("rows") or []}


def collect(fresh: bool) -> list[list]:
    sources = json.loads(SOURCES.read_text(encoding="utf-8")).get("sources") or []
    known = {} if fresh else previous_rows()
    rows: list[list] = []
    seen: set[str] = set()

    for source in sources:
        url, fallback = source.get("url", ""), source.get("charter", "")
        try:
            kind, the_id = drive_id(url)
            files = list_folder(the_id) if kind == "folder" else [(the_id, "", "")]
        except (ValueError, urllib.error.URLError) as e:
            print(f"! {fallback or url}: {e}")
            continue
        print(f"{fallback or url}: {len(files)} chart(s)")

        for file_id, name, folder_name in files:
            if file_id in seen:
                continue
            seen.add(file_id)
            warning = layout_warning(name, folder_name) if name else ""
            if warning:
                print(f"  ~ {name}: {warning} (listed anyway, from its manifest)")
            try:
                old = known.get(file_id)
                if old:
                    size = RemoteChart(file_id).size
                    if size == old[COLS.index("size")]:
                        rows.append(old)
                        print(f"  = {old[1]} - {old[2]}")
                        continue
                row = open_chart(file_id, name, fallback)
                rows.append(row)
                print(f"  + {row[1]} - {row[2]}  ({row[10] / 1048576:.0f} MB, {row[11]} notes)")
            except (ValueError, urllib.error.URLError, zlib.error) as e:
                print(f"  ! {name or file_id}: {e}")
    return rows


def prune_covers(rows: list[list]) -> None:
    keep = {row[COLS.index("art")] for row in rows}
    for path in COVERS.glob("*.jpg") if COVERS.exists() else []:
        if path.stem not in keep:
            path.unlink()


def write(rows: list[list]) -> None:
    rows.sort(key=lambda r: (r[2].lower(), r[1].lower()))
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    header = f'''/* ============================================================
   FULLVOLUME - Marketplace index: community .fvchart files.

   {len(rows):,} charts from the charters' own Google Drive folders
   (tools/fvchart-sources.json), collected {stamp} by
   tools/collect-fvchart.py. Re-run it to refresh.

   Charts download from drive.usercontent.google.com; covers are
   data/fvcovers/<id>.jpg, cut out of each chart by the script.
   ============================================================ */
window.FV_COMMUNITY_CHARTS = {{
  "generated": "{stamp}",
  "source": "drive",
  "count": {len(rows)},
  "cols": {json.dumps(COLS)},
  "rows": [
'''
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    OUT.write_text(header + body + "\n]\n};\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}  {len(rows):,} charts")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fresh", action="store_true", help="reopen every chart instead of reusing the old index")
    args = ap.parse_args()

    rows = collect(args.fresh)
    if not rows and OUT.exists():
        print("nothing collected; leaving the existing file alone")
        return 1
    write(rows)
    prune_covers(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
