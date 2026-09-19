// Turning a Discord user ID into a face.
//
// Everything the site keeps about a charter is an ID and, where it has one, a
// username. Neither of those is a person you can recognise, and the admin page
// is where you decide whether to put somebody's charts on the Marketplace. So
// this reads the account itself: the avatar, the display name, the badges and
// how old the account is, which together answer "who is this, and are they
// real" far faster than eighteen digits ever will.
//
// Discord's own REST API is the only source. There is no unauthenticated route
// for reading an arbitrary user, and the public lookup sites that appear to
// offer one are all just somebody else's bot token behind a proxy, so this uses
// FullVolume's own bot instead of trusting a third party with the question.
//
// Without DISCORD_BOT_TOKEN set it still answers, with the two facts an ID
// carries on its own: the moment the account was created, which is encoded in
// the snowflake, and which of the six default avatars Discord draws for it.

import { env } from "./http.mjs";
import { discordProfiles } from "./stores.mjs";

const API = "https://discord.com/api/v10";
const CDN = "https://cdn.discordapp.com";
const AGENT = "FullVolume (https://fullvolumethegame.xyz, 1.0)";

// Discord's snowflakes count milliseconds from 2015-01-01, not 1970.
const EPOCH = 1420070400000n;

const FRESH_MS = 6 * 60 * 60 * 1000; // a real account: re-read four times a day
const MISSING_MS = 60 * 60 * 1000; // an ID nobody owns: re-read hourly

export const IS_USER_ID = /^\d{17,20}$/;

// The public flags, newest names, with what a person would call each one.
// Tones match the chips the admin page already draws.
const BADGES = [
  [1 << 0, "Discord Staff", "gold"],
  [1 << 1, "Partnered Server Owner", "gold"],
  [1 << 2, "HypeSquad Events", "sage"],
  [1 << 3, "Bug Hunter", "sage"],
  [1 << 6, "HypeSquad Bravery", "sage"],
  [1 << 7, "HypeSquad Brilliance", "sage"],
  [1 << 8, "HypeSquad Balance", "sage"],
  [1 << 9, "Early Supporter", "gold"],
  [1 << 10, "Team account", ""],
  [1 << 14, "Bug Hunter Gold", "gold"],
  [1 << 16, "Verified bot", "sage"],
  [1 << 17, "Early Verified Bot Developer", "gold"],
  [1 << 18, "Moderator Programs Alumni", "gold"],
  [1 << 19, "Uses HTTP interactions", ""],
  [1 << 22, "Active Developer", "sage"],
];

/** When the account was made, read straight out of the ID. */
export function createdAt(id) {
  try {
    return new Date(Number((BigInt(id) >> 22n) + EPOCH)).toISOString();
  } catch {
    return null;
  }
}

/**
 * The grey avatar Discord draws for someone who has never set one. Post-pomelo
 * accounts pick one of six from the ID; the handful of accounts still carrying
 * a #1234 discriminator pick one of five from that.
 */
function defaultAvatar(id, discriminator) {
  const legacy = discriminator && discriminator !== "0";
  const index = legacy ? Number(discriminator) % 5 : Number((BigInt(id) >> 22n) % 6n);
  return `${CDN}/embed/avatars/${index}.png`;
}

const hex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;

function badgesOf(flags) {
  return BADGES.filter(([bit]) => flags & bit).map(([, label, tone]) => ({ label, tone }));
}

/** What we can say about an ID before anybody has answered the question. */
function unknown(id, reason) {
  return {
    id,
    known: false,
    reason,
    username: "",
    globalName: "",
    tag: "",
    bot: false,
    avatar: defaultAvatar(id, "0"),
    avatarAnimated: false,
    banner: "",
    decoration: "",
    accentColor: "",
    badges: [],
    guildTag: null,
    createdAt: createdAt(id),
  };
}

/** The little server tag Discord draws after somebody's name, if they wear one. */
function guildTagOf(user) {
  const tag = user.primary_guild || user.clan;
  if (!tag?.identity_enabled || !tag.tag) return null;
  return {
    text: String(tag.tag),
    badge: tag.badge && tag.identity_guild_id
      ? `${CDN}/clan-badges/${tag.identity_guild_id}/${tag.badge}.png?size=32`
      : "",
  };
}

