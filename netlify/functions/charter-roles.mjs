// Who should wear the Verified Charters role in the Discord server.
//
//   GET /api/charter-roles    { ids: [discord user id, ...] }
//
// The admin page gives the role the moment somebody is verified, but only if
// they are already in the server. Everybody else gets it from the bot when they
// join, and this is the list it checks them against. It also backs up the admin
// page: the bot sweeps the server against it, so a grant that failed still lands.
//
// Only the bot may ask. It sends `Authorization: Bearer <CHARTER_ROLE_SECRET>`,
// a secret shared between Netlify and the bot's .env on the box.

import { timingSafeEqual } from "node:crypto";

import { IS_USER_ID } from "../lib/discord.mjs";
import { env, json, problem } from "../lib/http.mjs";
import { allJson, charters } from "../lib/stores.mjs";

function allowed(req) {
  const secret = env("CHARTER_ROLE_SECRET");
  if (!secret) return false;
  const sent = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return sent.length === want.length && timingSafeEqual(sent, want);
}

export default async (req) => {
  if (req.method !== "GET") return problem("Not found.", 404);
  if (!allowed(req)) return problem("Not allowed.", 401);
  try {
    // Records from before the ID was asked for carry only a username, which
    // cannot be matched to a member, so they are left out.
    const ids = [...new Set((await allJson(charters())).map((c) => String(c.discord)).filter((id) => IS_USER_ID.test(id)))];
    return json({ ids });
  } catch (err) {
    console.error("charter roles failed", err);
    return problem(`Something went wrong: ${err.message}`, 500);
  }
};

export const config = { path: "/api/charter-roles" };
