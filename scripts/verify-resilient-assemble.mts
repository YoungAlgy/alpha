// Verify generateIssue is resilient to a single failing topic: mix one invalid
// topic (throws "Unknown topic" inside generation) with valid ones and confirm
// the letter still ships with the valid sections. Since the generic-fallback
// tail (buildGenerationPool) now backfills the slot the invalid topic left
// open, the letter fills to the reader's full pool size (3) rather than
// coming up short at 2 — that backfill is the intended behavior, not a
// regression, so this asserts >= 2 (the originally-valid topics always
// present) and that any 3rd section, if present, came from the fallback tail.
// Run: npx tsx scripts/verify-resilient-assemble.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { generateIssue } = await import("../lib/engine/assemble.ts");
const { GENERIC_FALLBACK_TOPICS } = await import("../lib/topics.ts");

function weekOfNow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// 2 valid topics + 1 bogus. Bogus throws inside generateTopicBlurb → rejected.
const profile = {
  firstName: "Test",
  city: "",
  topics: ["ai-news", "definitely-not-a-real-topic", "books-worth-your-time"] as never,
  theme: "forest" as never,
  email: undefined,
};

console.log("Generating with 2 valid + 1 invalid topic (forcing a partial failure)...");
try {
  const issue = await generateIssue(profile, weekOfNow());
  const ids = issue.sections.map((s) => s.topicId);
  const gotAiNews = ids.includes("ai-news");
  const gotBooks = ids.includes("books-worth-your-time");
  const gotInvalid = ids.includes("definitely-not-a-real-topic");
  // The invalid slot may get backfilled from the generic-fallback tail (see
  // buildGenerationPool) — that's the intended daily-completeness behavior,
  // not a regression, so 3 sections is fine as long as the 2 real ones are
  // both present, the invalid topic never made it in, and any extra section
  // came from the fallback tail rather than somewhere unexpected.
  const extras = ids.filter((id) => id !== "ai-news" && id !== "books-worth-your-time");
  const extrasAreFallback = extras.every((id) => GENERIC_FALLBACK_TOPICS.includes(id));
  const ok = gotAiNews && gotBooks && !gotInvalid && ids.length >= 2 && ids.length <= 3 && extrasAreFallback;
  console.log(`Sections returned: ${issue.sections.length} (${ids.join(", ")})`);
  console.log(`Editor intro present: ${!!issue.editorIntro && issue.editorIntro.length > 20}`);
  console.log(`\n=== RESILIENCE ${ok ? "HOLDS ✓ (letter shipped despite a failed topic)" : "FAILED ✗"} ===`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`Whole letter threw (should NOT happen with 2 valid topics): ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
