"""Give the Rhythmverse rows album covers, borrowed from Chorus Encore.

Rhythmverse's own artwork mostly is not there. Both paths it hands out -
`/assets/album_art/<uploader>/<file id>.png` (what their site itself renders)
and `/assets/album_art/<letter>/<slug>.png` - answer 200 with a PHP warning
and no image for the large majority of rows, and their own page falls back to
a placeholder for exactly the same songs. So there is nothing to fix on their
side; the covers do not exist to be fetched.

Covers therefore come from two other places, in order:

1. **Chorus Encore.** Sweep its whole catalogue once (not just the vocal
   charts - a guitar-only chart of a song still carries the right cover) and
   keep artist+title -> album-art md5. Both scenes chart the same songs, so
   this covers about a third of the Rock Band rows outright, from a host the
   page already loads .sng covers from.

2. **Deezer** for everything left. The two scenes only overlap so far -
   Chorus simply has never charted two thirds of these songs - and Deezer is
   a music catalogue rather than a charting one, so it has nearly all of
   them. Looked up once per song rather than once per chart, since the same
   song is often charted by several people.

Both are build caches (tools/cover-map.json, tools/deezer-cache.json), not
shipped. What ships is one short string in the row's art column: `ch:<md5>`
rendered from files.enchor.us, or `dz:<md5>` from Deezer's image CDN.

Usage:
    python tools/fill-covers.py              # build caches if missing, then patch
    python tools/fill-covers.py --refresh    # re-sweep Chorus first
    python tools/fill-covers.py --no-deezer  # Chorus only, no second pass
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API_URL = "https://api.enchor.us/search"
DEEZER_URL = "https://api.deezer.com/search"
# Deezer allows 50 requests per 5 seconds. Sequentially that limit is
# unreachable - each lookup spends a quarter of a second on the wire and
# nothing else - so they go out in small batches with a pause between, which
# lands around 7/s: fast enough to finish, still inside their limit.
DEEZER_BATCH = 6
DEEZER_PAUSE = 0.35
PER_PAGE = 250
SAFETY_MARGIN = 3
UA = "FullVolumeMarketplace/0.9 (fullvolumethegame.xyz)"

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "docs"          # the published site; Netlify's base directory
MAP = ROOT / "tools" / "cover-map.json"    # a build cache, deliberately outside it
DEEZER_CACHE = ROOT / "tools" / "deezer-cache.json"
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


PAREN = re.compile(r"[\(\[\{].*?[\)\]\}]")


def song_key(artist: str, title: str) -> str:
    """Rock Band titles carry annotations a music catalogue has never heard of
    ("A To Z 2 (2x Bass Pedal)"), so they come off before asking."""
    clean = " ".join(PAREN.sub(" ", str(title or "")).split())
    return f"{' '.join(str(artist or '').split())}|{clean}"


def deezer_cover(artist: str, title: str) -> str:
    """The album-art md5 for one song, or "" if Deezer does not have it."""
    query = f'artist:"{artist}" track:"{title}"'
    url = DEEZER_URL + "?limit=1&q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        body = json.loads(r.read().decode("utf-8"))

    if body.get("error"):
        raise RuntimeError(str(body["error"])[:80])
    data = body.get("data") or []
    if not data:
        return ""
    cover = ((data[0].get("album") or {}).get("cover_medium") or "")
    # https://e-cdns-images.dzcdn.net/images/cover/<md5>/250x250-....jpg
    parts = [p for p in cover.split("/") if len(p) == 32 and all(c in "0123456789abcdef" for c in p)]
    return parts[0] if parts else ""


def fill_from_deezer(rows: list) -> int:
    """One lookup per song, not per chart, cached across runs."""
    cache = json.loads(DEEZER_CACHE.read_text(encoding="utf-8")) if DEEZER_CACHE.exists() else {}

    wanted = []
    for row in rows:
        if str(row[ART_COLUMN]).startswith("ch:"):
            continue
        k = song_key(row[ARTIST_COLUMN], row[TITLE_COLUMN])
        if k not in cache:
            wanted.append(k)
    wanted = list(dict.fromkeys(wanted))

    if wanted:
        per_second = DEEZER_BATCH / (DEEZER_PAUSE + 0.45)
        print(f"asking Deezer about {len(wanted):,} songs "
              f"({len(cache):,} already cached), roughly "
              f"{len(wanted) / per_second / 60:.0f} min", flush=True)

    def look_up(k: str):
        """Returns (key, cover) - or (key, None) for a failure, which is left
        out of the cache rather than stored as a miss."""
        artist, _, title = k.partition("|")
        try:
            return k, deezer_cover(artist, title)
        except Exception:                                 # noqa: BLE001
            return k, None

    done = 0
    failures = 0
    with ThreadPoolExecutor(max_workers=DEEZER_BATCH) as pool:
        for start in range(0, len(wanted), DEEZER_BATCH):
            batch = wanted[start:start + DEEZER_BATCH]
            for k, cover in pool.map(look_up, batch):
                if cover is None:
                    failures += 1
                else:
                    cache[k] = cover
            done += len(batch)

            if done % 600 < DEEZER_BATCH:
                found = sum(1 for v in cache.values() if v)
                print(f"  {done:,}/{len(wanted):,}  found {found:,}"
                      + (f"  ({failures} failed)" if failures else ""), flush=True)
                DEEZER_CACHE.write_text(json.dumps(cache), encoding="utf-8")
            time.sleep(DEEZER_PAUSE)

    DEEZER_CACHE.write_text(json.dumps(cache), encoding="utf-8")
    if failures:
        print(f"  {failures:,} lookups failed and were not cached - re-run to retry them")

    filled = 0
    for row in rows:
        if str(row[ART_COLUMN]).startswith("ch:"):
            continue
        found = cache.get(song_key(row[ARTIST_COLUMN], row[TITLE_COLUMN]))
        if found:
            row[ART_COLUMN] = "dz:" + found
            filled += 1
    return filled


def load_index(path: Path) -> tuple[str, dict]:
    """The data files are scripts, so split the assignment from the JSON."""
    text = path.read_text(encoding="utf-8")
    start = text.index("{", text.index("window."))
    end = text.rindex("}") + 1
    return text[:start], json.loads(text[start:end])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="re-sweep Chorus even if the map exists")
    ap.add_argument("--no-deezer", action="store_true", help="skip the Deezer pass for what Chorus missed")
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

    from_deezer = 0 if args.no_deezer else fill_from_deezer(rows)

    index["rows"] = rows
    index["covers_from_chorus"] = filled
    index["covers_from_deezer"] = from_deezer

    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    head = json.dumps({k: v for k, v in index.items() if k != "rows"}, ensure_ascii=False, indent=2)
    head = head[:head.rindex("}")].rstrip().rstrip(",")
    RB3.write_text(prefix + head + ',\n  "rows": [\n' + body + "\n]\n};\n", encoding="utf-8")

    covered = filled + from_deezer
    pct = (covered / len(rows) * 100) if rows else 0
    print(f"\n{len(rows):,} rows: {filled:,} covers from Chorus, {from_deezer:,} from Deezer "
          f"- {covered:,} with artwork ({pct:.0f}%)")
    print(f"wrote {RB3.relative_to(ROOT)}  ({RB3.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
