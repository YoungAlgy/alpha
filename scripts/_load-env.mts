// Shared by every scripts/verify-*.mts / scripts/*.mts one-off: loads
// .env.local into process.env so these scripts can run standalone via
// `npx tsx scripts/whatever.mts` outside Next.js's own env loading.
//
// Extracted 2026-08-05 (adversarial audit finding: 20 scripts had carried an
// identical copy of this exact loop). Deliberately NOT Next's own env
// loader (@next/env's loadEnvConfig) -- these scripts need only this one
// file, run standalone, and the duplicated loop already proved sufficient
// for years of use; swapping the mechanism wasn't worth the risk of
// changing behavior across 20 call sites in the same pass as deduplicating
// them. Purely mechanical: same regex, same quote-strip, same silent-skip
// on a non-matching line.
import { readFileSync } from "node:fs";

// alpha-drift-r14-11 (found live, 2026-08-06): every caller of this
// function assumed .env.local exists -- true for every LOCAL dev run, but
// the first script ever invoked directly from a GitHub Actions workflow
// (scripts/reconcile-stripe-vs-supabase.mts, via `npx tsx` in
// stripe-reconcile.yml) hit this for real: .env.local is gitignored, never
// checked out on a runner, and CI supplies every var directly through the
// workflow's own env: block instead. A missing file in THAT case isn't an
// error, it's the normal, correct state -- the vars this function would
// have loaded are already set. Only ENOENT specifically is swallowed; any
// other read failure (a real permissions problem, a corrupt file) still
// throws, since silently ignoring THOSE would hide a genuine local-dev bug.
export function loadEnvLocal(path = ".env.local"): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return;
    throw e;
  }
  for (const line of contents.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
