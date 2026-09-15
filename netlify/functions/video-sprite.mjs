// GET /api/video-sprite/<youtube id>/<sheet>
//
// One storyboard sprite sheet, copied off YouTube by lib/videometa.mjs. The URL
// the video function hands out carries a version, so the copy is immutable.

import { videoSprites } from "../lib/stores.mjs";
import { problem } from "../lib/http.mjs";

const ID_PATTERN = /^[\w-]{11}$/;
const SHEET_PATTERN = /^\d{1,3}$/;

export default async function handler(req, context) {
  const { id, sheet } = context.params;
  if (!ID_PATTERN.test(id) || !SHEET_PATTERN.test(sheet)) return problem("Unknown sprite sheet", 404);

  const found = await videoSprites().getWithMetadata(`${id}/${sheet}`, { type: "arrayBuffer" });
  if (!found) return problem("Unknown sprite sheet", 404);

  return new Response(found.data, {
    status: 200,
    headers: {
      "Content-Type": found.metadata?.contentType || "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export const config = { path: "/api/video-sprite/:id/:sheet", method: ["GET"] };
