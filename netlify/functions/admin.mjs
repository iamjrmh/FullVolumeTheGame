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

import { folderUrl, listCharts, parseDriveLink } from "../lib/fvchart.mjs";
import { json, problem, readJson } from "../lib/http.mjs";
import { currentProgress, dropCharter, readIndex, refreshPass } from "../lib/refresh.mjs";
import { adminOnly } from "../lib/session.mjs";
import { allJson, applications, charters } from "../lib/stores.mjs";

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
    const charter = {
      id: app.folderId,
      discord: app.discord,
      folderUrl: app.folderUrl,
      addedAt: app.decidedAt,
      applicationId: app.id,
    };
    await charters().setJSON(charter.id, charter);
  }
  await store.setJSON(id, app);
  return json({ application: app });
}

async function addCharter(req) {
  const body = await readJson(req);
  const discord = String(body?.discord ?? "").trim().replace(/^@/, "").toLowerCase();
  const link = parseDriveLink(body?.folder);
  if (!USERNAME.test(discord)) return problem("That is not a Discord username.", 422, { fields: { discord: "2 to 32 lowercase letters, numbers, dots or underscores." } });
  if (!link || link.kind !== "folder") return problem("That is not a Drive folder link.", 422, { fields: { folder: "Paste a https://drive.google.com/drive/folders/ link." } });

  const store = charters();
  if (await store.get(link.id, { type: "json" })) return problem("That folder is already verified.", 409, { fields: { folder: "Already verified." } });
  try {
    await listCharts(link.id, Date.now() + 8_000);
  } catch {
    return problem("That folder is not shared publicly.", 422, { fields: { folder: "Drive would not show this folder. It needs \"Anyone with the link\"." } });
  }
  const charter = { id: link.id, discord, folderUrl: folderUrl(link.id), addedAt: new Date().toISOString(), applicationId: null };
  await store.setJSON(charter.id, charter);
  return json({ charter });
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
    if (req.method === "POST" && !id) return addCharter(req);
    if (req.method === "DELETE" && id) {
      await charters().delete(id);
      await dropCharter(id);
      return json({ ok: true });
    }
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
