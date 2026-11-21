// The release notes on GitHub, turned into something a page can render.
//
// Every release body is the same document: a logo, a tagline, a hero shot, a
// "New in X.Y.Z" section, and then the product pitch repeated verbatim from the
// release before it. The changelog only wants the part that is actually new, so
// this reads the headings, drops every section that has appeared in an older
// release, and keeps the rest.
//
// One parser, two callers: /api/releases runs it live so a release published a
// minute ago is on the site a minute ago, and tools/bake-changelog.mjs runs it
// at build time to write docs/changelog/releases.js, which is what the page paints
// before the network has answered. Neither may drift from the other, which is
// why the parsing lives here and not in either of them.

export const REPO = "iamjrmh/FullVolumeTheGame";

const RELEASES_API = (repo, limit) =>
  `https://api.github.com/repos/${repo}/releases?per_page=${limit}`;

/* ============================================================
   TWO PRODUCTS, ONE REPOSITORY

   The game and the charter used to ship in the same release - one tag, two
   installers, the same number on both. They do not any more: each is released
   on its own, whenever it is ready, so FullVolume can have three releases
   between two of the charter's.

   That breaks /releases/latest, which is GitHub's newest release full stop.
   The moment a charter release is the newest one, the game's
   /releases/latest/download/FullVolumeSetup.exe is a 404 - and so is the
   game's update check. So nothing here ever asks for "latest". It reads the
   releases list and finds the newest release carrying the asset it wants.

   Which is also why the selector is the ASSET NAME and not the tag: it needs
   no flag day. The releases cut before the split carry both installers, so they
   still answer for both products, and the tag convention only has to be true of
   releases published from now on.

     game     FV-v0.9.5
     charter  FVC-v0.9.5
     both     v0.9.5      - a joint release, when the numbers happen to align

   The charter's number carries on from where the shared one stopped rather
   than restarting - going backwards would leave every installed 0.9.4 thinking
   it was already up to date.
   ============================================================ */

export const PRODUCTS = {
  game: { asset: "FullVolumeSetup.exe", label: "FullVolume", tag: /^FV[-_]?v?\d/i },
  charter: { asset: "FullVolumeCharterSetup.exe", label: "FullVolumeCharter", tag: /^FVC[-_]?v?\d/i },
};

/**
 * The game's other platforms, from 0.9.8. They ride on the game's own release
 * beside FullVolumeSetup.exe, and the in-game updater on each OS looks for
 * exactly these names (Core/Updater.cs MacPackageName / LinuxPackageName).
 */
export const PLATFORMS = {
  mac: { product: "game", asset: "FullVolume-macOS.zip", label: "FullVolume for Mac" },
  linux: { product: "game", asset: "FullVolume-Linux.tar.gz", label: "FullVolume for Linux" },
};

/** Installers, not the source zips GitHub attaches to every release itself. */
const INSTALLERS = [PRODUCTS.game.asset, PLATFORMS.mac.asset, PLATFORMS.linux.asset, PRODUCTS.charter.asset];

const ASSET_LABELS = {
  [PRODUCTS.game.asset]: "FullVolume",
  [PLATFORMS.mac.asset]: PLATFORMS.mac.label,
  [PLATFORMS.linux.asset]: PLATFORMS.linux.label,
  [PRODUCTS.charter.asset]: "FullVolumeCharter",
};

/**
 * The version a tag carries, whatever names the product in front of it:
 * "FVC-v0.9.5", "FV-v0.9.5" and "v0.9.5" all read 0.9.5. The prefixes hold no
 * digits, so the first number in the tag is the version. Empty when there is
 * none.
 */
export function versionOf(tag) {
  return (String(tag || "").match(/\d+\.\d+(?:\.\d+)?/) || [""])[0];
}

/**
 * Which products a release belongs to, as a list - a joint release is both.
 *
 * The tag decides where it says so. Where it does not - a plain v0.9.5, whether
 * that is a deliberate joint release or one cut before the split - the assets
 * do, which is the more truthful answer anyway: a release answers for the
 * product whose installer is actually attached to it.
 */
