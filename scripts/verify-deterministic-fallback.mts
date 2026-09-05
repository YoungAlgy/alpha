import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback.ts";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) return;
  failures++;
  console.error(`FAIL: ${label}`);
}

const signal = {
  topicId: "ai-news" as const,
  weekOf: "2026-08-30",
  citableUrls: new Set([
    "example.com/deep-story",
    "example.org/short-story",
  ]),
  context: `Recent signal for AI: news, releases & tools for work.

=== TOP SOURCES (full text — read these and surface the real insight) ===

[1] A useful model release
    example.com · 1 day ago
    SOURCE: https://example.com/deep-story

The release adds a smaller mode that runs on a laptop and keeps the same API shape.

----------

=== MORE THIS WEEK (headlines + links) ===

- A second useful update (example.org, 2 days ago) — https://example.org/short-story
  The update changes the default timeout for new projects.

- Should be excluded (bad.example, today) — https://example.net/not-citable
  This URL is absent from the resolver allow-set.
`,
};

const blurb = buildDeterministicBlurb(signal);
check("builds a fallback blurb", blurb !== null);
check("keeps only allow-listed source URLs", blurb?.items.length === 2);
check("preserves the deep source title", blurb?.items[0]?.headline === "A useful model release");
check("preserves the deep source URL", blurb?.items[0]?.primaryRef?.url === "https://example.com/deep-story");
check("preserves the headline source URL", blurb?.items[1]?.primaryRef?.url === "https://example.org/short-story");
check("uses read items", blurb?.items.every((item) => item.kind === "read") === true);
check("does not invent supplementary references", blurb?.items.every((item) => (item.supplementaryRefs ?? []).length === 0) === true);

const noSources = buildDeterministicBlurb({
  topicId: "ai-news",
  weekOf: "2026-08-30",
  context: "No citable material here.",
  citableUrls: new Set(),
});
check("returns null when no safe source exists", noSources === null);

const geminiSignal = buildDeterministicBlurb({
  topicId: "ai-news",
  weekOf: "2026-08-30",
  citableUrls: new Set(["example.net/grounded"]),
  context: `Research summary for ai-news (as of 2026-08-30), gathered live via Gemini grounded search.

The grounded answer is available above.

=== SOURCES (real, citable — verified direct links) ===
- Grounded source title — https://example.net/grounded

All URLs listed above are real and citable.`,
});
check("parses Gemini grounded-search source bullets", geminiSignal?.items[0]?.primaryRef?.url === "https://example.net/grounded");

if (failures > 0) {
  console.error(`verify-deterministic-fallback: ${failures} failure(s)`);
  process.exit(1);
}
console.log("PASS verify-deterministic-fallback (offline)");
