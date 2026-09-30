import type { SourceAttribution } from "./types";
import { cleanField } from "./engine/text-clean";

export const GLOBAL_VOICES_LICENSE_URL = "https://creativecommons.org/licenses/by/3.0/";
export const GLOBAL_VOICES_LICENSE_LABEL = "CC BY 3.0";
export const GLOBAL_VOICES_CHANGES_NOTE = "Headline formatted from source metadata.";

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
  if (credit.publisher !== "global-voices") return;
  const validated = validatedGlobalVoicesAttribution(url, credit.author, credit.publishedAt);
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
    licenseUrl: GLOBAL_VOICES_LICENSE_URL,
    licenseLabel: GLOBAL_VOICES_LICENSE_LABEL,
    changes: GLOBAL_VOICES_CHANGES_NOTE,
  };
}
