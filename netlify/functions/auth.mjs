// Discord sign-in for the admin page.
//
//   GET  /api/auth/login     -> Discord's consent screen
//   GET  /api/auth/callback  -> back from Discord; admins get a session
//   POST /api/auth/logout
//
// Only the "identify" scope is asked for: the one thing needed is who you are.
// Anyone can complete the Discord side; only ids in ADMIN_DISCORD_IDS are given
// a session, everyone else lands on /admin/?denied=1.

import { randomBytes } from "node:crypto";
import { cookie, env, json, problem, readCookie, redirect, sameOrigin } from "../lib/http.mjs";
import { adminIds, clearedSessionCookie, sessionCookie } from "../lib/session.mjs";

const STATE_COOKIE = "fv_oauth_state";
const DISCORD = "https://discord.com";

const callbackUrl = (req) => `${new URL(req.url).origin}/api/auth/callback`;

function login(req) {
  const clientId = env("DISCORD_CLIENT_ID");
  if (!clientId) return problem("DISCORD_CLIENT_ID is not set.", 500);
  const state = randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: callbackUrl(req),
    state,
    prompt: "none",
  });
  return redirect(`${DISCORD}/oauth2/authorize?${params}`, { "Set-Cookie": cookie(STATE_COOKIE, state, 600) });
}

async function callback(req) {
  const url = new URL(req.url);
  const back = (query) => redirect(`/admin/${query}`, { "Set-Cookie": cookie(STATE_COOKIE, "", 0) });

  const expected = readCookie(req, STATE_COOKIE);
  if (!expected || url.searchParams.get("state") !== expected) return back("?error=state");
  const code = url.searchParams.get("code");
  if (!code) return back("?error=cancelled");

  const token = await fetch(`${DISCORD}/api/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("DISCORD_CLIENT_ID"),
      client_secret: env("DISCORD_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(req),
    }),
  });
  if (!token.ok) {
    console.error("discord token exchange failed", token.status, await token.text());
    return back("?error=discord");
  }
  const { access_token: accessToken } = await token.json();

  const me = await fetch(`${DISCORD}/api/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!me.ok) return back("?error=discord");
  const user = await me.json();

  if (!adminIds().includes(String(user.id))) {
    console.warn("admin sign-in refused for discord id", user.id);
    return back("?denied=1");
  }

  const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96` : "";
  const headers = new Headers({ Location: "/admin/", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie({ id: String(user.id), name: user.global_name || user.username, avatar }));
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

export default async (req) => {
  const { pathname } = new URL(req.url);
  try {
    if (pathname.endsWith("/login") && req.method === "GET") return login(req);
    if (pathname.endsWith("/callback") && req.method === "GET") return await callback(req);
    if (pathname.endsWith("/logout") && req.method === "POST") {
      if (!sameOrigin(req)) return problem("Cross-site request refused.", 403);
      return json({ ok: true }, 200, { "Set-Cookie": clearedSessionCookie() });
    }
  } catch (err) {
    console.error("auth failed", err);
    return redirect("/admin/?error=server");
  }
  return problem("Not found.", 404);
};

export const config = { path: ["/api/auth/login", "/api/auth/callback", "/api/auth/logout"] };
