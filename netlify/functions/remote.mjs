// GET /r/<code>
//
// The short link printed on the game's PHONE REMOTE card, e.g.
// fullvolumethegame.xyz/r/K7QX. The game's remote is a small web server on the
// host's own network (http://192.168.x.x:port/?k=key); the game parks that
// address with the directory under a four-character code (Links.cs in
// Server/FullVolume.Registry), and this sends the phone on to it.
//
// A redirect, not a page that fetches: an https page may not ask an http
// address on somebody's LAN for anything, but a top-level navigation there is
// allowed. The directory rebuilds the address from a private IPv4, a port and
// a key, and this checks the shape again, so a code can never point a phone at
// the internet.
//
// Phones that are not on the host's Wi-Fi (an online room's members, a phone on
// mobile data) cannot reach that LAN address at all. For them the game keeps an
// off-network relay open with the directory (Relay.cs), and the phone is sent to
// /x/<code>/ instead: the remote page served from this site (docs/remote/app/),
// whose API calls netlify.toml proxies to the directory and on to the game. The
// rule: the LAN address when the phone asks from the same public address the game
// claimed the code from (the same home network), the relay otherwise, as long as
// the game is holding it open. ?via=relay or ?via=lan forces one.
//
// Anything that cannot be followed lands on /remote/, which says why and has a
// box to type the code again. Never cached: a code is reused once it expires.

import { redirect } from "../lib/http.mjs";
import { REGISTRY, REGISTRY_TIMEOUT_MS, readRecord } from "../lib/registry.mjs";

// Must match Links.CodeAlphabet / CodeLength in the directory.
const CODE = /^[2-9A-HJKMNP-Z]{4}$/;

const LAN_URL =
  /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):\d{4,5}\/\?k=[A-Za-z0-9_-]{1,32}$/;

export function codeFrom(pathname) {
  const match = /^\/r\/?([^/]*)\/?$/i.exec(pathname || "");
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim().toUpperCase();
  } catch {
    return match[1].toUpperCase();
  }
}

export function isLanUrl(url) {
  return LAN_URL.test(url || "");
}

/**
 * Where a phone goes for a directory answer: the LAN address, the relay, or "" for
 * neither. `record` is the parsed /link line (url, same, relay), `via` the override.
 */
export function destination(code, record, via = "") {
  const url = record.url || "";
  const lan = isLanUrl(url) ? url : "";
  const key = lan ? new URL(lan).searchParams.get("k") : "";
  const relay = record.relay === "1" && key ? `/x/${code}/?k=${encodeURIComponent(key)}` : "";

  if (via === "lan") return lan;
  if (via === "relay") return relay || lan;
  if (record.same === "1") return lan || relay;
  return relay || lan;
}

export default async function handler(req, context) {
  const requested = new URL(req.url);
  const code = codeFrom(requested.pathname);
  const via = (requested.searchParams.get("via") || "").toLowerCase();

  if (!code) return redirect("/remote/");
  if (!CODE.test(code)) return redirect(`/remote/?code=${encodeURIComponent(code.slice(0, 8))}&gone=1`);

  try {
    const res = await fetch(`${REGISTRY}/link?code=${code}`, {
      // The directory rate-limits lookups per address; without this every
      // phone would share the function's own.
      headers: context?.ip ? { "X-Forwarded-For": context.ip } : {},
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });

    if (res.status === 404 || res.status === 400) return redirect(`/remote/?code=${code}&gone=1`);
    if (!res.ok) throw new Error(`the directory answered ${res.status}`);

    const url = destination(code, readRecord((await res.text()).trim()), via);
    if (!url) throw new Error("the directory gave an address that is not on a home network");

    return redirect(url, { "Referrer-Policy": "no-referrer" });
  } catch (err) {
    console.log(`remote ${code}: ${err.message}`);
    return redirect(`/remote/?code=${code}&down=1`);
  }
}

export const config = { path: ["/r", "/r/*"], method: ["GET"] };
