"""Tell a real change to the chart index from a new timestamp.

Both data files record the moment they were generated, so re-running a
collector always rewrites the file even when the catalogue has not moved an
inch. A weekly job that committed on any diff would therefore commit - and
redeploy - every single week, saying nothing.

So this fingerprints the rows on their own, ignoring the header. Run it before
a sweep to capture the state, and again afterwards with --against to compare:

    python tools/index-fingerprint.py > before.json
    ...collectors run...
    python tools/index-fingerprint.py --against before.json >> "$GITHUB_ENV"

The comparison writes `CHARTS_CHANGED` and `CHARTS_SUMMARY` to stdout in the
shape GitHub Actions reads for environment variables, puts anything meant for
a human on stderr, and exits 1 if either catalogue came back more than a tenth
short - which means a sweep was cut off, not that the scene shrank overnight.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

# file stem -> what to call it when a person reads the message
CATALOGUES = {"vocals": "Chorus", "rb3": "Rock Band"}

# Below this share of the previous row count, assume a cut-short sweep.
FLOOR = 0.9


def read_rows(stem: str) -> list:
    path = DATA / f"{stem}.js"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    start = text.index("{", text.index("window."))
    return json.loads(text[start:text.rindex("}") + 1]).get("rows") or []


def fingerprint() -> dict:
    out = {}
    for stem in CATALOGUES:
        rows = read_rows(stem)
        blob = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        out[stem] = {"count": len(rows), "hash": hashlib.sha256(blob).hexdigest()}
    return out


def compare(before: dict) -> int:
    after = fingerprint()
    changed = False
    short = False
    parts = []

    for stem, label in CATALOGUES.items():
        was = before.get(stem) or {"count": 0, "hash": ""}
        now = after[stem]
        delta = now["count"] - was["count"]

        print(f"{label}: {was['count']:,} -> {now['count']:,} ({delta:+,})", file=sys.stderr)

        if was["count"] and now["count"] < was["count"] * FLOOR:
            print(f"  {label} lost more than {round((1 - FLOOR) * 100)}% of its rows - "
                  "that is a cut-short sweep, not a change worth keeping", file=sys.stderr)
            short = True

        if now["hash"] == was["hash"]:
            continue

        changed = True
        if delta:
            parts.append(f"{label} {delta:+,}")
        else:
            # Same songs, different contents - a cover filled in, a title fixed
            # upstream. Worth shipping, but "+0" would read as nothing.
            parts.append(f"{label} updated")

    if short:
        return 1

    summary = ", ".join(parts) if parts else "no change"
    print(f"CHARTS_CHANGED={'true' if changed else 'false'}")
    print(f"CHARTS_SUMMARY={summary}")
    print(f"-> {summary}", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--against", metavar="FILE",
                    help="a fingerprint taken earlier; compare against it instead of printing one")
    args = ap.parse_args()

    if not args.against:
        print(json.dumps(fingerprint()))
        return 0

    return compare(json.loads(Path(args.against).read_text(encoding="utf-8")))


if __name__ == "__main__":
    sys.exit(main())
