// The live numbers on /community/.
//
//   GET /api/pulse
//
// Two unrelated things are being asked at once, and the page wants both:
//
//   discord   how many people are in the server and how many are awake
//   rooms     how many rooms are sitting open in the game right now
//
// Neither is allowed to take the other down. Each half comes back null on its
// own if it could not be read, and the page falls back to saying nothing about
// that half rather than showing a zero it invented.
//
// The browser cannot ask either of these itself. The room directory is plain
// HTTP, which an HTTPS page is not allowed to touch, and asking Discord from
// every visitor's machine spends a shared rate limit on a number that is the
// same for all of them. So it is asked once here and cached at the edge.

import { json } from "../lib/http.mjs";

/** Public, all three. The invite is the permanent one; the widget is opt in and on. */
const GUILD = process.env.DISCORD_GUILD_ID || "1547333347234160702";
const INVITE_CODE = process.env.DISCORD_INVITE_CODE || "hut9sPRcr2";
const REGISTRY = (process.env.REGISTRY_URL || "http://72.72.164.145:8092").replace(/\/+$/, "");

const TIMEOUT_MS = 6000;

/** A room name is typed by a player, so it is cut to something a card can hold. */
const clip = (text, max) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
};

/**
 * Members and who is online, from the invite rather than the widget.
 *
 * The widget carries a presence count too, but it also carries a list of the
 * hundred most recent members with their avatars, and this page does not want
 * that: most of what is online in a small server is bots, and an avatar strip
 * of four bots undersells a room full of people. One call, two numbers.
 */
async function readDiscord() {
  const url = `https://discord.com/api/v10/invites/${encodeURIComponent(INVITE_CODE)}?with_counts=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);

  const invite = await res.json();
  return {
    name: invite.guild?.name || "FullVolumeTheGame",
    description: invite.guild?.description || "",
    members: Number(invite.approximate_member_count) || 0,
    online: Number(invite.approximate_presence_count) || 0,
    invite: `https://discord.gg/${INVITE_CODE}`,
  };
}

/**
 * Every room the game's own directory is advertising.
 *
 * The directory serves newline-delimited records of tab-separated key=value
 * fields, the format defined in the game at Assets/Scripts/Net/RoomListing.cs.
 * Unknown fields are skipped rather than rejected, exactly as the game skips
 * them, so a newer directory can add one without breaking this.
 *
 * host and port are deliberately dropped on the floor. A room hosted by a
 * player carries that player's home address, and a marketing page has no
 * business republishing it.
 */
function parseRooms(body) {
  const rooms = [];

  for (const line of String(body).split("\n")) {
    if (!line.trim()) continue;

    const room = { name: "", players: 0, capacity: 0, locked: false, song: "" };
    let named = false;
    let routable = false;

    for (const field of line.split("\t")) {
      const split = field.indexOf("=");
      if (split <= 0) continue;

      const key = field.slice(0, split);
      const value = field.slice(split + 1);

      switch (key) {
        case "name":
          // The directory hides a tab and a newline so they cannot break a line.
          room.name = clip(value.replace(/\\t/g, " ").replace(/\\n/g, " ").replace(/\\\\/g, "\\"), 40);
          named = true;
          break;
        case "host":
          routable = value.length > 0;
          break;
        case "players":
          room.players = Number.parseInt(value, 10) || 0;
          break;
        case "capacity":
          room.capacity = Number.parseInt(value, 10) || 0;
          break;
        case "locked":
          room.locked = value === "1";
          break;
        case "song":
          room.song = clip(value.replace(/\\t/g, " ").replace(/\\n/g, " ").replace(/\\\\/g, "\\"), 60);
          break;
        default:
          break;
      }
    }

    // A record nobody can join is not a room, and the game takes the same view.
    if (named && routable) rooms.push(room);
  }

  return rooms;
}

async function readRooms() {
  const res = await fetch(`${REGISTRY}/rooms`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the directory answered ${res.status}`);

  const list = parseRooms(await res.text());
  const open = list.filter((r) => !r.locked);

  return {
    open: open.length,
    total: list.length,
    singing: list.reduce((n, r) => n + r.players, 0),
    seats: open.reduce((n, r) => n + Math.max(0, r.capacity - r.players), 0),
    // Newest activity first, so a room with somebody in it is never below an empty one.
    list: list.sort((a, b) => b.players - a.players).slice(0, 8),
  };
}

/** Null rather than a throw, because the other half of the answer still stands. */
const attempt = async (read) => {
  try {
    return await read();
  } catch {
    return null;
  }
};

export default async () => {
  const [discord, rooms] = await Promise.all([attempt(readDiscord), attempt(readRooms)]);

  return json(
    { discord, rooms, checked: new Date().toISOString() },
    200,
    {
      // Half a minute in a browser, a minute at the edge, and a stale answer
      // for five more while a fresh one is fetched behind it. One visitor in a
      // burst pays for the fetch; nobody waits on it.
      "Cache-Control": "public, max-age=30",
      "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      "Access-Control-Allow-Origin": "*",
    },
  );
};

export const config = { path: "/api/pulse", method: ["GET"] };
