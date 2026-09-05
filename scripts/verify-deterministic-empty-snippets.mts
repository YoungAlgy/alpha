import { buildDeterministicBlurb } from "../lib/engine/deterministic-fallback.ts";

let assertions = 0;
let failures = 0;

function check(label: string, condition: boolean): void {
  assertions++;
  if (condition) return;
  failures++;
  console.error(`FAIL: ${label}`);
}

function build(context: string, urls: string[]) {
  return buildDeterministicBlurb({
    topicId: "ai-news",
    weekOf: "2026-09-04",
    context,
    citableUrls: new Set(urls),
  });
}

const first = "https://example.test/first";
const second = "https://example.test/second";

const emptyThenValid = build(
  `- First empty source (example.test) — ${first}
${"  "}
- Second valid source (example.test) — ${second}
  The second description remains with the second source.`,
  ["example.test/first", "example.test/second"]
);
check("parses a first source with an empty resolver description", emptyThenValid?.items.length === 2);
check("does not attach the next headline to an empty first description", !emptyThenValid?.items[0]?.body.includes("Second valid source"));
check("keeps the second source as its own item", emptyThenValid?.items[1]?.headline === "Second valid source");
check("keeps the second source excerpt", emptyThenValid?.items[1]?.body === "The second description remains with the second source.");

const severalEmptyLines = build(
  `- Empty source (example.test) — ${first}
${"  "}


- Later source (example.test) — ${second}
  The later description remains citable.`,
  ["example.test/first", "example.test/second"]
);
check("finds a later source after several empty lines", severalEmptyLines?.items.length === 2);
check("does not consume a later source after several empty lines", severalEmptyLines?.items[1]?.headline === "Later source");

const noDescriptionLine = build(
  `- First without a description (example.test) — ${first}
- Second after no description (example.test) — ${second}
  This is still the second excerpt.`,
  ["example.test/first", "example.test/second"]
);
check("parses adjacent bullets when the first has no description line", noDescriptionLine?.items.length === 2);
check("keeps adjacent second bullet separate", noDescriptionLine?.items[1]?.headline === "Second after no description");

const crlf = build(
  [
    `- CRLF first (example.test) — ${first}`,
    "  ",
    `- CRLF second (example.test) — ${second}`,
    "  CRLF second excerpt.",
  ].join("\r\n"),
  ["example.test/first", "example.test/second"]
);
check("parses empty resolver descriptions with CRLF", crlf?.items.length === 2);
check("keeps the CRLF second excerpt", crlf?.items[1]?.body === "CRLF second excerpt.");

const indentation = build(
  `- Unindented source (example.test) — ${first}
This must not become the excerpt.

- Indented source (example.test) — ${second}
  This is a resolver-shaped excerpt.`,
  ["example.test/first", "example.test/second"]
);
check("does not accept an unindented line as an excerpt", !indentation?.items[0]?.body.includes("This must not become"));
check("accepts a two-space resolver excerpt", indentation?.items[1]?.body === "This is a resolver-shaped excerpt.");

const geminiEmptyThenValid = build(
  `- Gemini first — ${first}

- Gemini second — ${second}`,
  ["example.test/first", "example.test/second"]
);
check("parses hostless Gemini bullets after an empty snippet", geminiEmptyThenValid?.items.length === 2);
check("keeps a hostless Gemini second bullet separate", geminiEmptyThenValid?.items[1]?.headline === "Gemini second");

const threeSourceLimit = build(
  `- Excluded (example.test) — https://example.test/excluded
  Must not appear.
- One (example.test) — https://example.test/one
  First excerpt.
- Two (example.test) — https://example.test/two
  Second excerpt.
- Three (example.test) — https://example.test/three
  Third excerpt.
- Four (example.test) — https://example.test/four
  Fourth excerpt.`,
  ["example.test/one", "example.test/two", "example.test/three", "example.test/four"]
);
check("keeps the three-source ceiling", threeSourceLimit?.items.length === 3);
check("keeps sources in resolver order through the ceiling", threeSourceLimit?.items.map((item) => item.headline).join("|") === "One|Two|Three");
check("keeps only URLs in the citable allow-set", threeSourceLimit?.items.every((item) => item.primaryRef?.url !== "https://example.test/excluded") === true);

const noAllowedSources = build(`- Excluded only (example.test) — https://example.test/excluded`, []);
check("returns null when every parsed source is outside the allow-set", noAllowedSources === null);

if (failures > 0) {
  console.error(`verify-deterministic-empty-snippets: ${failures}/${assertions} assertion(s) failed`);
  process.exit(1);
}

console.log(`PASS verify-deterministic-empty-snippets (${assertions} assertions, offline)`);