export function productsOf(raw) {
  const tag = raw.tag_name || "";

  // FVC before FV: "FVC-v0.9.5" starts with neither "FV-" nor "FV_", but a
  // looser game pattern would still be worth testing second.
  if (PRODUCTS.charter.tag.test(tag)) return ["charter"];
  if (PRODUCTS.game.tag.test(tag)) return ["game"];

  const names = (raw.assets || []).map((a) => a.name);
  const found = Object.keys(PRODUCTS).filter((p) => names.includes(PRODUCTS[p].asset));

  // A release with no installer at all is still the game's as far as the
  // changelog is concerned; it simply is not offered to anybody as a download.
  return found.length ? found : ["game"];
}

/**
 * The one product a release is presented as. A joint release reads as the
 * game's - it is the game's number the site quotes - and its asset row shows
 * both installers, so nothing about it is hidden by that.
 */
export function productOf(raw) {
  return productsOf(raw)[0];
}

/**
 * The newest release that can actually be installed as `product`, or null.
 *
 * Newest by publication date rather than by version number, so a hotfix
 * republished over an older tag is still the one handed out. Drafts are not
 * public and are skipped; prereleases are not, and are not.
 */
export function latestFor(rawReleases, product, assetName) {
  const known = PRODUCTS[product];
  if (!known) throw new Error(`No such product: ${product}`);
  // A platform build (the Mac zip, the Linux tarball) is the same product on
  // the same release, just a different file; the release still has to be the
  // product's by tag or by its main installer.
  const wanted = { ...known, asset: assetName || known.asset };

  const candidates = (rawReleases || [])
    .filter((r) => !r.draft && r.tag_name)
    // Both tests, and either one refusing is enough. The asset is what can
    // actually be delivered; the tag is what the release says it is, so a
    // release published with the wrong file attached still cannot be handed
    // out as the wrong product.
    .filter((r) => productsOf(r).includes(product))
    .filter((r) => (r.assets || []).some((a) => a.name === wanted.asset))
    .sort((a, b) => String(b.published_at || b.created_at).localeCompare(String(a.published_at || a.created_at)));

  const release = candidates[0];
  if (!release) return null;

  const asset = release.assets.find((a) => a.name === wanted.asset);

  return {
    product,
    tag: release.tag_name,
    version: versionOf(release.tag_name),
    name: release.name || release.tag_name,
    published: (release.published_at || release.created_at || "").slice(0, 10),
    page: release.html_url,
    asset: asset.name,
    url: asset.browser_download_url,
    bytes: asset.size || 0,
    downloads: asset.download_count || 0,
  };
}

/* ============================================================
   FETCH
   ============================================================ */

export async function fetchReleases({ token = "", repo = REPO, limit = 30 } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fullvolumethegame.xyz",
  };
  // Unauthenticated is 60 requests an hour per IP. That is plenty for a cached
  // endpoint, but CI runners share addresses, so use a token where there is one.
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(RELEASES_API(repo, limit), { headers });
  if (!res.ok) throw new Error(`GitHub releases API answered ${res.status} ${res.statusText}`);

  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error("GitHub releases API did not return a list");
  return raw;
}

/* ============================================================
   PARSING ONE BODY
   ============================================================ */

const EOL = (s) => String(s || "").replace(/\r\n?/g, "\n");

/** Leading emoji on a heading, split off so the page can place it itself. */
function splitEmoji(heading) {
  const m = heading.match(/^([\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}☀-➿][️‍\p{Extended_Pictographic}]*)\s+(.*)$/u);
  return m ? { emoji: m[1], title: m[2].trim() } : { emoji: "", title: heading.trim() };
}

/** Strip tags out of a run of HTML, leaving its text. */
const textOf = (html) =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Escape for HTML, but leave entities the author typed on purpose alone -
 * the notes use &nbsp; as a separator and double-escaping it prints the source.
 */
