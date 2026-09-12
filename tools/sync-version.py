#!/usr/bin/env python3
"""Copy the version out of README.md and into the site.

README.md is where the version actually gets updated, so it is the source of
truth and nothing here ever writes back to it. The site carries the same number
in five places and had drifted two releases behind before this existed.

The installer size is handled the same way and for the same reason, except it
comes from the latest GitHub release rather than the README, because that is the
only place it is recorded. That half is best effort: if the API is unreachable
the version still syncs.

    python tools/sync-version.py            # rewrite the site
    python tools/sync-version.py --check    # report drift, change nothing, exit 1

Every pattern below is expected to match exactly once. A pattern that stops
matching means the markup moved, and that is an error rather than a silent
no-op, because a silent no-op is how it went stale the first time.
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
MARKET = ROOT / "docs" / "Marketplace" / "index.html"
SITEMAP = ROOT / "docs" / "sitemap.xml"

RELEASES_API = "https://api.github.com/repos/iamjrmh/FullVolumeTheGame/releases/latest"
INSTALLER = "FullVolumeSetup.exe"


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


def read_readme_version() -> tuple[str, str]:
    """Pull "0.9.2" and "beta" out of README.md.

    The shields badge near the top is the source of truth. The spec table near
    the bottom carries the same number, so it is read as a cross-check: if the
    two disagree, the README itself was half updated and syncing either one to
    the site would just spread the mistake.
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

    return version, channel


def fetch_installer_size() -> str | None:
    """Size of the installer on the latest release, as "107 MB". None if unknown."""
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
        print(f"  installer size: skipped, could not reach the releases API ({err})")
        return None

    for asset in data.get("assets", []):
        if asset.get("name") == INSTALLER:
            return f"{round(asset['size'] / 1024 / 1024)} MB"

    print(f"  installer size: skipped, no {INSTALLER} on {data.get('tag_name')}")
    return None


def build_rules(version: str, channel: str, size: str | None):
    """(file, what, pattern, replacement). Each must match exactly once."""
    labelled = f"{version} {channel}".strip()

    rules = [
        (INDEX, "JSON-LD softwareVersion",
         r'("softwareVersion":\s*")\d+\.\d+\.\d+(")',
         rf"\g<1>{version}\g<2>"),

        (INDEX, "hero eyebrow",
         r"(Windows &middot; v)\d+\.\d+\.\d+(?:\s+\w+)?( &middot; free)",
         rf"\g<1>{labelled}\g<2>" if channel else rf"\g<1>{version}\g<2>"),

        (INDEX, "download receipt version",
         r"(<dt>Version</dt><dd>)\d+\.\d+\.\d+(?:\s+\w+)?(</dd>)",
         rf"\g<1>{labelled}\g<2>"),

        (INDEX, "homepage footer",
         r"(<p>v)\d+\.\d+\.\d+( &middot; )\w+(</p>)",
         rf"\g<1>{version}\g<2>{channel or 'beta'}\g<3>"),

        (MARKET, "marketplace footer",
         r"(<p>v)\d+\.\d+\.\d+( &middot; )\w+(</p>)",
         rf"\g<1>{version}\g<2>{channel or 'beta'}\g<3>"),
    ]

    if size:
        rules += [
            (INDEX, "JSON-LD fileSize",
             r'("fileSize":\s*")[^"]*(")',
             rf"\g<1>{size}\g<2>"),

            (INDEX, "download receipt size",
             r"(<dt>Size</dt><dd>)[^<]*(</dd>)",
             rf"\g<1>{size}\g<2>"),
        ]

    return rules


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="report drift without writing, and exit 1 if any is found")
    ap.add_argument("--no-size", action="store_true",
                    help="sync the version only, skipping the releases API")
    args = ap.parse_args()

    version, channel = read_readme_version()
    print(f"README says v{version}{' ' + channel if channel else ''}")

    size = None if args.no_size else fetch_installer_size()
    if size:
        print(f"Latest release ships {INSTALLER} at {size}")

    pending: dict[Path, str] = {}
    changes: list[str] = []

    for path, what, pattern, repl in build_rules(version, channel, size):
        text = pending.get(path) or read(path)
        new, n = re.subn(pattern, repl, text)
        if n != 1:
            rel = path.relative_to(ROOT).as_posix()
            sys.exit(
                f"{rel}: expected exactly one '{what}', matched {n}.\n"
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
