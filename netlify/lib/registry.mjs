// Where the game's own directory lives, for every function that asks it.
//
// One copy of the address, because there used to be one per function and the
// one in /api/pulse still named the retired home server long after the
// directory moved to the VPS, which quietly blanked the community page's room
// board. REGISTRY_URL in the site's environment overrides it.

export const REGISTRY = (process.env.REGISTRY_URL || "http://192.227.235.140:8092").replace(/\/+$/, "");

export const REGISTRY_TIMEOUT_MS = 6000;

/**
 * One line of the directory's tab-separated key=value records, as an object of
 * strings. Unknown keys come through untouched; the caller picks what it wants.
 */
export function readRecord(line) {
  const record = {};
  for (const field of String(line).split("\t")) {
    const split = field.indexOf("=");
    if (split > 0) record[field.slice(0, split)] = field.slice(split + 1).trim();
  }
  return record;
}
