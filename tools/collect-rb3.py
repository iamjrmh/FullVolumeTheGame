"""Build the Marketplace's index of Rock Band 3 customs that have vocals.

Source is Rhythmverse, through the endpoint its own browse page uses:

    POST https://rhythmverse.co/api/rb3xbox/songfiles/list/
    data_type=full&page=N&records=250&instrument=vocals

``rb3xbox`` is the Xbox CON format - the .rb3con files FullVolume reads -
and ``instrument=vocals`` is a real server-side filter, which takes the
46.8k charts in that section down to about 37k.

Two things this has to do that the Chorus collector does not:

  * **Skip what cannot be downloaded.** A chunk of the catalogue is official
    DLC whose only link is an Xbox store page (marketplace.xbox.com,
    store.xbox.com, harmonixmusic.com). Those are catalogue entries, not
    files, and listing them would be listing dead buttons. Everything else -
    hosted by Rhythmverse, or on Drive/Dropbox/MediaFire behind their
    download page - stays.
  * **Go gently.** There is no published rate limit and no CORS header, and
    an unknown filter parameter faults their PHP outright, so this sends one
    request at a time with a pause between them and never invents parameters.

Because there is no CORS header, a browser on another domain cannot call
that API at all - which is the other reason this is a build step rather than
a live query.

Output is ``data/rb3.js``, the same shape as data/vocals.js: a script, with
rows as arrays in ``cols`` order.

Usage:
    python tools/collect-rb3.py             # the lot, about 3 minutes
    python tools/collect-rb3.py --pages 3   # a sample while developing
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_URL = "https://rhythmverse.co/api/rb3xbox/songfiles/list/"
DOWNLOAD_BASE = "https://rhythmverse.co/download/"
PER_PAGE = 250
PAUSE = 1.2                       # seconds between requests, deliberately polite
UA = "FullVolumeMarketplace/0.9 (fullvolumethegame.xyz)"

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "docs"          # the published site; Netlify's base directory
OUT = SITE / "data" / "rb3.js"

# Column order for a row. Mirrored in js/marketplace.js - change both together.
COLS = ["id", "title", "artist", "album", "charter", "genre",
        "year", "length", "parts", "art", "downloads", "added"]

# A link to one of these is a shop, not a chart.
STORE_HOSTS = ("marketplace.xbox.com", "store.xbox.com", "www.harmonixmusic.com",
               "harmonixmusic.com", "www.xbox.com", "store.playstation.com")

ART_PREFIX = "/assets/album_art/"


def post(page: int) -> dict:
    body = urllib.parse.urlencode({
        "data_type": "full",
        "page": page,
        "records": PER_PAGE,
        "instrument": "vocals",
    }).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": UA,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def downloadable(file: dict) -> bool:
    """True when the download page leads to a file rather than a shop."""
    if not file.get("download_page_url"):
        return False
    url = str(file.get("download_url") or file.get("external_url") or "")
    if not url:
        return True                      # hosted by Rhythmverse itself
    host = urllib.parse.urlparse(url).netloc.lower()
    return host not in STORE_HOSTS


def year_of(file: dict, data: dict):
    raw = file.get("file_year") or data.get("year") or 0
    try:
        year = int(str(raw)[:4])
    except (TypeError, ValueError):
        return None
    return year if 1900 <= year <= datetime.now(timezone.utc).year + 1 else None


def art_of(file: dict, data: dict) -> str:
    """Two art paths come back per row and only one of them tends to exist.

    The file-level one (/assets/album_art/source_harmonix/<file id>.png) is
    missing for most rows - their own server logs "Failed to open stream" and
    the site quietly falls back to a placeholder. The song-level one
    (/assets/album_art/b/buffalo-soldier-4927.png) is the real cover. Prefer
    it, and store only the part after the shared prefix."""
    for art in (str(data.get("album_art") or ""), str(file.get("album_art") or "")):
        if art.startswith(ART_PREFIX):
            return art[len(ART_PREFIX):]
        if art:
            return art                    # anything unusual is kept whole
    return ""


def to_row(song: dict) -> list | None:
    file = song.get("file") or {}
    data = song.get("data") or {}
    file_id = str(file.get("file_id") or "")
    if not file_id or not downloadable(file):
        return None

    author = (file.get("author") or {}).get("name") or ""
    length = file.get("file_song_length") or data.get("song_length") or 0
    parts = data.get("vocal_parts")
    genre = file.get("file_genre") or data.get("genre") or ""
    if genre in ("None", None):
        genre = ""

    try:
        downloads = int(file.get("downloads") or 0)
    except (TypeError, ValueError):
        downloads = 0

    return [
        file_id,
        (file.get("file_title") or data.get("title") or "").strip(),
        (file.get("file_artist") or data.get("artist") or "").strip(),
        (file.get("file_album") or data.get("album") or "").strip(),
        str(author).strip(),
        str(genre).strip(),
        year_of(file, data),
        int(length or 0),
        int(parts) if str(parts).isdigit() else 0,
        art_of(file, data),
        downloads,
        str(file.get("update_date") or file.get("release_date") or "")[:10],
    ]


def collect(max_pages: int | None) -> tuple[list, int, int]:
    rows: list[list] = []
    seen: set[str] = set()
    total = 0
    scanned = 0
    page = 1

    while True:
        payload = None
        for attempt in range(4):
            try:
                payload = post(page)
                break
            except urllib.error.HTTPError as e:
                print(f"  HTTP {e.code} on page {page}", flush=True)
                time.sleep(4 * (attempt + 1))
            except Exception as e:                       # noqa: BLE001
                print(f"  {type(e).__name__} on page {page}: {e}", flush=True)
                time.sleep(4 * (attempt + 1))
        if payload is None:
            print(f"  giving up on page {page}", flush=True)
            break

        if payload.get("status") != "success":
            print(f"  page {page} came back {payload.get('status')}", flush=True)
            break

        data = payload.get("data") or {}
        songs = data.get("songs") or []
        total = (data.get("records") or {}).get("total_filtered", total)
        if not songs:
            break

        for song in songs:
            scanned += 1
            row = to_row(song)
            if not row or row[0] in seen:
                continue
            seen.add(row[0])
            rows.append(row)

        pages = -(-total // PER_PAGE) if total else page
        print(f"page {page}/{pages}  scanned {scanned:>6}  kept {len(rows):>6}", flush=True)

        if max_pages and page >= max_pages:
            break
        if scanned >= total:
            break

        time.sleep(PAUSE)
        page += 1

    return rows, total, scanned


def write(rows: list, total: int, scanned: int) -> None:
    rows.sort(key=lambda r: (r[2].lower(), r[1].lower()))     # artist, then title
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    header = f'''/* ============================================================
   FULLVOLUME - Marketplace index: Rock Band 3 customs (.rb3con).

   {len(rows):,} charts with vocals, of the {scanned:,} scanned,
   collected {stamp} from Rhythmverse
   (POST rhythmverse.co/api/rb3xbox/songfiles/list/, instrument=
   vocals) by tools/collect-rb3.py. Re-run it to refresh.

   Entries whose only link is an Xbox store page are left out -
   they are catalogue records, not files.

   Charts download through rhythmverse.co/download/<id>, which
   handles the ones parked on Drive, Dropbox or MediaFire. Art is
   rhythmverse.co/assets/album_art/<art>.
   ============================================================ */
window.FV_RB3_CHARTS = {{
  "generated": "{stamp}",
  "source": "rhythmverse",
  "count": {len(rows)},
  "scanned": {scanned},
  "found": {total},
  "cols": {json.dumps(COLS)},
  "rows": [
'''
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    OUT.write_text(header + body + "\n]\n};\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}  {len(rows):,} charts  ({OUT.stat().st_size / 1024 / 1024:.1f} MB)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pages", type=int, default=0, help="stop after N pages (0 = all of them)")
    args = ap.parse_args()

    started = time.time()
    rows, total, scanned = collect(args.pages or None)
    if not rows:
        print("nothing collected; leaving the existing file alone")
        return 1
    write(rows, total, scanned)
    print(f"took {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
