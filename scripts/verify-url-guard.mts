// One-off verification of the code-level real-URL guard.
// Runs a REAL generation (Brave signal + Claude) and asserts that every URL in
// the output is actually present in the signal — i.e. the guard holds. Also
// runs a negative test (an injected invented URL must be dropped).
//
// Run: npx tsx scripts/verify-url-guard.mts
import { readFileSync } from "node:fs";

// Load .env.local into process.env (standalone scripts don't get Next's env).
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
const { extractSignalUrls, isAllowedUrl, enforceSignalUrls } = await import(
  "../lib/engine/url-guard.ts"
);

function weekOfNow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

const topic = process.argv[2] || "ai-news";
const weekOf = weekOfNow();
console.log(`\n=== Generating "${topic}" for week ${weekOf} (real Brave + Claude) ===\n`);

const signal = await resolveTopicSignal(topic as never, weekOf);
if (!signal) {
  console.error("NO SIGNAL — aborting");
  process.exit(1);
}
const allowed = extractSignalUrls(signal.context);
console.log(`Signal has ${allowed.size} distinct real URLs.`);

const blurb = await generateTopicBlurb(topic as never, weekOf, signal);

// Assert: every URL in the generated blurb is in the signal allow-set.
let total = 0;
let violations = 0;
for (const it of blurb.items) {
  const urls = [
    it.primaryRef?.url,
    ...(it.supplementaryRefs?.map((r) => r.url) || []),
  ].filter(Boolean) as string[];
  for (const u of urls) {
    total++;
    const ok = isAllowedUrl(u, allowed);
    if (!ok) {
      violations++;
      console.error(`  ✗ VIOLATION — URL not in signal: ${u}`);
    }
  }
}
console.log(`\nGenerated ${blurb.items.length} items, ${total} surviving URLs, ${violations} provenance violations.`);

// Negative test: inject an obviously-invented URL and confirm the guard drops it.
const injected = enforceSignalUrls(
  [{ primaryRef: { label: "fake", url: "https://this-domain-was-invented-9z9z.example/fake" } }],
  allowed
);
const negOk = injected.items[0].primaryRef === undefined && injected.dropped === 1;
console.log(`Negative test (invented URL dropped): ${negOk ? "PASS ✓" : "FAIL ✗"}`);

// Resolve-check up to 3 surviving URLs (HEAD).
const survivors = blurb.items.flatMap((it) => [
  it.primaryRef?.url,
  ...(it.supplementaryRefs?.map((r) => r.url) || []),
]).filter(Boolean).slice(0, 3) as string[];
console.log(`\nResolve-check ${survivors.length} surviving links:`);
for (const u of survivors) {
  try {
    const res = await fetch(u, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
    console.log(`  ${res.status} ${u}`);
  } catch (e) {
    console.log(`  ERR ${u} — ${e instanceof Error ? e.message : e}`);
  }
}

const pass = violations === 0 && negOk;
console.log(`\n=== GUARD ${pass ? "HOLDS ✓" : "FAILED ✗"} ===`);
process.exit(pass ? 0 : 1);