function escapeHtml(s) {
  return s
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The small slice of markdown the notes actually use: bold, italic, code and
 * links. Everything is escaped first, so a stray angle bracket in a note prints
 * rather than opening a tag.
 */
function inline(md) {
  let out = escapeHtml(md.replace(/\n/g, " ").replace(/\s+/g, " ").trim());

  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^https?:\/\//i.test(href) ? href : "#";
    const external = !safe.startsWith("https://fullvolumethegame.xyz");
    return `<a href="${safe}"${external ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`);
  out = out.replace(/(^|[\s(])\*([^*]+)\*/g, (_, pre, i) => `${pre}<em>${i}</em>`);

  return out;
}

/**
 * A paragraph that opens with a bold run and carries on is a change with a
 * headline: "**The needle stopped lying about you.** That was the game hearing
 * your voice an octave below..." A bold run that is only a link is a call to
 * action, not a headline, so it stays a paragraph.
 */
function asItem(para) {
  const m = para.match(/^\*\*([^*]+)\*\*\s*([\s\S]*)$/);
  if (!m) return null;

  const [, lead, rest] = m;
  if (lead.includes("](") || !rest.trim()) return null;

  return { type: "item", title: inline(lead).replace(/\.$/, ""), body: inline(rest) };
}

/** Split a section's markdown into paragraphs, lists, and an image if it has one. */
function parseBlocks(md) {
  let image = null;
  const fences = [];

  // A folded gallery of "More screens" is GitHub furniture, not release news.
  md = md.replace(/<details[\s\S]*?<\/details>/gi, "");

  // Code fences hold paths. Lift them out before anything else runs, so the
  // paragraph splitter and the inline pass never see their insides.
  md = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(code.replace(/\s+$/, ""));
    return `\n\n FENCE${fences.length - 1} \n\n`;
  });

  // Tables are the installer matrix, which the asset row already covers.
  md = md.replace(/^\|.*\|\s*$/gm, "");
  md = md.replace(/^>\s?/gm, "");

  // The centred <p> wrappers carry the screenshots. Keep the first image and
  // drop the markup; a raw <p align> in the middle of a card fights the layout.
  md = md.replace(/<p[^>]*>[\s\S]*?<\/p>/gi, (block) => {
    const img = block.match(/<img\s+[^>]*src="([^"]+)"[^>]*>/i);
    if (img && !image) {
      const alt = block.match(/alt="([^"]*)"/i);
      image = { src: img[1], alt: alt ? alt[1] : "" };
    }
    return img ? "" : `\n\n${textOf(block)}\n\n`;
  });

  md = md.replace(/^-{3,}\s*$/gm, "");

  const blocks = [];
  let list = null;

  for (const chunk of md.split(/\n{2,}/)) {
    const para = chunk.trim();
    if (!para) continue;

    const fence = para.match(/^ FENCE(\d+) $/);
    if (fence) {
      // Raw, not escaped: the page sets it as text, not markup.
      blocks.push({ type: "code", body: fences[Number(fence[1])] });
      continue;
    }

    // A bullet block: every line either opens a bullet or continues one.
    if (/^[-*]\s+/.test(para)) {
      const items = [];
      for (const line of para.split("\n")) {
        if (/^\s*[-*]\s+/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ""));
        else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
      }
      list = { type: "list", items: items.map(inline) };
      blocks.push(list);
      continue;
    }

    const item = asItem(para);
    blocks.push(item || { type: "text", body: inline(para) });
  }

  return { blocks, image };
}

