import { createPublicSourceCache } from "./public-source-cache";
import { directChildValues, rssItemBlocks } from "./rss-xml";
import { MAX_PUBLIC_SOURCE_BYTES } from "./public-source-response";

type FeedSnapshot = { xml: string; hasUsableItems: boolean };

// Only call after the 256 KiB response reader. Validate the entire envelope
// inside the provider attempt, before recording success or caching its text.
export function publicFeedSnapshot(
  xml: string,
  label: string,
  hasUsableItems: boolean,
  metadata: "search" | "publisher" | "licensed",
): FeedSnapshot {
  const blocks = rssItemBlocks(xml, Number.MAX_SAFE_INTEGER, label);
  const tags = ["title", "link", "pubdate",
    ...(metadata === "search" ? ["description"] : []),
    ...(metadata === "licensed" ? ["dc:creator", "category"] : [])];
  const encode = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const text = blocks.map((block) => {
    const fields = tags.flatMap((tag) => directChildValues(block, tag, true, label)
      .slice(0, tag === "category" ? 20 : 1).map((value) => `<${tag}>${encode(value)}</${tag}>`)).join("");
    return fields ? `<item>${fields}</item>` : "";
  }).join("");
  // Keep only adapter-owned metadata. Article bodies, media and channel text
  // are discarded before caching. Escaping prevents a field creating markup.
  const snapshot = `<rss><channel>${text}</channel></rss>`;
  if (new TextEncoder().encode(snapshot).byteLength > MAX_PUBLIC_SOURCE_BYTES) {
    throw new Error(`${label} metadata snapshot too large`);
  }
  return { xml: snapshot, hasUsableItems: blocks.length > 0 && hasUsableItems };
}

// One byte-bounded public feed per key. Date/topic/reader filters are applied
// on each read, so rejected metadata cannot consume the 100 usable-item cap,
// narrower windows do not poison wider ones, and publication times can mature.
// A feed with no usable metadata retains the one-minute TTL. Other snapshots
// last five minutes. The caller supplies eligibility without topic/reader filters.
export function createPublicFeedCache(now: () => number = Date.now) {
  return createPublicSourceCache<FeedSnapshot>(now,
    (items) => items[0]?.hasUsableItems ? 5 * 60_000 : 60_000);
}
