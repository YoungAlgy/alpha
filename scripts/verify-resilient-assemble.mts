// Verify generateIssue is resilient to a single failing topic: mix one invalid
// topic (throws "Unknown topic" inside generation) with valid ones and confirm
// the letter still ships with the valid sections.
// Run: npx tsx scripts/verify-resilient-assemble.mts
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { generateIssue } = await import("../lib/engine/assemble.ts");

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
  const ok = issue.sections.length === 2;
  console.log(`Sections returned: ${issue.sections.length} (${issue.sections.map((s) => s.topicId).join(", ")})`);
  console.log(`Editor intro present: ${!!issue.editorIntro && issue.editorIntro.length > 20}`);
  console.log(`\n=== RESILIENCE ${ok ? "HOLDS ✓ (letter shipped despite a failed topic)" : "FAILED ✗"} ===`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`Whole letter threw (should NOT happen with 2 valid topics): ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