/** Every "## " section of a body, in order, plus whatever came before the first. */
function splitSections(body) {
  const lines = EOL(body).split("\n");
  const sections = [];
  const preamble = [];
  let current = null;

  for (const line of lines) {
    const head = line.match(/^##\s+(.+?)\s*$/);
    if (head) {
      if (current) sections.push(current);
      current = { heading: head[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  return { preamble: preamble.join("\n"), sections };
}

/** The one-line pitch under the title, which differs release to release. */
function taglineOf(preamble) {
  for (const block of preamble.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []) {
    if (/<img/i.test(block)) continue;
    const text = textOf(block);
    if (text) return text;
  }
  return "";
}

/* ============================================================
   ONE RELEASE
   ============================================================ */

const FURNITURE = /^(download|it'?s a beta)$/i;

const SIZE = (bytes) =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;

function parseRelease(raw, seenPools, isOldest) {
  const tag = raw.tag_name || "";
  const products = productsOf(raw);
  const product = products[0];
  const version = versionOf(tag);
  const channel = (raw.name || "").match(/\b(beta|alpha|rc)\b/i)?.[1]?.toLowerCase() || "";

  // Judged against the first pool it belongs to; every pool is told afterwards.
  const seenHeadings = seenPools[0];

  const { preamble, sections } = splitSections(raw.body || "");

  const kept = [];
  for (const section of sections) {
    const { emoji, title } = splitEmoji(section.heading);
    const isNews = /^new in\b/i.test(title);

    // The download table and the bug-report footer are on every release and
    // are covered by the asset row and the site itself.
    if (FURNITURE.test(title)) continue;

    // The pitch is repeated word for word in every release. Anything an older
    // release already said is not news, so the only sections that survive are
    // the "New in" one and whatever was written for this release alone. On the
    // very first release nothing is older than it, so everything it says is
    // what the game launched with, and the page presents it as exactly that.
    if (!isOldest && !isNews && seenHeadings.has(title.toLowerCase())) continue;

    const { blocks, image } = parseBlocks(section.lines.join("\n"));
    if (!blocks.length && !image) continue;

    kept.push({ kind: isNews ? "news" : "extra", emoji, title, image, blocks });
  }

  for (const section of sections) {
    const title = splitEmoji(section.heading).title.toLowerCase();
    for (const pool of seenPools) pool.add(title);
  }

  const assets = (raw.assets || [])
    .filter((a) => INSTALLERS.includes(a.name))
    // The game first, the charter after it, whatever order GitHub lists them.
    .sort((a, b) => INSTALLERS.indexOf(a.name) - INSTALLERS.indexOf(b.name))
    .map((a) => ({
      name: a.name,
      label: ASSET_LABELS[a.name] || "FullVolume",
      size: SIZE(a.size || 0),
      downloads: a.download_count || 0,
      url: a.browser_download_url,
    }));

  return {
    tag,
    product,
    products,
    // What the page calls it. Two products in one list means "v0.9.5" on its
    // own is ambiguous, so the charter's releases wear their name. Short of
    // the full FullVolumeCharter: it is a 46px hollow display face on the
    // changelog and the whole name would wrap on a phone. A joint release is
    // both products' and stays a plain number.
    label: product === "charter" ? `Charter v${version}` : `v${version}`,
    version,
    channel,
    name: raw.name || tag,
    date: (raw.published_at || raw.created_at || "").slice(0, 10),
    prerelease: !!raw.prerelease,
    url: raw.html_url,
    tagline: taglineOf(preamble),
    first: isOldest,
    sections: kept,
    assets,
    downloads: (raw.assets || []).reduce((n, a) => n + (a.download_count || 0), 0),
  };
}

/* ============================================================
   THE WHOLE CHANGELOG
   ============================================================ */

/**
 * Newest first, drafts dropped, boilerplate stripped. The headings of older
 * releases have to be known before a newer one can be judged against them, so
 * the parse runs oldest first and the list is turned back round at the end.
 *
 * **A product only repeats itself.** The "seen it before" pool is per product,
 * not shared: the charter's notes and the game's are two different documents
 * that happen to live in one repository, and a shared pool would let a game
 * release published on Tuesday silently eat a section out of the charter
 * release published on Wednesday for having the same heading.
 *
 * A joint release says its piece to BOTH pools, because it is both products'
 * release - otherwise the next charter-only release would repeat everything
 * the joint one had already said.
 */
export function buildChangelog(rawReleases, { repo = REPO } = {}) {
  const usable = rawReleases
    .filter((r) => !r.draft && r.tag_name)
    .sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));

  const seenByProduct = { game: new Set(), charter: new Set() };

  // "first" is the launch build, and there is only one of those in the
  // repository - the charter's first release of its own is not a launch, it is
  // the point the two numbers stopped being one number.
  const releases = usable.map((raw, i) => {
    const mine = productsOf(raw);
    // One pool to judge against - a joint release is measured against the
    // game's history - and every pool it belongs to gets told afterwards.
    const pools = mine.map((p) => seenByProduct[p]);
    return parseRelease(raw, pools, i === 0);
  });

  releases.reverse();

  const newest = (product) =>
    releases.find((r) => r.products.includes(product))?.version || "";

  return {
    generated: new Date().toISOString(),
    repo,
    latest: newest("game"),
    latestByProduct: { game: newest("game"), charter: newest("charter") },
    releases,
  };
}
