// POST /api/apply - an application to become a verified charter.
//
// Checked here rather than trusted from the page: the Discord username's
// shape, that the Drive link is a folder, that the folder is actually shared
// publicly and has at least one .fvchart in it, and that the same folder or
// username is not already waiting. The chart count is stored with the
// application so the admin page shows it without walking Drive again.

import { createHash, randomUUID } from "node:crypto";
import { listCharts, parseDriveLink, folderUrl, layoutProblem } from "../lib/fvchart.mjs";
import { env, json, problem, readJson, sameOrigin } from "../lib/http.mjs";
import { allJson, applications, charters, rateLimits } from "../lib/stores.mjs";

const USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;
const REASON_MIN = 20;
const REASON_MAX = 1500;
// Counted per attempt that gets as far as walking Drive, so somebody fixing
// their folder's sharing can try a few times.
const PER_DAY_PER_ADDRESS = 8;
const LISTING_BUDGET_MS = 12_000;

function validate(body) {
  const fields = {};
  const discord = String(body?.discord ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!discord) fields.discord = "Enter your Discord username.";
  else if (!USERNAME.test(discord)) {
    fields.discord = "That is not a Discord username. It is 2 to 32 lowercase letters, numbers, dots or underscores, like jurmr or sing_along.";
  }

  const link = parseDriveLink(body?.folder);
  if (!String(body?.folder ?? "").trim()) fields.folder = "Paste the link to your shared Google Drive folder.";
  else if (!link) fields.folder = "That is not a Google Drive link. It should start with https://drive.google.com/drive/folders/";
  else if (link.kind !== "folder") fields.folder = "That links to a single file. Share the folder that holds your charts instead.";

  const reason = String(body?.reason ?? "").trim();
  if (reason.length < REASON_MIN) fields.reason = `Tell us a little more, at least ${REASON_MIN} characters.`;
  else if (reason.length > REASON_MAX) fields.reason = `Keep it under ${REASON_MAX} characters.`;

  return { fields, discord, folderId: link?.id, reason };
}

async function underRateLimit(req, context) {
  const address = context.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const hash = createHash("sha256").update(`${env("SESSION_SECRET")}|${address}`).digest("hex").slice(0, 32);
  const key = `apply/${hash}/${new Date().toISOString().slice(0, 10)}`;
  const store = rateLimits();
  const count = Number(await store.get(key)) || 0;
  if (count >= PER_DAY_PER_ADDRESS) return false;
  await store.set(key, String(count + 1));
  return true;
}

export default async (req, context) => {
  if (req.method !== "POST") return problem("Method not allowed.", 405);
  if (!sameOrigin(req)) return problem("Cross-site request refused.", 403);

  const body = await readJson(req);
  // A field no person can see. Anything that fills it in is a bot; it is
  // told everything went fine so it has no reason to try again.
  if (body?.website) return json({ ok: true });

  const { fields, discord, folderId, reason } = validate(body);
  if (Object.keys(fields).length) return problem("Some of that needs fixing.", 422, { fields });

  const [pending, verified] = await Promise.all([allJson(applications()), charters().get(folderId, { type: "json" })]);
  if (verified) {
    return problem("That folder already belongs to a verified charter.", 409, { fields: { folder: "This folder is already verified. Its charts are on the Marketplace." } });
  }
  const waiting = pending.filter((a) => a.status === "pending");
  if (waiting.some((a) => a.folderId === folderId)) {
    return problem("There is already an application for that folder.", 409, { fields: { folder: "We already have an application for this folder, and it is still being looked at." } });
  }
  if (waiting.some((a) => a.discord === discord)) {
    return problem("There is already an application from that username.", 409, { fields: { discord: "We already have an application from this username, and it is still being looked at." } });
  }

  if (!(await underRateLimit(req, context))) {
    return problem("Too many applications from this connection today. Try again tomorrow.", 429);
  }

  let listing;
  try {
    listing = await listCharts(folderId, Date.now() + LISTING_BUDGET_MS);
  } catch {
    return problem("We could not open that folder.", 422, {
      fields: { folder: "We could not open that folder. In Google Drive, set General access to \"Anyone with the link\" and try again." },
    });
  }
  if (!listing.charts.length && listing.complete) {
    return problem("That folder has no charts in it.", 422, {
      fields: { folder: "We could not find any .fvchart files in that folder. Put your charts in it first, laid out as shown above." },
    });
  }

  const application = {
    id: randomUUID(),
    status: "pending",
    discord,
    folderId,
    folderUrl: folderUrl(folderId),
    reason,
    submittedAt: new Date().toISOString(),
    charts: listing.charts.length,
    folders: listing.folders,
    countComplete: listing.complete,
    layoutProblems: listing.charts.map((c) => layoutProblem(c.name, c.folder)).filter(Boolean).length,
  };
  await applications().setJSON(application.id, application);
  return json({ ok: true, charts: application.charts });
};

export const config = { path: "/api/apply", method: ["POST"] };
