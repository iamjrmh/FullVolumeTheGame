// The admin API. Every route needs a signed-in admin (see lib/session.mjs).
//
//   GET    /api/admin/overview                      everything the page draws
//   POST   /api/admin/applications/:id/accept       make them a verified charter
//   POST   /api/admin/applications/:id/decline
//   POST   /api/admin/applications/:id/recount      walk their folder again
//   DELETE /api/admin/applications/:id              forget a decided application
//   POST   /api/admin/charters                      add one by hand { discord, folder }
//   DELETE /api/admin/charters/:folderId
//   POST   /api/admin/refresh                       one refresh pass { start }
//   POST   /api/admin/discord                       who these ids are { ids }
//   GET    /api/admin/discord/:id[/fresh]           one profile, cache or not
//   GET    /api/admin/video                         the charter page's video, as kept
//   POST   /api/admin/video/look                    read a video before choosing it { link }
//   POST   /api/admin/video                         play this one on the charter page { link }
//   POST   /api/admin/video/reread                  read the chosen video again from scratch

import { profileFor, profilesFor, setVerifiedRole } from "../lib/discord.mjs";
import { folderUrl, listCharts, parseDriveLink } from "../lib/fvchart.mjs";
import { env, json, problem, readJson } from "../lib/http.mjs";
import { currentProgress, dropCharter, readIndex, refreshPass } from "../lib/refresh.mjs";
import { adminOnly } from "../lib/session.mjs";
import { allJson, applications, charters } from "../lib/stores.mjs";
import { currentCharterVideo, keptVideoMeta, purgeVideoCache, refreshVideoMeta, setCharterVideo } from "../lib/videometa.mjs";
import { parseYouTubeId } from "../lib/youtube.mjs";

// A Discord user ID, not a username. A username can be changed by its owner at
// any time, and once it has been there is no way left to reach the person whose
// charts are on the Marketplace. The ID never changes and always resolves.
// Discord snowflakes are 17 to 20 digits today and grow with time, so the range
// is deliberately loose at the top.
const USER_ID = /^\d{17,20}$/;

/** The username kept alongside the ID, so there is a name to type at somebody. */
const USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;

async function overview(admin) {
  const [apps, verified, index, progress] = await Promise.all([
    allJson(applications()), allJson(charters()), readIndex(), currentProgress(),
  ]);
  apps.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  verified.sort((a, b) => a.discord.localeCompare(b.discord));
  return json({
    admin,
    applications: apps,
    charters: verified.map((c) => ({ ...c, charts: index?.perCharter?.[c.id] ?? null })),
    index: index && {
      generated: index.generated,
      trigger: index.trigger,
      count: index.count,
      warnings: index.warnings || [],
      errors: index.errors || [],
    },
    refresh: progress,
  });
}

async function decide(id, action, admin) {
  const store = applications();
  const app = await store.get(id, { type: "json" });
  if (!app) return problem("That application no longer exists.", 404);

  if (action === "recount") {
    try {
      const listing = await listCharts(app.folderId, Date.now() + 15_000);
      Object.assign(app, { charts: listing.charts.length, folders: listing.folders, countComplete: listing.complete, countedAt: new Date().toISOString() });
    } catch (err) {
      return problem(`Could not open their folder: ${err.message}`, 422);
    }
    await store.setJSON(id, app);
    return json({ application: app });
  }

  if (app.status !== "pending") return problem(`Already ${app.status}.`, 409);
  app.status = action === "accept" ? "accepted" : "declined";
  app.decidedAt = new Date().toISOString();
  app.decidedBy = admin.name;

  if (action === "accept") {
    // Keyed by the user ID where the application carried one, with the username
    // kept beside it: the ID is what still identifies them after a rename, the
    // username is what you actually type to talk to them. Applications sent
    // before the ID was asked for have only the username, and stay as they were.
    const charter = {
      id: app.folderId,
      discord: app.discordId || app.discord,
      username: app.discordId ? app.discord : "",
      folderUrl: app.folderUrl,
      addedAt: app.decidedAt,
      applicationId: app.id,
    };
    await charters().setJSON(charter.id, charter);
    await store.setJSON(id, app);
    const role = await setVerifiedRole(charter.discord, true, `Verified charter, accepted by ${admin.name}`);
    return json({ application: app, charter, role });
  }
  await store.setJSON(id, app);
  return json({ application: app });
}

