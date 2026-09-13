// The admin session: a signed cookie, no server-side session table.
//
// The cookie holds { id, name, avatar, exp } and an HMAC over it keyed by
// SESSION_SECRET. Being signed in is not enough on its own: every request
// also checks the Discord id against ADMIN_DISCORD_IDS, so removing someone
// from that list locks them out at once, cookie or not.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env, readCookie, cookie, problem, sameOrigin } from "./http.mjs";

export const SESSION_COOKIE = "fv_admin";
const SESSION_SECONDS = 7 * 24 * 3600;

function secret() {
  const value = env("SESSION_SECRET");
  if (value.length < 32) throw new Error("SESSION_SECRET is not set (32+ characters)");
  return value;
}

const sign = (data) => createHmac("sha256", secret()).update(data).digest("base64url");

export function adminIds() {
  return env("ADMIN_DISCORD_IDS").split(",").map((s) => s.trim()).filter(Boolean);
}

export function sessionCookie(user) {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + SESSION_SECONDS * 1000 })).toString("base64url");
  return cookie(SESSION_COOKIE, `${payload}.${sign(payload)}`, SESSION_SECONDS);
}

export const clearedSessionCookie = () => cookie(SESSION_COOKIE, "", 0);

/** The signed-in admin, or null. */
export function currentAdmin(req) {
  const raw = readCookie(req, SESSION_COOKIE);
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!user.exp || user.exp < Date.now()) return null;
    return adminIds().includes(String(user.id)) ? user : null;
  } catch {
    return null;
  }
}

/**
 * Wraps an admin-only handler: 401 without a session, 403 for a cross-site
 * write. The handler receives (req, context, admin).
 */
export function adminOnly(handler) {
  return async (req, context) => {
    let admin;
    try {
      admin = currentAdmin(req);
    } catch (err) {
      return problem(err.message, 500);
    }
    if (!admin) return problem("Sign in with Discord first.", 401);
    if (req.method !== "GET" && !sameOrigin(req)) return problem("Cross-site request refused.", 403);
    return handler(req, context, admin);
  };
}
