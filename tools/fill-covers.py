"""Give the Rhythmverse rows album covers, borrowed from Chorus Encore.

Rhythmverse's own artwork mostly is not there. Both paths it hands out -
`/assets/album_art/<uploader>/<file id>.png` (what their site itself renders)
and `/assets/album_art/<letter>/<slug>.png` - answer 200 with a PHP warning
and no image for the large majority of rows, and their own page falls back to
a placeholder for exactly the same songs. So there is nothing to fix on their
side; the covers do not exist to be fetched.

Chorus Encore has artwork for nearly everything, and the two scenes chart the
same songs. So: sweep Chorus's whole catalogue once, keep artist+title ->
album-art md5, and hand each Rhythmverse row the cover of the same song. On a
sample this filled about two thirds to three quarters of them.

The map is a build cache (tools/cover-map.json, not shipped). What ships is a
`ch:<md5>` value in the row's art column, which the page renders from
files.enchor.us - the same host the .sng covers already come from.

Usage:
    python tools/fill-covers.py              # build the map if missing, then patch
    python tools/fill-covers.py --refresh    # re-sweep Chorus first
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.enchor.us/search"
PER_PAGE = 250
SAFETY_MARGIN = 3
UA = "FullVolumeMarketplace/0.9 (fullvolumethegame.xyz)"

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "docs"          # the published site; Netlify's base directory
MAP = ROOT / "tools" / "cover-map.json"    # a build cache, deliberately outside it
RB3 = SITE / "data" / "rb3.js"

# Column order written by collect-rb3.py.
ART_COLUMN = 9
TITLE_COLUMN = 1
ARTIST_COLUMN = 2


def key(artist: str, title: str) -> str:
    """Punctuation, case and spacing differ constantly between the two scenes
    ("Don't Stop Believin'" vs "Dont Stop Believin"), so the match key keeps
    only letters and digits."""
    def fold(s: str) -> str:
        return "".join(c for c in str(s or "").lower() if c.isalnum())
    return fold(artist) + "|" + fold(title)


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


def build_map() -> dict:
    """Every chart on Chorus, not just the ones with vocals - a guitar-only
    chart of a song still carries the right album cover."""
    covers: dict[str, str] = {}
    page = 1
    total = 0

    while True:
        payload = {
            "search": "",
            "page": page,
            "per_page": PER_PAGE,
            "instrument": None,
            "difficulty": None,
            "sort": {"type": "name", "direction": "asc"},
            "source": "bridge",
        }

        body = headers = None
        for attempt in range(4):
            try:
                body, headers = post(payload)
                break
            except urllib.error.HTTPError as e:
                wait = float(e.headers.get("Retry-After") or 8) if e.code == 429 else 4 * (attempt + 1)
                print(f"  HTTP {e.code} on page {page}, waiting {wait:.0f}s", flush=True)
                time.sleep(min(wait, 90))
            except Exception as e:                       # noqa: BLE001
                print(f"  {type(e).__name__} on page {page}: {e}", flush=True)
                time.sleep(4 * (attempt + 1))
        if body is None:
            print(f"  giving up on page {page}", flush=True)
            break

        rows = body.get("data") or []
        total = body.get("found", total)
        if not rows:
            break

        for row in rows:
            art = row.get("albumArtMd5")
            if not art:
                continue
            covers.setdefault(key(row.get("artist"), row.get("name")), art)

        pages = -(-total // PER_PAGE) if total else page
        if page % 20 == 0 or page == 1:
            print(f"page {page}/{pages}  covers {len(covers):>6}", flush=True)

        if page * PER_PAGE >= total:
            break
        throttle(headers)
        page += 1

    print(f"cover map: {len(covers):,} songs from {total:,} charts")
    return covers


def load_index(path: Path) -> tuple[str, dict]:
    """The data files are scripts, so split the assignment from the JSON."""
    text = path.read_text(encoding="utf-8")
    start = text.index("{", text.index("window."))
    end = text.rindex("}") + 1
    return text[:start], json.loads(text[start:end])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="re-sweep Chorus even if the map exists")
    args = ap.parse_args()

    if args.refresh or not MAP.exists():
        started = time.time()
        covers = build_map()
        if not covers:
            print("no covers collected; leaving everything alone")
            return 1
        MAP.write_text(json.dumps(covers), encoding="utf-8")
        print(f"wrote {MAP.relative_to(ROOT)} in {(time.time() - started) / 60:.1f} min")
    else:
        covers = json.loads(MAP.read_text(encoding="utf-8"))
        print(f"using {MAP.relative_to(ROOT)} ({len(covers):,} songs) - pass --refresh to rebuild")

    if not RB3.exists():
        print(f"{RB3} is not there yet - run tools/collect-rb3.py first")
        return 1

    prefix, index = load_index(RB3)
    rows = index.get("rows") or []
    filled = kept = missing = 0

    for row in rows:
        found = covers.get(key(row[ARTIST_COLUMN], row[TITLE_COLUMN]))
        if found:
            row[ART_COLUMN] = "ch:" + found
            filled += 1
        elif row[ART_COLUMN]:
            kept += 1                    # Rhythmverse's own path, such as it is
        else:
            missing += 1

    index["rows"] = rows
    index["covers_from_chorus"] = filled

    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    head = json.dumps({k: v for k, v in index.items() if k != "rows"}, ensure_ascii=False, indent=2)
    head = head[:head.rindex("}")].rstrip().rstrip(",")
    RB3.write_text(prefix + head + ',\n  "rows": [\n' + body + "\n]\n};\n", encoding="utf-8")

    pct = (filled / len(rows) * 100) if rows else 0
    print(f"\n{len(rows):,} rows: {filled:,} covers from Chorus ({pct:.0f}%), "
          f"{kept:,} left on Rhythmverse's own path, {missing:,} with none")
    print(f"wrote {RB3.relative_to(ROOT)}  ({RB3.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
