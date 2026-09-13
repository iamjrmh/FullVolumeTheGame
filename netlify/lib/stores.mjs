// Everything the functions keep, in Netlify Blobs.
//
//   charter-applications  <id>            one application, JSON
//   verified-charters     <drive folder>  one verified charter, JSON
//   community-charts      index           the listing the Marketplace reads
//                         refresh         a sweep in progress, if any
//                         cover/<file id> album art cut out of a chart
//   rate-limits           apply/<ip hash>/<day>
//
// Strong consistency throughout: an admin accepts a charter and presses
// refresh a second later, and that refresh has to see the charter.

import { getStore } from "@netlify/blobs";

const open = (name) => getStore({ name, consistency: "strong" });

export const applications = () => open("charter-applications");
export const charters = () => open("verified-charters");
export const community = () => open("community-charts");
export const rateLimits = () => open("rate-limits");

/** Every JSON document in a store, in no particular order. */
export async function allJson(store) {
  const { blobs } = await store.list();
  const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return docs.filter(Boolean);
}
