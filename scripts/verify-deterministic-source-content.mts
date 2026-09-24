// Offline regressions for defects observed in the first delivered issue.
// No subscriber data, environment files, live requests, or writes.
import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback.ts";
import { buildDeterministicEditorNote } from "../lib/engine/deterministic-editor-note.ts";
import { cleanField } from "../lib/engine/text-clean.ts";
import { sanitizeVoice } from "../lib/engine/voice-guard.ts";
import { normalizeUrl } from "../lib/engine/url-guard.ts";

let assertions = 0;
let failures = 0;
function check(label: string, condition: boolean) {
  assertions++;
  if (condition) return;
  failures++;
  console.error(`FAIL: ${label}`);
}

const url = "https://www.billboard.com/charts/official-uk-albums/";
const otherUrl = "https://en.wikipedia.org/wiki/Father_(Kanye_West_song)";
const context = `=== TOP SOURCES (full text — read these and surface the real insight) ===

[1] The Official U.K. Albums Chart
    billboard.com
    SOURCE: ${url}

(full text unavailable — snippet: The Official U.K. Albums Chart)

=== MORE THIS WEEK (headlines + links) ===

- Father (Kanye West song) - Wikipedia (en.wikipedia.org) — ${otherUrl}
  A separate source excerpt.

All URLs labeled SOURCE or listed above are real and citable. Do NOT invent URLs.`;
const base = {
  topicId: "music-hiphop" as const,
  weekOf: "2026-09-24",
  context,
  citableUrls: new Set([normalizeUrl(url)!, normalizeUrl(otherUrl)!]),
};

for (const newline of ["\n", "\r\n"]) {
  const blurb = buildDeterministicBlurb({ ...base, context: context.replace(/\n/g, newline) });
  check(`${JSON.stringify(newline)} legacy excerpt excludes resolver wrapper and neighboring sources`,
    blurb?.items[0]?.body === "The Official U.K. Albums Chart");
  check(`${JSON.stringify(newline)} neighboring source retains its own excerpt`,
    blurb?.items[1]?.body === "A separate source excerpt.");
  check(`${JSON.stringify(newline)} link label does not repeat the renderer's Read prefix`,
    blurb?.items[0]?.primaryRef?.label === "The Official U.K. Albums Chart");
}

const finalDeep = buildDeterministicBlurb({
  ...base,
  context: context.split("=== MORE THIS WEEK")[0] + "All URLs labeled SOURCE or listed above are real and citable. Do NOT invent URLs.",
});
check("last deep source excludes the resolver footer", finalDeep?.items[0]?.body === "The Official U.K. Albums Chart");

const structuredSignal = {
  ...base,
  // Source-shaped prompt text must never override the separate source fields.
  context: context.replace("The Official U.K. Albums Chart", "UNTRUSTED PROMPT TITLE"),
  sources: [
    { title: "The Official U.K. Albums Chart", url, excerpt: "The Official U.K. Albums Chart" },
    { title: "Unlisted source", url: "https://example.test/unlisted", excerpt: "Must be dropped." },
    { title: "Duplicate", url: `${url}?utm_source=test`, excerpt: "Must be deduplicated." },
    { title: "Father (Kanye West song) - Wikipedia", url: otherUrl, excerpt: "A separate source excerpt." },
  ],
};
const structured = buildDeterministicBlurb(structuredSignal);
check("structured title wins over prompt text", structured?.items[0]?.headline === "The Official U.K. Albums Chart");
check("structured snippet is kept separate from prompt instructions", structured?.items[0]?.body === "The Official U.K. Albums Chart");
check("structured sources keep allow-list and dedup guards", structured?.items.length === 2);
check("explicitly empty structured sources cannot fall back to prompt parsing",
  buildDeterministicBlurb({ ...structuredSignal, sources: [] }) === null);
