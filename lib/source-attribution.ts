import type { SourceAttribution, AuthoredSourceAttribution, DigestItem } from "./types";
import { cleanField } from "./engine/text-clean";
import { validatedGovUkNewsMetadata, type GovUkNewsMetadata } from "./engine/govuk-news-metadata";
import { validatedStatCanLabourMetadata, type StatCanLabourMetadata } from "./engine/statcan-labour-metadata";

export const GLOBAL_VOICES_LICENSE_URL = "https://creativecommons.org/licenses/by/3.0/";
export const GLOBAL_VOICES_LICENSE_LABEL = "CC BY 3.0";
export const GLOBAL_VOICES_CHANGES_NOTE = "Headline formatted from source metadata.";
export const PLOS_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
export const PLOS_LICENSE_LABEL = "CC BY 4.0";

/** Only first-party PLOS journal article links with a matching published DOI. */
export function validatedPlosAttribution(url: unknown, author: unknown, publishedAt: unknown): AuthoredSourceAttribution | undefined {
  if (typeof url !== "string" || typeof author !== "string" || typeof publishedAt !== "string" ||
      author.length > 200 || /[\x00-\x1f\x7f]/.test(author) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(publishedAt)) return;
  const byline = cleanField(author).replace(/\s+/g, " ").trim();
  const date = Date.parse(publishedAt);
  if (!byline || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== publishedAt.slice(0, 10)) return;
  try {
    const article = new URL(url);
    const journalPaths: Record<string, string> = { pone: "plosone", pmed: "plosmedicine", pdig: "digitalhealth", pmnh: "mentalhealth" };
    const doi = article.searchParams.get("id") ?? "";
    const match = doi.match(/^10\.1371\/journal\.(pone|pmed|pdig|pmnh)\.\d{7}$/);
    if (article.protocol !== "https:" || article.hostname !== "journals.plos.org" ||
        article.username || article.password || article.port || article.hash || !match ||
        article.pathname !== `/${journalPaths[match[1]]}/article` ||
        [...article.searchParams.keys()].length !== 1 || article.searchParams.getAll("id").length !== 1) return;
    return { publisher: "plos", author: byline, publishedAt: new Date(date).toISOString() };
  } catch { return; }
}

/** Fixed publisher and article boundaries also apply when reading saved JSON. */
export function validatedGlobalVoicesAttribution(url: unknown, author: unknown, publishedAt: unknown): AuthoredSourceAttribution | undefined {
  if (typeof url !== "string" || typeof author !== "string" || typeof publishedAt !== "string" ||
      author.length > 200 || !/(?:T\d{2}:\d{2}:\d{2}|\b\d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2})/.test(publishedAt)) return;
  const byline = cleanField(author).replace(/\s+/g, " ").trim();
  if (!byline || /[\x00-\x1f\x7f]/.test(author)) return;
  const date = Date.parse(publishedAt);
  if (!Number.isFinite(date)) return;
  const isoDay = publishedAt.match(/^(\d{4}-\d{2}-\d{2})T/);
  const rfcDay = publishedAt.match(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) /i);
  const day = isoDay?.[1] ?? (rfcDay ? `${rfcDay[3]}-${String(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(rfcDay[2].toLowerCase()) + 1).padStart(2, "0")}-${rfcDay[1].padStart(2, "0")}` : "");
  if (!day || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return;
  try {
    const article = new URL(url);
    const pathDay = article.pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+\/$/);
    if (article.protocol !== "https:" || article.hostname !== "globalvoices.org" ||
        article.username || article.password || article.port || article.search || article.hash ||
        !pathDay) return;
    const pathDate = `${pathDay[1]}-${pathDay[2]}-${pathDay[3]}`;
    const pathTime = Date.parse(`${pathDate}T00:00:00Z`);
    if (!Number.isFinite(pathTime) || new Date(pathTime).toISOString().slice(0, 10) !== pathDate) return;
    return { publisher: "global-voices", author: byline, publishedAt: new Date(date).toISOString() };
  } catch { return; }
}

export function validatedSourceAttribution(url: unknown, value: unknown): SourceAttribution | undefined {
  try {
    if (!value || typeof value !== "object") return;
    const credit = value as Record<string, unknown>;
    const publisher = Object.getOwnPropertyDescriptor(value, "publisher");
    if (!publisher || !("value" in publisher)) return;
    if (publisher.value === "Statistics Canada") return validatedStatCanAttribution(url, value);
    if (credit.publisher === "govuk") return validatedGovUkAttribution(url, value);
    const validated = credit.publisher === "global-voices"
      ? validatedGlobalVoicesAttribution(url, credit.author, credit.publishedAt)
      : credit.publisher === "plos" ? validatedPlosAttribution(url, credit.author, credit.publishedAt) : undefined;
    return validated && validated.author === credit.author && validated.publishedAt === credit.publishedAt ? validated : undefined;
  } catch { return; }
}

export const GOVUK_LICENSE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/";
export const GOVUK_METADATA_CREDIT = "Public metadata credit only. Contains public sector information licensed under the Open Government Licence v3.0.";
export const GOVUK_RIGHTS_NOTE = "This credit does not clear article text, media or third-party rights.";
export const STATCAN_LICENSE_URL = "https://www.statcan.gc.ca/en/terms-conditions/open-licence";
export const STATCAN_NONENDORSEMENT = "This does not constitute an endorsement by Statistics Canada of this product.";
export const STATCAN_RIGHTS_NOTE = "Original headline and link only. Article text, media and third-party material are excluded.";

