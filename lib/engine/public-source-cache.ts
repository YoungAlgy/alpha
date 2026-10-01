import type { BraveResult } from "@/lib/brave";
import { isPublicSourceControlError, PublicSourceControlError } from "./public-source-error-policy";

// A small per-process acceleration cache, never authoritative cross-run state.
// Only successful, validated raw metadata is cached. Caller applies current
// date bounds and per-reader exclusions after retrieval. No query is logged.
export function createPublicSourceCache(now: () => number = Date.now) {
  const cache = new Map<string, { until: number; items: BraveResult[] }>();
  const active = new Map<string, Promise<BraveResult[]>>();
  const failures = new Map<string, { until: number; count: number }>();
  return async (provider: string, key: string, work: () => Promise<BraveResult[]>): Promise<BraveResult[]> => {
    const identity = `${provider}|${key}`;
    const cached = cache.get(identity);
    if (cached && cached.until > now()) return cached.items.map((item) => ({ ...item }));
    cache.delete(identity);
    const pending = active.get(identity);
    if (pending) return (await pending).map((item) => ({ ...item }));
    if ((failures.get(provider)?.until ?? 0) > now()) throw new PublicSourceControlError("Public source cooling down");
    if (active.size >= 8) throw new PublicSourceControlError("Public source request capacity reached");
    // Start in a microtask so inFlight is set before even synchronous failures.
    const task = Promise.resolve().then(work).then((items) => {
      cache.set(identity, { until: now() + (items.length ? 5 * 60_000 : 60_000), items: items.map((item) => ({ ...item })) });
      while (cache.size > 64) cache.delete(cache.keys().next().value!);
      // An earlier concurrent success must not erase a later failure cooldown.
      const failure = failures.get(provider);
      if (!failure || failure.until <= now()) failures.delete(provider);
      return items;
    }).catch((error) => {
      if (!isPublicSourceControlError(error)) {
        const count = Math.min(5, (failures.get(provider)?.count ?? 0) + 1);
        failures.set(provider, { count, until: now() + Math.min(15 * 60_000, 60_000 * 2 ** (count - 1)) });
      }
      throw error;
    });
    active.set(identity, task);
    try { return (await task).map((item) => ({ ...item })); }
    finally { if (active.get(identity) === task) active.delete(identity); }
  };
}
