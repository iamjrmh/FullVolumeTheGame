// GET /api/players
//
// How many people have FullVolume open right now - anywhere in the game, not
// only in a multiplayer room. Every running copy checks in with the directory
// once a minute and the directory counts them (Server/FullVolume.Registry/
// Presence.cs in the game project); this just carries that number to the site,
// because an HTTPS page is not allowed to ask a plain-HTTP server itself.
//
// The directory's own floor is the number of people sitting in rooms, so a
// copy of the game from before the check-in existed still counts while it is
// in one.
//
// Held on the CDN for 20 seconds and served stale for a minute while it is
// refreshed, so however many tabs are watching, the directory is asked about
// three times a minute.

import { json, problem } from "../lib/http.mjs";
import { REGISTRY, REGISTRY_TIMEOUT_MS, readRecord } from "../lib/registry.mjs";

export default async function handler() {
  try {
    const res = await fetch(`${REGISTRY}/online`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`the directory answered ${res.status}`);

    const record = readRecord(await res.text());
    const online = Number.parseInt(record.online, 10);
    if (!Number.isFinite(online) || online < 0) throw new Error("the directory gave no count");

    return json(
      { online, inRooms: Number.parseInt(record.in_rooms, 10) || 0, checked: new Date().toISOString() },
      200,
      {
        "Cache-Control": "public, max-age=15",
        "Netlify-CDN-Cache-Control": "public, s-maxage=20, stale-while-revalidate=60",
      },
    );
  } catch (err) {
    // The page hides the counter rather than showing a zero it cannot vouch for.
    return problem(`Could not read who is online: ${err.message}`, 502);
  }
}

export const config = { path: "/api/players", method: ["GET"] };