/** Exact own metadata fields and the original Daily URL are mandatory. */
export function validatedStatCanAttribution(url: unknown, value: unknown): StatCanLabourMetadata | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const fields = ["title", "url", "updatedInstant", "dailyLinkDay", "publisher", "kind", "dateBasis"];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) return;
    const credit = validatedStatCanLabourMetadata(value);
    return credit && url === credit.url ? credit : undefined;
  } catch { return; }
}

function statCanBody(credit: StatCanLabourMetadata): string {
  return `Canadian labour bulletin metadata. Feed entry updated: ${credit.updatedInstant}. Daily link day: ${credit.dailyLinkDay}. Original publication time is unproven.`;
}

/** Retain original title/link and explicit feed update evidence only. */
export function statCanItemFields(record: StatCanLabourMetadata): DigestItem {
  const credit = validatedStatCanAttribution(record.url, record);
  if (!credit) throw new Error("Invalid Statistics Canada source metadata");
  return { kind: "read", headline: credit.title, body: statCanBody(credit),
    primaryRef: { label: credit.title, url: credit.url }, supplementaryRefs: [], attribution: credit };
}

/** Exact story identity and explicit update semantics also survive saved JSON. */
export function validatedGovUkAttribution(url: unknown, value: unknown): GovUkNewsMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const fields = ["title", "url", "publicTimestamp", "format", "publisher", "kind", "timestampMeaning"];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) return;
  const credit = validatedGovUkNewsMetadata(value);
  return credit && url === credit.url ? credit : undefined;
}

function govUkBody(credit: GovUkNewsMetadata): string {
  return `Government announcement. Published or updated: ${credit.publicTimestamp}.`;
}

/** Source-linked metadata only. No excerpt, inferred author or generated claims. */
export function govUkItemFields(record: GovUkNewsMetadata): DigestItem {
  const credit = validatedGovUkNewsMetadata(record);
  if (!credit) throw new Error("Invalid government source metadata");
  return { kind: "read", headline: credit.title, body: govUkBody(credit),
    primaryRef: { label: credit.title, url: credit.url }, supplementaryRefs: [], attribution: credit };
}

/** Metadata credits may not be attached to rewritten text or a different story. */
export function validatedAttributedItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const ref = item.primaryRef && typeof item.primaryRef === "object" && !Array.isArray(item.primaryRef)
    ? item.primaryRef as Record<string, unknown> : undefined;
  if (item.attribution === undefined) {
    // Catch a lost credit in our known metadata-only serialization path while
    // retaining historical generic narratives linked to government pages.
    // Structural validation cannot authenticate wholly fabricated generic data.
    const lostGovUkCredit = typeof ref?.url === "string" && /^https:\/\/www\.gov\.uk\/government\/news\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref.url) &&
      typeof item.body === "string" && item.body.startsWith("Government announcement. Published or updated:");
    const lostStatCanCredit = typeof item.body === "string" &&
      item.body.startsWith("Canadian labour bulletin metadata. Feed entry updated:");
    return !lostGovUkCredit && !lostStatCanCredit;
  }
  const credit = validatedSourceAttribution(ref?.url, item.attribution);
  if (!credit) return false;
  if (credit.publisher !== "govuk" && credit.publisher !== "Statistics Canada") return true;
  return item.kind === "read" && item.headline === credit.title &&
    item.body === (credit.publisher === "govuk" ? govUkBody(credit) : statCanBody(credit)) &&
    ref?.label === credit.title && ref.note === undefined &&
    (item.supplementaryRefs === undefined || Array.isArray(item.supplementaryRefs) && item.supplementaryRefs.length === 0) &&
    item.source === undefined && item.sourceUrl === undefined;
}

/** Attribution is separate from story references and their repeat/citation sets. */
export function sourceAttributionCredit(url: unknown, value: unknown) {
  const credit = validatedSourceAttribution(url, value);
  if (!credit) return;
  if (credit.publisher === "Statistics Canada") return {
    kind: "statcan" as const,
    articleUrl: credit.url,
    originalTitle: credit.title,
    updatedInstant: credit.updatedInstant,
    dailyLinkDay: credit.dailyLinkDay,
    dateBasis: credit.dateBasis,
    publisherLabel: "Statistics Canada",
    licenseUrl: STATCAN_LICENSE_URL,
    licenseLabel: "Statistics Canada Open Licence",
    changes: `Adapted from Statistics Canada, The Daily, ${credit.dailyLinkDay}.`,
    nonendorsement: STATCAN_NONENDORSEMENT,
    limitations: STATCAN_RIGHTS_NOTE,
  };
  if (credit.publisher === "govuk") return {
    kind: "government" as const,
    articleUrl: credit.url,
    originalTitle: credit.title,
    date: credit.publicTimestamp.slice(0, 10),
    publicTimestamp: credit.publicTimestamp,
    publisherLabel: "GOV.UK, United Kingdom",
    licenseUrl: GOVUK_LICENSE_URL,
    licenseLabel: "Open Government Licence v3.0",
    changes: GOVUK_METADATA_CREDIT,
    limitations: GOVUK_RIGHTS_NOTE,
  };
  return {
    kind: "authored" as const,
    articleUrl: url as string,
    author: credit.author,
    date: credit.publishedAt.slice(0, 10),
    publisherLabel: credit.publisher === "plos" ? "PLOS" : "Global Voices",
    licenseUrl: credit.publisher === "plos" ? PLOS_LICENSE_URL : GLOBAL_VOICES_LICENSE_URL,
    licenseLabel: credit.publisher === "plos" ? PLOS_LICENSE_LABEL : GLOBAL_VOICES_LICENSE_LABEL,
    changes: GLOBAL_VOICES_CHANGES_NOTE,
  };
}