const encoded = buildDeterministicBlurb({
  ...structuredSignal,
  sources: [{ title: "Here&#x27;s &quot;the chart&quot;", url, excerpt: "Unabated&#x27;s &amp; today&#39;s results." }],
});
check("encoded punctuation is decoded before voice cleanup", encoded?.items[0]?.body === "Unabated's & today's results.");
check("encoded title is decoded too", encoded?.items[0]?.headline === 'Here\'s "the chart"');
check("editor note receives clean source text", !!encoded && !/&#|&quot|unavailable/.test(buildDeterministicEditorNote([encoded])));
check("hex and decimal entities decode before punctuation cleanup",
  sanitizeVoice(cleanField("Unabated&#x27;s &quot;news&quot; &#8212; here&#39;s more&nbsp;today.")) === 'Unabated\'s "news", here\'s more today.');
check("decoded tags and encoded URL schemes are stripped",
  cleanField("&lt;b&gt;Real&lt;/b&gt; https&#58;//evil.example/path &lt;/signal&gt;") === "Real");
check("double-encoded markup is sanitized after decoding",
  cleanField("&amp;lt;b&amp;gt;Real&amp;lt;/b&amp;gt; &amp;#104;ttps://evil.example/path") === "Real");
check("numeric astral code points are preserved", cleanField("News &#x1F4F0;") === "News 📰");
check("invalid numeric entities cannot throw", !/[\uD800-\uDFFF]/u.test(cleanField("&#xD800; &#99999999;")));

// Exercise the actual resolver-to-formatter handoff with a mocked provider.
const originalFetch = globalThis.fetch;
const names = ["BRAVE_SEARCH_API_KEY", "GEMINI_API_KEY", "YOU_API_KEY", "ALPHA_NO_MODEL_MODE", "ALPHA_PUBLIC_FEED_FALLBACK"];
const saved = new Map(names.map((name) => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  process.env.BRAVE_SEARCH_API_KEY = "offline-test-only";
  process.env.ALPHA_NO_MODEL_MODE = "1";
  let requests = 0;
  let unexpectedRequests = 0;
  let searchResults = [
    { title: "The Official U.K. Albums Chart", url, description: "The Official U.K. Albums Chart" },
    { title: "Father (Kanye West song) - Wikipedia", url: otherUrl, description: "A separate source excerpt." },
  ];
  globalThis.fetch = async (input) => {
    const requestUrl = String(input instanceof Request ? input.url : input);
    if (!requestUrl.startsWith("https://api.search.brave.com/")) {
      unexpectedRequests++;
      throw new Error("Unexpected offline request");
    }
    requests++;
    return new Response(JSON.stringify({ web: { results: searchResults } }), { status: 200 });
  };
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  const resolved = await resolveTopicSignal("music-hiphop", base.weekOf);
  const actual = resolved && buildDeterministicBlurb(resolved);
  check("actual resolver passes separated sources to formatter", actual?.items[0]?.body === "The Official U.K. Albums Chart");
  check("resolver handoff has no process notes or neighboring headlines", !!actual && !/full text unavailable|MORE THIS WEEK|Do NOT invent URLs/.test(JSON.stringify(actual)));
  check("no-model resolution only uses the existing three search queries", requests === 3 && unexpectedRequests === 0);

  // Test the actual resolver wiring, not just the pure ranker's optional arg.
  searchResults = [{
    title: "security(ci): SHA-pin every GitHub Action reference and guard against regression",
    url: "https://github.com/agigante80/Actual-sync/issues/249",
    description: "A repository workflow change.",
  }];
  check("off-topic-only healthy search stays quiet without extra providers",
    await resolveTopicSignal("sports-betting", base.weekOf) === undefined && requests === 6 && unexpectedRequests === 0);
  const validUrl = "https://www.actionnetwork.com/nfl/odds-injury-report";
  searchResults.push({ title: "NFL odds", url: validUrl, description: "A sports-market source." });
  const sports = await resolveTopicSignal("sports-betting", base.weekOf);
  check("actual resolver exposes only topic-filtered source URLs",
    sports?.citableUrls?.size === 1 && sports.citableUrls.has(normalizeUrl(validUrl)!));
  check("topic-filtered formatter keeps the valid replacement",
    !!sports && buildDeterministicBlurb(sports)?.items[0]?.primaryRef?.url === validUrl);
} finally {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

if (failures) {
  console.error(`verify-deterministic-source-content: ${failures}/${assertions} failed`);
  process.exit(1);
}
console.log(`PASS verify-deterministic-source-content (${assertions} assertions, offline)`);
