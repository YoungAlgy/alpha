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

export function loadEnvLocal(path = ".env.local"): void {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
