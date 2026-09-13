// Small response helpers shared by every function.

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export const problem = (message, status = 400, extra = {}) => json({ error: message, ...extra }, status);

export function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...headers } });
}

/** A value from the site's environment variables, or "". */
export function env(name) {
  return (globalThis.Netlify?.env.get(name) ?? process.env[name] ?? "").trim();
}

export function readCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

export function cookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/**
 * State-changing requests must come from this site. SameSite=Lax already keeps
 * the session cookie off a cross-site POST; this is the second lock.
 */
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
