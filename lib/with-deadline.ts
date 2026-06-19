// Race a promise against a hard deadline. On timeout it REJECTS with a labeled
// error; the underlying promise keeps running detached (callers rely on its own
// internal I/O timeouts to bound it) but we stop WAITING for it. Used to keep a
// single slow letter generation from blowing a route's maxDuration or the cron
// budget, so it fails fast and deterministically into the caller's own
// retry/fallback instead of waiting for the platform's hard kill.
//
// Promise.race attaches a rejection handler to `p`, so a late rejection from the
// detached promise is NOT an unhandled rejection. clearTimeout runs on both the
// resolve and reject paths via .finally (a no-op on an already-fired timer).
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms deadline`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer!));
}
