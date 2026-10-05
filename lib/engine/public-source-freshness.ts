import type { BraveResult, BraveSearchOptions } from "@/lib/brave";

const RSS_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RSS_ZONE_MINUTES: Readonly<Record<string, number>> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0,
  EST: -300, EDT: -240, CST: -360, CDT: -300,
  MST: -420, MDT: -360, PST: -480, PDT: -420,
};

/** Complete ISO/RSS timestamps only. Date.parse silently rolls impossible days forward. */
export function parsePublicSourceTimestamp(value: unknown): number {
  if (typeof value !== "string" || value.length > 128) return NaN;
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/i);
  const rss = iso ? null : raw.match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(UT|UTC|GMT|Z|[ECMP][SD]T|[+-]\d{2}:?\d{2})$/i);
  if (!iso && !rss) return NaN;
  const year = Number(iso ? iso[1] : rss![3]);
  const month = iso ? Number(iso[2]) : RSS_MONTHS.indexOf(rss![2].toLowerCase()) + 1;
  const day = Number(iso ? iso[3] : rss![1]);
  const hour = Number(iso ? iso[4] : rss![4]);
  const minute = Number(iso ? iso[5] : rss![5]);
  const second = Number((iso ? iso[6] : rss![6]) ?? "0");
  const millisecond = iso?.[7] ? Number(iso[7].slice(0, 3).padEnd(3, "0")) : 0;
  const zone = (iso ? iso[8] : rss![7]).toUpperCase();
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;

  let offsetMinutes = RSS_ZONE_MINUTES[zone];
  if (offsetMinutes === undefined) {
    const offset = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!offset || Number(offset[2]) > 23 || Number(offset[3]) > 59) return NaN;
    offsetMinutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
  }
  // Check the source's calendar before applying its zone, which can cross a UTC day.
  // setUTCFullYear also avoids Date.UTC's special treatment of years below 100.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return NaN;
  calendar.setUTCHours(hour, minute, second, millisecond);
  return calendar.getTime() - offsetMinutes * 60_000;
}

/** Date bounds are checked locally. A search operator is not freshness proof. */
export function publicSourceWindow(freshness: BraveSearchOptions["freshness"], now = Date.now()): { start: number; end: number } | null {
  if (!Number.isFinite(now)) return null;
  const days = !freshness || freshness === "pw" ? 7 : freshness === "pd" ? 1 : freshness === "pm" ? 30 : 0;
  if (days) return { start: now - days * 86_400_000, end: now };
  const match = freshness?.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  const start = Date.parse(`${match[1]}T00:00:00Z`);
  const endDay = Date.parse(`${match[2]}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(endDay) ||
      new Date(start).toISOString().slice(0, 10) !== match[1] ||
      new Date(endDay).toISOString().slice(0, 10) !== match[2] ||
      start < now - 30 * 86_400_000 || endDay < start ||
      match[2] > new Date(now).toISOString().slice(0, 10)) return null;
  return { start, end: Math.min(now, endDay + 86_400_000 - 1) };
}

export function freshPublicResults(results: BraveResult[], freshness: BraveSearchOptions["freshness"], now = Date.now()): BraveResult[] {
  const window = publicSourceWindow(freshness, now);
  if (!window) return [];
  return results.filter((result) => {
    const date = parsePublicSourceTimestamp(result.age);
    try {
      const url = new URL(result.url);
      return Number.isFinite(date) && date >= window.start && date <= window.end &&
        url.protocol === "https:" && !url.username && !url.password && !url.port &&
        url.hostname.includes(".") && !url.hostname.endsWith(".local") &&
        !/^\d+(?:\.\d+){3}$/.test(url.hostname) && !url.hostname.includes(":");
    } catch { return false; }
  }).map((result) => ({ ...result }));
}
