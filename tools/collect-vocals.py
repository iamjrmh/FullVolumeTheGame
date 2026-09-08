"""Build the Marketplace's index of every vocal chart on Chorus Encore.

Same catalogue CHSuite's song manager downloads from (``api.enchor.us``), but
through the *advanced* endpoint, which is the one that can filter on vocals:

    POST https://api.enchor.us/search/advanced   {"hasVocals": true, ...}

That is the request behind enchor.us/?hasVocals=true, and it is the whole
reason this page can exist - the plain ``/search`` endpoint silently drops
``hasVocals`` and has no vocals filter at all (its ``instrument`` enum is fret
instruments only), so the alternative would be reading all ~95k charts and
guessing from ``diff_vocals``.

Roughly 10.6k of the catalogue's charts have a vocals track. That is small
enough to ship whole, so the page searches locally and instantly instead of
putting a rate-limited API between a visitor and every keystroke. Re-run this
to refresh it.

Output is ``data/vocals.js``:

  * a script, not JSON, so the page still fills in when it is opened straight
    off disk, where fetch() is blocked
  * rows are arrays, not objects, in the order named by ``cols`` - repeating
    eleven key names across ten thousand rows costs about a megabyte for
    nothing

Usage:
    python tools/collect-vocals.py            # the lot
    python tools/collect-vocals.py --pages 2  # a quick sample while developing
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_URL = "https://api.enchor.us/search/advanced"
PER_PAGE = 250                    # the API's hard cap; more is a 400
SAFETY_MARGIN = 3                 # pause before the last few requests are gone
UA = "FullVolumeMarketplace/0.9 (fullvolumethegame.xyz)"

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "docs"          # the published site; Netlify's base directory
OUT = SITE / "data" / "vocals.js"

# Column order for a row. Mirrored in js/marketplace.js - change both together.
COLS = ["id", "title", "artist", "album", "charter", "genre",
        "year", "length", "diff", "art", "lyrics", "added"]


def post(payload: dict) -> tuple[dict, dict]:
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8")), dict(r.headers)


def throttle(headers: dict) -> None:
    """Wait only when the server says we are nearly out, using its own numbers
    rather than a guessed sleep between every request."""
    try:
        remaining = int(headers.get("X-Ratelimit-Remaining", "99"))
        reset = float(headers.get("X-Ratelimit-Reset", "0"))
    except ValueError:
        return
    if remaining > SAFETY_MARGIN:
        return
    wait = max(reset - time.time(), 0) + 1
    print(f"  rate limit reached, waiting {wait:.0f}s", flush=True)
    time.sleep(min(wait, 90))


def year_of(row: dict):
    """Chorus's year is free text a charter typed, so it holds everything from
    "1975" to "1975-08-01" to "2619". Anything outside a plausible range is a
    typo, and a typo left in sorts to the top of "newest release"."""
    digits = "".join(ch for ch in str(row.get("year") or "") if ch.isdigit())[:4]
    if len(digits) != 4:
        return None
    year = int(digits)
    return year if 1900 <= year <= datetime.now(timezone.utc).year + 1 else None


def to_row(row: dict) -> list:
    notes = row.get("notesData") or {}
    ms = row.get("song_length") or 0
    return [
        row.get("md5") or "",
        (row.get("name") or "").strip(),
        (row.get("artist") or "").strip(),
        (row.get("album") or "").strip(),
        (row.get("charter") or "").strip(),
        (row.get("genre") or "").strip(),
        year_of(row),
        round(ms / 1000) if ms else 0,
        row.get("diff_vocals", -1),
        row.get("albumArtMd5") or "",
        1 if notes.get("hasLyrics") else 0,
        (row.get("modifiedTime") or "")[:10],
    ]


def collect(max_pages: int | None) -> tuple[list, int]:
    rows: list[list] = []
    seen: set[str] = set()
    total = 0
    page = 1

    while True:
        payload = {
            "hasVocals": True,
            "page": page,
            "per_page": PER_PAGE,
            # A stable ordering matters more than which one: the set is walked
            # page by page, and a shifting sort would skip and repeat rows.
            "sort": {"type": "name", "direction": "asc"},
            "source": "website",
        }

        for attempt in range(4):
            try:
                body, headers = post(payload)
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = float(e.headers.get("Retry-After") or 20)
                    print(f"  429 on page {page}, waiting {wait:.0f}s", flush=True)
                    time.sleep(min(wait, 90))
                    continue
                print(f"  HTTP {e.code} on page {page}: {e.reason}", flush=True)
                time.sleep(3 * (attempt + 1))
            except Exception as e:                       # noqa: BLE001
                print(f"  {type(e).__name__} on page {page}: {e}", flush=True)
                time.sleep(3 * (attempt + 1))
        else:
            print(f"  giving up on page {page}", flush=True)
            break

        data = body.get("data") or []
        total = body.get("found", total)
        if not data:
            break

        for item in data:
            md5 = item.get("md5")
            if not md5 or md5 in seen:
                continue
            seen.add(md5)
            rows.append(to_row(item))

        pages = -(-total // PER_PAGE) if total else page
        print(f"page {page}/{pages}  vocal charts {len(rows):>6}", flush=True)

        if max_pages and page >= max_pages:
            break
        if page * PER_PAGE >= total:
            break

        throttle(headers)
        page += 1

    return rows, total


def write(rows: list, total: int) -> None:
    rows.sort(key=lambda r: (r[2].lower(), r[1].lower()))     # artist, then title
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    header = f'''/* ============================================================
   FULL VOLUME - Marketplace index: vocal charts only.

   {len(rows):,} charts, every one of them with a vocals track,
   collected {stamp} from Chorus Encore
   (POST api.enchor.us/search/advanced, hasVocals: true) by
   tools/collect-vocals.py. Re-run it to refresh.

   A script rather than JSON so the page also works opened
   straight off disk, where fetch() is blocked. Rows are arrays
   in "cols" order to keep the file a third of the size.

   Charts download from files.enchor.us/<id>.sng, album art
   comes from files.enchor.us/<art>.jpg.
   ============================================================ */
window.FV_VOCAL_CHARTS = {{
  "generated": "{stamp}",
  "source": "enchor",
  "count": {len(rows)},
  "found": {total},
  "cols": {json.dumps(COLS)},
  "rows": [
'''
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    OUT.write_text(header + body + "\n]\n};\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}  {len(rows):,} charts  ({OUT.stat().st_size / 1024:.0f} KB)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pages", type=int, default=0, help="stop after N pages (0 = all of them)")
    args = ap.parse_args()

    started = time.time()
    rows, total = collect(args.pages or None)
    if not rows:
        print("nothing collected; leaving the existing file alone")
        return 1
    write(rows, total)
    print(f"took {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