async function addCharter(req, admin) {
  const body = await readJson(req);
  const discord = String(body?.discord ?? "").trim().replace(/^@/, "");
  const username = String(body?.username ?? "").trim().replace(/^@/, "").toLowerCase();
  const link = parseDriveLink(body?.folder);
  if (!USER_ID.test(discord)) return problem("That is not a Discord user ID.", 422, { fields: { discord: "17 to 20 digits. In Discord, right-click the person and Copy User ID." } });
  if (username && !USERNAME.test(username)) {
    return problem("That is not a Discord username.", 422, { fields: { username: "2 to 32 lowercase letters, numbers, dots or underscores. Leave it empty if you do not know it." } });
  }
  if (!link || link.kind !== "folder") return problem("That is not a Drive folder link.", 422, { fields: { folder: "Paste a https://drive.google.com/drive/folders/ link." } });

  const store = charters();
  if (await store.get(link.id, { type: "json" })) return problem("That folder is already verified.", 409, { fields: { folder: "Already verified." } });
  try {
    await listCharts(link.id, Date.now() + 8_000);
  } catch {
    return problem("That folder is not shared publicly.", 422, { fields: { folder: "Drive would not show this folder. It needs \"Anyone with the link\"." } });
  }
  const charter = { id: link.id, discord, username, folderUrl: folderUrl(link.id), addedAt: new Date().toISOString(), applicationId: null };
  await store.setJSON(charter.id, charter);
  const role = await setVerifiedRole(discord, true, `Verified charter, added by ${admin.name}`);
  return json({ charter, role });
}

/**
 * Takes a folder off the list, and the role with it unless the same person still
 * has another verified folder: the role belongs to the person, not the folder.
 */
async function removeCharter(id, admin) {
  const store = charters();
  const gone = await store.get(id, { type: "json" });
  await store.delete(id);
  await dropCharter(id);
  if (!gone?.discord) return json({ ok: true, role: "not-an-id" });
  const others = (await allJson(store)).some((c) => c.discord === gone.discord);
  const role = others ? "kept" : await setVerifiedRole(gone.discord, false, `Removed from verified charters by ${admin.name}`);
  return json({ ok: true, role });
}

const relayConfigured = () => Boolean(env("VIDEO_RELAY_URL") && env("VIDEO_RELAY_SECRET"));

async function videoOverview() {
  const chosen = await currentCharterVideo();
  return json({ chosen, meta: await keptVideoMeta(chosen.id), relay: relayConfigured() });
}

/** A YouTube id out of the request body's link, or a 422 naming the field. */
async function linkedVideo(req) {
  const body = await readJson(req);
  const id = parseYouTubeId(body?.link);
  if (!id) return { error: problem("That is not a YouTube link.", 422, { fields: { link: "Paste a youtube.com or youtu.be link to one video." } }) };
  return { id };
}

async function readVideo(id, options) {
  try {
    return { meta: (await refreshVideoMeta(id, undefined, options)).meta };
  } catch (err) {
    return { error: problem(`YouTube would not describe that video: ${err.message}`, 422, { fields: { link: "Is it public, and does it allow embedding?" } }) };
  }
}

async function videoRoute(req, action, admin) {
  if (req.method === "GET" && !action) return videoOverview();
  if (req.method !== "POST") return null;

  if (action === "reread") {
    const chosen = await currentCharterVideo();
    const { meta, error } = await readVideo(chosen.id, { reread: true });
    if (error) return error;
    await purgeVideoCache(chosen.id);
    return json({ chosen, meta, relay: relayConfigured() });
  }

  const { id, error } = await linkedVideo(req);
  if (error) return error;
  const read = await readVideo(id);
  if (read.error) return read.error;

  if (action === "look") return json({ meta: read.meta, relay: relayConfigured() });
  if (!action) {
    const previous = await currentCharterVideo();
    const chosen = await setCharterVideo(id, admin);
    await purgeVideoCache(id);
    if (previous.id !== id) await purgeVideoCache(previous.id);
    return json({ chosen, meta: read.meta, relay: relayConfigured() });
  }
  return null;
}

async function route(req, context, admin) {
  const parts = new URL(req.url).pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [section, id, action] = parts;

  if (section === "overview" && req.method === "GET") return overview(admin);

  if (section === "applications" && id) {
    if (req.method === "POST" && ["accept", "decline", "recount"].includes(action)) return decide(id, action, admin);
    if (req.method === "DELETE" && !action) {
      const app = await applications().get(id, { type: "json" });
      if (app?.status === "pending") return problem("Decide on a pending application before removing it.", 409);
      await applications().delete(id);
      return json({ ok: true });
    }
  }

  if (section === "charters") {
    if (req.method === "POST" && !id) return addCharter(req, admin);
    if (req.method === "DELETE" && id) return removeCharter(id, admin);
  }

  // Reading a Discord account is a read, but it goes through the admin gate
  // like everything else here: it spends the site's bot token, and nobody but
  // an admin has any business pointing it at an arbitrary ID.
  if (section === "discord") {
    if (req.method === "GET" && id) return json({ profile: await profileFor(id, { fresh: action === "fresh" }) });
    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 60) : [];
      return json({ profiles: await profilesFor(ids) });
    }
  }

  if (section === "video") {
    const answer = await videoRoute(req, id, admin);
    if (answer) return answer;
  }

  if (section === "refresh" && req.method === "POST") {
    const body = await readJson(req);
    return json(await refreshPass({ start: !!body?.start, trigger: `admin: ${admin.name}` }));
  }

  return problem("Not found.", 404);
}

export default adminOnly(async (req, context, admin) => {
  try {
    return await route(req, context, admin);
  } catch (err) {
    console.error("admin request failed", err);
    return problem(`Something went wrong: ${err.message}`, 500);
  }
});

export const config = { path: "/api/admin/*" };