function fromDiscord(user) {
  const id = String(user.id);
  const discriminator = String(user.discriminator ?? "0");
  const animatedAvatar = typeof user.avatar === "string" && user.avatar.startsWith("a_");
  const animatedBanner = typeof user.banner === "string" && user.banner.startsWith("a_");
  return {
    id,
    known: true,
    reason: "",
    username: user.username || "",
    globalName: user.global_name || "",
    // Only the accounts that never migrated still have a #1234 to show.
    tag: discriminator !== "0" ? `${user.username}#${discriminator}` : "",
    bot: !!user.bot,
    avatar: user.avatar
      ? `${CDN}/avatars/${id}/${user.avatar}.${animatedAvatar ? "gif" : "png"}?size=256`
      : defaultAvatar(id, discriminator),
    avatarAnimated: animatedAvatar,
    banner: user.banner ? `${CDN}/banners/${id}/${user.banner}.${animatedBanner ? "gif" : "png"}?size=600` : "",
    decoration: user.avatar_decoration_data?.asset
      ? `${CDN}/avatar-decoration-presets/${user.avatar_decoration_data.asset}.png?size=160`
      : "",
    accentColor: typeof user.accent_color === "number" ? hex(user.accent_color) : String(user.banner_color || ""),
    badges: badgesOf(user.public_flags | 0),
    guildTag: guildTagOf(user),
    createdAt: createdAt(id),
  };
}

/**
 * One profile. Cached in Blobs so opening the admin page twice in a minute is
 * one Discord request, not two dozen; `fresh` skips the cache for the case
 * where somebody has just changed their avatar and wants to see it.
 */
export async function profileFor(id, { fresh = false } = {}) {
  if (!IS_USER_ID.test(String(id))) return unknown(String(id), "not-an-id");
  id = String(id);

  const store = discordProfiles();
  // The cache is an optimisation. If it cannot be read, ask Discord instead.
  const cached = await store.get(id, { type: "json" }).catch(() => null);
  const age = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  if (!fresh && cached && age < (cached.known ? FRESH_MS : MISSING_MS)) return { ...cached, cached: true };

  const token = env("DISCORD_BOT_TOKEN");
  if (!token) return cached ? { ...cached, stale: true } : unknown(id, "no-token");

  let res;
  try {
    res = await fetch(`${API}/users/${id}`, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": AGENT },
    });
  } catch (err) {
    console.warn("discord lookup unreachable", id, err.message);
    return cached ? { ...cached, stale: true } : unknown(id, "unreachable");
  }

  if (res.status === 404) {
    const gone = { ...unknown(id, "missing"), fetchedAt: new Date().toISOString() };
    await store.setJSON(id, gone).catch(() => {});
    return gone;
  }
  if (!res.ok) {
    // 401 means the token is wrong, 429 means too many at once. Neither is a
    // reason to throw away a profile we already had.
    console.warn("discord lookup failed", id, res.status);
    if (cached) return { ...cached, stale: true };
    return unknown(id, res.status === 401 ? "bad-token" : res.status === 429 ? "rate-limited" : "failed");
  }

  const profile = { ...fromDiscord(await res.json()), fetchedAt: new Date().toISOString() };
  await store.setJSON(id, profile).catch(() => {});
  return profile;
}

/**
 * Several profiles, keyed by ID. Discord has no bulk user route, so this is one
 * request each, a few at a time: the admin page asks for every name on it at
 * once and a function has thirty seconds to answer.
 */
export async function profilesFor(ids, { fresh = false } = {}) {
  const wanted = [...new Set(ids.map(String).filter((id) => IS_USER_ID.test(id)))];
  const out = {};
  for (let i = 0; i < wanted.length; i += 6) {
    await Promise.all(
      wanted.slice(i, i + 6).map(async (id) => {
        out[id] = await profileFor(id, { fresh });
      }),
    );
  }
  return out;
}

// The Verified Charters role in the FullVolume server. Not secrets, so they sit
// here with an env override, the same way the bot pins its own role ids.
const GUILD_ID = () => env("DISCORD_GUILD_ID") || "1547333347234160702";
const VERIFIED_ROLE_ID = () => env("VERIFIED_CHARTER_ROLE_ID") || "1548651160997470358";

/**
 * Gives or takes the Verified Charters role. Somebody who is not in the server
 * yet is not a failure: the bot hands them the role the moment they join, off
 * the list /api/charter-roles gives it. Answers with what happened, never throws,
 * because the charter is verified either way and the role is the lesser half.
 *
 *   "granted" | "revoked" | "not-in-server" | "no-token" | "not-an-id" | "failed"
 */
export async function setVerifiedRole(id, on, reason) {
  if (!IS_USER_ID.test(String(id))) return "not-an-id";
  const token = env("DISCORD_BOT_TOKEN");
  if (!token) return "no-token";

  let res;
  try {
    res = await fetch(`${API}/guilds/${GUILD_ID()}/members/${id}/roles/${VERIFIED_ROLE_ID()}`, {
      method: on ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": AGENT,
        "X-Audit-Log-Reason": encodeURIComponent(reason || (on ? "Verified charter" : "No longer a verified charter")),
      },
    });
  } catch (err) {
    console.warn("discord role change unreachable", id, err.message);
    return "failed";
  }
  if (res.ok) return on ? "granted" : "revoked";

  // 10007 Unknown Member: they have not joined. Anything else is worth a log line.
  const body = await res.json().catch(() => ({}));
  if (res.status === 404 && body.code === 10007) return "not-in-server";
  console.warn("discord role change failed", id, res.status, body.code, body.message);
  return "failed";
}
