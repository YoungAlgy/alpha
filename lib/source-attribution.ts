import type { SourceAttribution } from "./types";
import { cleanField } from "./engine/text-clean";

export const GLOBAL_VOICES_LICENSE_URL = "https://creativecommons.org/licenses/by/3.0/";
export const GLOBAL_VOICES_LICENSE_LABEL = "CC BY 3.0";
export const GLOBAL_VOICES_CHANGES_NOTE = "Headline formatted from source metadata.";
export const PLOS_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
export const PLOS_LICENSE_LABEL = "CC BY 4.0";

/** Only first-party PLOS journal article links with a matching published DOI. */
export function validatedPlosAttribution(url: unknown, author: unknown, publishedAt: unknown): SourceAttribution | undefined {
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
export function validatedGlobalVoicesAttribution(url: unknown, author: unknown, publishedAt: unknown): SourceAttribution | undefined {
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
  if (!value || typeof value !== "object") return;
  const credit = value as Record<string, unknown>;
  const validated = credit.publisher === "global-voices"
    ? validatedGlobalVoicesAttribution(url, credit.author, credit.publishedAt)
    : credit.publisher === "plos" ? validatedPlosAttribution(url, credit.author, credit.publishedAt) : undefined;
  return validated && validated.author === credit.author && validated.publishedAt === credit.publishedAt ? validated : undefined;
}

/** Attribution is separate from story references and their repeat/citation sets. */
export function sourceAttributionCredit(url: unknown, value: unknown) {
  const credit = validatedSourceAttribution(url, value);
  if (!credit) return;
  return {
    articleUrl: url as string,
    author: credit.author,
    date: credit.publishedAt.slice(0, 10),
    publisherLabel: credit.publisher === "plos" ? "PLOS" : "Global Voices",
    licenseUrl: credit.publisher === "plos" ? PLOS_LICENSE_URL : GLOBAL_VOICES_LICENSE_URL,
    licenseLabel: credit.publisher === "plos" ? PLOS_LICENSE_LABEL : GLOBAL_VOICES_LICENSE_LABEL,
    changes: GLOBAL_VOICES_CHANGES_NOTE,
  };
}
