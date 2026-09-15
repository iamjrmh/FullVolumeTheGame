#!/usr/bin/env python3
"""Copy the numbers the site quotes in from wherever they are actually true.

Three of them, each with a different source, because the site kept quoting
figures that had quietly stopped being right:

  versions       README.md, which is where they really get updated. FullVolume
                 and FullVolumeCharter carry their own numbers now - the game's
                 is the version badge, the charter's is the charter badge - and
                 they are in the pages' structured data, so stale means a wrong
                 machine-readable fact rather than just wrong text.
  installer sizes GitHub, the only place they are recorded. Each product's size
                 comes off the newest release carrying that product's
                 installer, which is no longer the same release for both.
  chart count    docs/data/*.js, counted off the rows the Marketplace loads.
                 The weekly refresh moves this, and the site said 5,000+ when
                 both catalogues together held 40,488.

Nothing here ever writes back to a source. The last two are best effort: if the
releases API is unreachable or the catalogues are missing, the version still
syncs.

    python tools/sync-version.py            # rewrite the site
    python tools/sync-version.py --check    # report drift, change nothing, exit 1

Every rule declares how many times it expects to match, and a rule that matches
a different number of times fails the run naming itself. That is deliberate: a
silent no-op is exactly how all three of these went stale in the first place.
Nothing is written until every rule has matched, so a failure cannot leave the
site half updated.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
INDEX = ROOT / "docs" / "index.html"
CHARTER = ROOT / "docs" / "fullvolumecharter" / "index.html"
SITEMAP = ROOT / "docs" / "sitemap.xml"
DOCS = ROOT / "docs"
DATA = ROOT / "docs" / "data"

# Deliberately the releases LIST, not /releases/latest. The game and the
# charter are released separately, so GitHub's "latest" is whichever of the two
# went out last and would have no installer for the other one on it. Same rule
# as netlify/lib/releasenotes.mjs and both updaters: find the newest release
# that actually carries the asset being asked about.
RELEASES_API = "https://api.github.com/repos/iamjrmh/FullVolumeTheGame/releases?per_page=100"
INSTALLER = "FullVolumeSetup.exe"
CHARTER_INSTALLER = "FullVolumeCharterSetup.exe"


def read(path: Path) -> str:
    """Read leaving line endings exactly as they are - the repo is CRLF.

    open(newline="") rather than Path.read_text(newline=""), which only grew
    that argument in 3.12.something; CI pins 3.12 and this has to work there.
    """
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def read_readme_version() -> tuple[str, str, str]:
    """Pull the game's "0.9.2"/"beta" and the charter's "0.9.4" out of README.md.

    The shields badges near the top are the source of truth. The spec tables
    near the bottom carry the same numbers, so they are read as a cross-check:
    if a pair disagrees, the README itself was half updated and syncing either
    one to the site would just spread the mistake.

    Two badges rather than one because the two products are versioned and
    released separately. They were the same number until 2026-09-14, which is
    why the charter badge was there all along - it just never said anything the
    version badge did not.
    """
    text = read(README)

    badge = re.search(r"badge/version-(\d+\.\d+\.\d+)(?:%20(\w+))?-", text)
    if not badge:
        sys.exit(
            "README.md: could not find the version badge.\n"
            "  Expected something like "
            "[![Version](https://img.shields.io/badge/version-0.9.2%20beta-ff6b6b)]"
        )
    version, channel = badge.group(1), (badge.group(2) or "").strip()

    table = re.search(r"\|\s*\*\*Version\*\*\s*\|\s*(\d+\.\d+\.\d+)(?:\s+(\w+))?\s*\|", text)
    if table:
        other = f"{table.group(1)} {(table.group(2) or '').strip()}".strip()
        mine = f"{version} {channel}".strip()
        if other != mine:
            sys.exit(
                f"README.md disagrees with itself: the badge says '{mine}' and the "
                f"spec table says '{other}'.\n"
                f"  Fix README.md first, then run this again."
            )

    charter_badge = re.search(r"badge/charter-(\d+\.\d+\.\d+)-", text)
    if not charter_badge:
        sys.exit(
            "README.md: could not find the charter badge.\n"
            "  Expected something like "
            "[![Charter](https://img.shields.io/badge/charter-0.9.4-829B87)]"
        )
    charter = charter_badge.group(1)

    charter_table = re.search(r"\|\s*\*\*Charter version\*\*\s*\|\s*(\d+\.\d+\.\d+)\s*\|", text)
    if charter_table and charter_table.group(1) != charter:
        sys.exit(
            f"README.md disagrees with itself: the charter badge says "
            f"'{charter}' and the charter table says '{charter_table.group(1)}'.\n"
            f"  Fix README.md first, then run this again."
        )

    return version, channel, charter


def fetch_installer_sizes() -> dict[str, str]:
    """Sizes of the two installers, as {name: "107 MB"}.

    Each one comes off the newest release that actually carries it, which since
    the split is not the same release for both, and is not necessarily the
    newest release either. A name that is nowhere is simply absent from the
    dict, and the rules that quote it are skipped rather than the run failing.
    """
    headers = {"Accept": "application/vnd.github+json"}
    # Unauthenticated the API allows 60 requests an hour per IP, and CI runners
    # share addresses, so use the workflow token when there is one.
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        req = urllib.request.Request(RELEASES_API, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        print(f"  installer sizes: skipped, could not reach the releases API ({err})")
        return {}

    if not isinstance(data, list):
        print("  installer sizes: skipped, the releases API did not return a list")
        return {}

    # Newest first by publication date, so the first release carrying an asset
    # is the one being handed out.
    releases = sorted(
        (r for r in data if not r.get("draft") and r.get("tag_name")),
        key=lambda r: str(r.get("published_at") or r.get("created_at") or ""),
        reverse=True,
    )

    sizes = {}
    for name in (INSTALLER, CHARTER_INSTALLER):
        for release in releases:
            asset = next((a for a in release.get("assets", []) if a.get("name") == name), None)
            if asset:
                sizes[name] = f"{round(asset['size'] / 1024 / 1024)} MB"
                print(f"  {name}: {sizes[name]}, off {release['tag_name']}")
                break
        else:
            print(f"  installer size: skipped, no {name} on any release")

    return sizes


def count_charts() -> int | None:
    """How many vocal charts the Marketplace is carrying, across both catalogues.

    Counted off the row arrays rather than the header comment, so it cannot
    disagree with what the page actually loads. None if the files are missing.
    """
    total = 0
    for path in (DATA / "vocals.js", DATA / "rb3.js"):
        if not path.exists():
            print(f"  chart count: skipped, {path.name} is missing")
            return None
        total += len(re.findall(r'^\s*\[".*\],?\s*$', read(path), re.M))
    return total


def headline_charts(total: int) -> tuple[int, str]:
    """Floor to the nearest thousand, so the trailing "+" is always true."""
    floored = total // 1000 * 1000
    return floored, f"{floored:,}"


def build_rules(version: str, channel: str, charter: str,
                sizes: dict[str, str], charts: int | None):
    """(file, what, pattern, replacement, expected matches).

    `version` is FullVolume's and `charter` is FullVolumeCharter's, and which
    of the two a rule carries is the whole point of this function since the
    split: the charter page quotes its own number for itself and the game's
    only where it names the game.
    """
    labelled = f"{version} {channel}".strip()

    rules = [
        (INDEX, "JSON-LD softwareVersion",
         r'("softwareVersion":\s*")\d+\.\d+\.\d+(")',
         rf"\g<1>{version}\g<2>", 1),

        (INDEX, "hero eyebrow",
         r"(Windows &middot; v)\d+\.\d+\.\d+(?:\s+\w+)?( &middot; free)",
         rf"\g<1>{labelled}\g<2>" if channel else rf"\g<1>{version}\g<2>", 1),

        (INDEX, "download receipt version",
         r"(<dt>Version</dt><dd>)\d+\.\d+\.\d+(?:\s+\w+)?(</dd>)",
         rf"\g<1>{labelled}\g<2>", 1),

        (INDEX, "homepage footer",
         r"(<p>v)\d+\.\d+\.\d+( &middot; )\w+(</p>)",
         rf"\g<1>{version}\g<2>{channel or 'beta'}\g<3>", 1),

        # The charter has its own release line as of 2026-09-14, so it quotes
        # its OWN number for itself and the game's only where it names the game
        # ("built for FullVolume x.y.z" - the version it was written against).
        # It still has no channel of its own: the charter is not separately
        # "beta" from the game it charts for.
        (CHARTER, "charter JSON-LD softwareVersion",
         r'("softwareVersion":\s*")\d+\.\d+\.\d+(")',
         rf"\g<1>{charter}\g<2>", 1),

        (CHARTER, "charter hero flag",
         r"(Built for FullVolume )\d+\.\d+\.\d+( &middot; <b>v)\d+\.\d+\.\d+(</b>)",
         rf"\g<1>{version}\g<2>{charter}\g<3>", 1),

        (CHARTER, "charter download lead",
         r"(Built for FullVolume )\d+\.\d+\.\d+\.",
         rf"\g<1>{version}.", 1),

        (CHARTER, "charter receipt version",
         r"(<dt>Version</dt><dd>)\d+\.\d+\.\d+(</dd>)",
         rf"\g<1>{charter}\g<2>", 1),

        (CHARTER, "charter receipt built for",
         r"(<dt>Built for</dt><dd>FullVolume )\d+\.\d+\.\d+(</dd>)",
         rf"\g<1>{version}\g<2>", 1),
    ]

    # Every other page carries the same footer, and there are more of them every
    # time a guide gets written, so find them rather than listing them. 404.html
    # is not in a folder of its own and so is not caught by the glob, but it
    # carries the same footer line and would quietly go stale without this.
    pages = sorted(DOCS.glob("*/index.html"))
    if (DOCS / "404.html").exists():
        pages.append(DOCS / "404.html")

    for page in pages:
        label = page.name if page.parent == DOCS else page.parent.name
        rules.append(
            (page, f"{label} footer",
             r"(<p>v)\d+\.\d+\.\d+( &middot; )\w+(</p>)",
             rf"\g<1>{version}\g<2>{channel or 'beta'}\g<3>", 1))

    if sizes.get(INSTALLER):
        rules += [
            (INDEX, "JSON-LD fileSize",
             r'("fileSize":\s*")[^"]*(")',
             rf"\g<1>{sizes[INSTALLER]}\g<2>", 1),

            (INDEX, "download receipt size",
             r"(<dt>Size</dt><dd>)[^<]*(</dd>)",
             rf"\g<1>{sizes[INSTALLER]}\g<2>", 1),
        ]

    if sizes.get(CHARTER_INSTALLER):
        rules.append(
            (CHARTER, "charter receipt size",
             r"(<dt>Size</dt><dd>)[^<]*(</dd>)",
             rf"\g<1>{sizes[CHARTER_INSTALLER]}\g<2>", 1))

    if charts:
        floored, pretty = headline_charts(charts)
        rules += [
            # The marquee track is duplicated so the loop has no seam, so this
            # one legitimately appears twice.
            (INDEX, "marquee chart count",
             r"(<b>)[\d,]+\+ SONGS WITH A PART TO SING(</b>)",
             rf"\g<1>{pretty}+ SONGS WITH A PART TO SING\g<2>", 2),

            (INDEX, "about stat chart count",
             r'(data-count=")\d+(" data-count-suffix="\+")',
             rf"\g<1>{floored}\g<2>", 1),
        ]

    return rules


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="report drift without writing, and exit 1 if any is found")
    ap.add_argument("--no-size", action="store_true",
                    help="sync the version only, skipping the releases API")
    args = ap.parse_args()

    version, channel, charter = read_readme_version()
    print(f"README says FullVolume v{version}{' ' + channel if channel else ''}, "
          f"FullVolumeCharter v{charter}")

    sizes = {} if args.no_size else fetch_installer_sizes()

    charts = count_charts()
    if charts:
        print(f"Marketplace carries {charts:,} vocal charts "
              f"(headline: {headline_charts(charts)[1]}+)")

    pending: dict[Path, str] = {}
    changes: list[str] = []

    for path, what, pattern, repl, expected in build_rules(version, channel, charter, sizes, charts):
        text = pending.get(path) or read(path)
        new, n = re.subn(pattern, repl, text)
        if n != expected:
            rel = path.relative_to(ROOT).as_posix()
            sys.exit(
                f"{rel}: expected {expected} x '{what}', matched {n}.\n"
                f"  The markup moved. Fix the pattern in tools/sync-version.py "
                f"rather than letting it silently go stale."
            )
        if new != text:
            changes.append(f"{path.relative_to(ROOT).as_posix()}: {what}")
        pending[path] = new

    # lastmod should say when the content actually changed, so it only moves
    # when something else did.
    if changes and SITEMAP.exists():
        text = read(SITEMAP)
        new = re.sub(r"<lastmod>\d{4}-\d{2}-\d{2}</lastmod>",
                     f"<lastmod>{date.today().isoformat()}</lastmod>", text)
        if new != text:
            pending[SITEMAP] = new
            changes.append("docs/sitemap.xml: lastmod")

    if not changes:
        print("Already in sync, nothing to do.")
        return 0

    print(f"\n{len(changes)} out of sync:")
    for c in changes:
        print(f"  {c}")

    if args.check:
        print("\n--check: nothing written.")
        return 1

    for path, text in pending.items():
        write(path, text)
    print("\nWritten.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
