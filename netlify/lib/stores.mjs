// Everything the functions keep, in Netlify Blobs.
//
//   charter-applications  <id>            one application, JSON
//   verified-charters     <drive folder>  one verified charter, JSON
//   community-charts      index           the listing the Marketplace reads
//                         refresh         a sweep in progress, if any
//                         cover/<file id> album art cut out of a chart
//   rate-limits           apply/<ip hash>/<day>
//   discord-profiles      <user id>       a Discord account as last read
//   video-meta            <youtube id>    the best chapters/storyboard/qualities ever read for a video
//   video-sprites         <youtube id>/<n> a storyboard sprite sheet copied off YouTube
//   site-settings         charter-video   which YouTube video the charter page plays
//
// Strong consistency throughout: an admin accepts a charter and presses
// refresh a second later, and that refresh has to see the charter.

import { getStore } from "@netlify/blobs";

// Outside Netlify (tools/seed-video.mjs) the site id and an API token are passed in.
const open = (name, outside = {}) => getStore({ name, consistency: "strong", ...outside });

export const applications = () => open("charter-applications");
export const charters = () => open("verified-charters");
export const community = () => open("community-charts");
export const rateLimits = () => open("rate-limits");
export const discordProfiles = () => open("discord-profiles");
export const videoMeta = (outside) => open("video-meta", outside);
export const videoSprites = (outside) => open("video-sprites", outside);
export const siteSettings = (outside) => open("site-settings", outside);

/** Every JSON document in a store, in no particular order. */
export async function allJson(store) {
  const { blobs } = await store.list();
  const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return docs.filter(Boolean);
}
