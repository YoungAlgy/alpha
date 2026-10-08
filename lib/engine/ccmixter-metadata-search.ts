import type { BraveResult, BraveSearchOptions } from "@/lib/brave";
import { cleanField } from "./text-clean";
import { directChildValues, rssItemBlocks } from "./rss-xml";
import { createPublicSourceCache } from "./public-source-cache";
import { parsePublicSourceTimestamp, publicSourceWindow } from "./public-source-freshness";
import { readPublicSourceText } from "./public-source-response";
import { durablePublicSourceBudgetEnabled, reservePublicSourceRequest } from "./public-source-budget";
import { durablePublicSourceCircuitEnabled, runPublicSourceAttempt, type PublicSourceAttempt } from "./public-source-circuit";
import { noModelModeEnabled } from "./provider-policy";

const ENDPOINT = "https://ccmixter.org/api/query?f=rss&reqtags=remix&tags=hip_hop&sort=date&limit=10";
const PROVIDER = "ccmixter-uploads";
const MAX_RECORDS = 10;
const ACCEPT = "application/rss+xml, application/xml, text/xml";

type Upload = { title: string; url: string; creator: string; uploadedAt: string };

export function ccmixterMetadataFallbackEnabled(): boolean {
  return noModelModeEnabled() &&
    /^(1|true|yes)$/i.test(process.env.ALPHA_CCMIXTER_METADATA_FALLBACK?.trim() ?? "") &&
    durablePublicSourceBudgetEnabled() && durablePublicSourceCircuitEnabled();
}

function safeText(value: string, maxRaw: number, maxClean: number): string | null {
  if (!value || value.length > maxRaw || /[\x00-\x1f\x7f]/.test(value)) return null;
  const clean = cleanField(value).replace(/\s+/g, " ").trim();
  return clean && clean.length <= maxClean ? clean : null;
}

function canonicalTrackUrl(value: string): string | null {
  if (value.length > 300 || !/^https:\/\/ccmixter\.org\/files\/[A-Za-z0-9_.-]+\/[1-9]\d*$/.test(value)) return null;
  try {
    const url = new URL(value);
    const username = url.pathname.split("/")[2];
    if (username === "." || username === ".." || url.href !== value || url.protocol !== "https:" ||
        url.hostname !== "ccmixter.org" || url.username || url.password || url.port || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function isHipHopRemix(categories: string[]): boolean {
  if (!categories.length || categories.length > 20 || categories.some(value => value.length > 200)) return false;
  const tags = new Set(categories.flatMap(value => value.split(",").map(tag => tag.trim().toLowerCase())));
  return tags.has("hip_hop") && tags.has("remix");
}

function openingCount(block: string, tag: string): number {
  // A match inside CDATA can only reject a record. It cannot create a field.
  return block.match(new RegExp(`<\\s*${tag}(?=\\s|/?>)`, "gi"))?.length ?? 0;
}

function singleDirectField(block: string, tag: string): string | null {
  // Count opening tags as well as decoded values. Empty duplicates must not
  // turn one valid metadata field into an apparently unique field.
  if (openingCount(block, tag) !== 1) return null;
  const values = directChildValues(block, tag, true, "ccMixter RSS");
  return values.length === 1 ? values[0]! : null;
}

/** Parse only feed metadata. Descriptions, media, artwork and license claims are ignored. */
function parseCcmixterUploads(xml: string): Upload[] {
  const uploads: Upload[] = [];
  const seen = new Set<string>();
  for (const block of rssItemBlocks(xml, MAX_RECORDS, "ccMixter RSS")) {
    const titleField = singleDirectField(block, "title");
    const linkField = singleDirectField(block, "link");
    const dateField = singleDirectField(block, "pubdate");
    const creatorField = singleDirectField(block, "dc:creator");
    if (!titleField || !linkField || !dateField || !creatorField) continue;
    if (openingCount(block, "category") > 20) continue;
    const categories = directChildValues(block, "category", true, "ccMixter RSS");
    if (!isHipHopRemix(categories)) continue;
    const title = safeText(titleField, 1000, 300);
    const creator = safeText(creatorField, 500, 160);
    const url = canonicalTrackUrl(linkField);
    const uploadedAt = parsePublicSourceTimestamp(dateField);
    if (!title || !creator || !url || !Number.isFinite(uploadedAt) || seen.has(url)) continue;
    seen.add(url);
    uploads.push({ title, url, creator, uploadedAt: new Date(uploadedAt).toISOString() });
  }
  return uploads;
}

export function createCcmixterMetadataSearch(deps: {
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: typeof reservePublicSourceRequest;
  attempt?: PublicSourceAttempt;
} = {}) {
  const fetcher = deps.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const reserve = deps.reserve ?? reservePublicSourceRequest;
  const attempt = deps.attempt ?? runPublicSourceAttempt;
  const cached = createPublicSourceCache<Upload>(now);

  return async function ccmixterMetadataSearch(topicId: string, opts: BraveSearchOptions = {}): Promise<BraveResult[]> {
    if (topicId !== "music-hiphop" || !ccmixterMetadataFallbackEnabled()) return [];
    if (!publicSourceWindow(opts.freshness, now())) return [];
    const uploads = await cached(PROVIDER, "fixed-hip-hop-remix-v1", () => attempt(PROVIDER,
      () => reserve(PROVIDER), async () => {
        const signal = AbortSignal.timeout(5000);
        const response = await fetcher(ENDPOINT, {
          signal, redirect: "error", credentials: "omit", cache: "no-store",
          headers: { Accept: ACCEPT },
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error(`ccMixter RSS ${response.status}`);
        }
        // Like the existing fixed publisher feeds, admit by the bounded strict
        // XML envelope and fields. The qualification did not record a MIME
        // header, so do not introduce an unproven header compatibility gate.
        return parseCcmixterUploads(await readPublicSourceText(response, signal));
      }));
    // Upload date is only a ccMixter feed fact, not the track's first release date.
    // Recheck against the current clock and requested window on every cache read.
    const window = publicSourceWindow(opts.freshness, now());
    if (!window) return [];
    return uploads.filter(upload => {
      const date = parsePublicSourceTimestamp(upload.uploadedAt);
      return Number.isFinite(date) && date >= window.start && date <= window.end;
    }).map(upload => ({
      title: `Community remix: ${upload.title}`,
      url: upload.url,
      description: `Credited creator: ${upload.creator}. Uploaded to ccMixter ${upload.uploadedAt.slice(0, 10)}. Tagged hip-hop.`,
      age: upload.uploadedAt,
    }));
  };
}

export const ccmixterMetadataSearch = createCcmixterMetadataSearch();
