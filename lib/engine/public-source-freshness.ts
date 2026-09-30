import type { BraveResult, BraveSearchOptions } from "@/lib/brave";

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
    const date = Date.parse(result.age ?? "");
    try {
      const url = new URL(result.url);
      return Number.isFinite(date) && date >= window.start && date <= window.end &&
        url.protocol === "https:" && !url.username && !url.password && !url.port &&
        url.hostname.includes(".") && !url.hostname.endsWith(".local") &&
        !/^\d+(?:\.\d+){3}$/.test(url.hostname) && !url.hostname.includes(":");
    } catch { return false; }
  }).map((result) => ({ ...result }));
}
