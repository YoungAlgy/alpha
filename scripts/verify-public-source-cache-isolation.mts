// Pure in-memory cache fixture. No environment loader, source, database,
// subscriber, model, provider, or send. Any unexpected fetch fails the run.
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("network denied in public source cache isolation fixture");
}) as typeof fetch;

let passed = 0;
let failed = 0;
const check = (label: string, work: () => void): void => {
  try {
    work();
    passed++;
    console.log(`  OK  ${label}`);
  } catch (error) {
    failed++;
    console.error(`  XX  ${label}`);
    if (error instanceof Error) console.error(`      ${error.message}`);
  }
};

type FixtureMetadata = {
  title: string;
  url: string;
  description: string;
  attribution: {
    publisher: string;
    authors: string[];
    license: { name: string; url: string };
  };
  categories: string[];
};

const metadata = (suffix: string): FixtureMetadata => ({
  title: `Offline source ${suffix}`,
  url: `https://example.test/source-${suffix}`,
  description: "Plain serializable source metadata.",
  attribution: {
    publisher: "Fixture Publisher",
    authors: ["Fixture Author"],
    license: {
      name: "Fixture Open License",
      url: "https://example.test/license",
    },
  },
  categories: ["fixture-category"],
});

try {
  const { createPublicSourceCache } = await import("../lib/engine/public-source-cache.ts");
  const cache = createPublicSourceCache<FixtureMetadata>(() => 0);

  // The cache must own its stored value. Mutating the object retained by the
  // work function after resolution cannot rewrite later cache reads.
  let originalCalls = 0;
  const original = metadata("original");
  const originalRead = await cache("fixture-original", "fixed", async () => {
    originalCalls++;
    return [original];
  });
  original.title = "mutated original title";
  original.attribution.publisher = "mutated original publisher";
  original.attribution.authors.push("mutated original author");
  original.attribution.license.name = "mutated original license";
  original.categories.push("mutated original category");
  const originalAgain = await cache("fixture-original", "fixed", async () => {
    throw new Error("unexpected original cache miss");
  });
  check("work result is cached once", () => assert.equal(originalCalls, 1));
  check("top-level original mutation cannot rewrite the cache", () =>
    assert.equal(originalAgain[0]?.title, "Offline source original"));
  check("nested original attribution cannot rewrite the cache", () =>
    assert.equal(originalAgain[0]?.attribution.publisher, "Fixture Publisher"));
  check("nested original author array cannot rewrite the cache", () =>
    assert.deepEqual(originalAgain[0]?.attribution.authors, ["Fixture Author"]));
  check("deep original license metadata cannot rewrite the cache", () =>
    assert.equal(originalAgain[0]?.attribution.license.name, "Fixture Open License"));
  check("nested original category array cannot rewrite the cache", () =>
    assert.deepEqual(originalAgain[0]?.categories, ["fixture-category"]));
  check("first returned value is independent from retained work input", () => {
    assert.equal(originalRead[0]?.attribution.publisher, "Fixture Publisher");
    assert.deepEqual(originalRead[0]?.categories, ["fixture-category"]);
  });

  // Coalesced callers share one underlying operation but must receive isolated
  // values. One caller cannot rewrite another caller or the stored cache entry.
  let coalescedCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coalescedInput = metadata("coalesced");
  const coalescedWork = async () => {
    coalescedCalls++;
    await gate;
    return [coalescedInput];
  };
  const firstPending = cache("fixture-coalesced", "fixed", coalescedWork);
  const secondPending = cache("fixture-coalesced", "fixed", coalescedWork);
  release();
  const [firstCaller, secondCaller] = await Promise.all([firstPending, secondPending]);
  check("coalesced callers execute work once", () => assert.equal(coalescedCalls, 1));
  firstCaller[0]!.title = "mutated caller title";
  firstCaller[0]!.attribution.publisher = "mutated caller publisher";
  firstCaller[0]!.attribution.authors.push("mutated caller author");
  firstCaller[0]!.attribution.license.name = "mutated caller license";
  firstCaller[0]!.categories.push("mutated caller category");
  check("coalesced callers isolate top-level metadata", () =>
    assert.equal(secondCaller[0]?.title, "Offline source coalesced"));
  check("coalesced callers isolate nested attribution", () =>
    assert.equal(secondCaller[0]?.attribution.publisher, "Fixture Publisher"));
  check("coalesced callers isolate nested author arrays", () =>
    assert.deepEqual(secondCaller[0]?.attribution.authors, ["Fixture Author"]));
  check("coalesced callers isolate deep license metadata", () =>
    assert.equal(secondCaller[0]?.attribution.license.name, "Fixture Open License"));
  check("coalesced callers isolate nested category arrays", () =>
    assert.deepEqual(secondCaller[0]?.categories, ["fixture-category"]));

  const laterRead = await cache("fixture-coalesced", "fixed", async () => {
    throw new Error("unexpected later cache miss");
  });
  check("later cache reads isolate nested attribution", () =>
    assert.equal(laterRead[0]?.attribution.publisher, "Fixture Publisher"));
  check("later cache reads isolate nested author arrays", () =>
    assert.deepEqual(laterRead[0]?.attribution.authors, ["Fixture Author"]));
  check("later cache reads isolate deep license metadata", () =>
    assert.equal(laterRead[0]?.attribution.license.name, "Fixture Open License"));
  check("later cache reads isolate nested category arrays", () =>
    assert.deepEqual(laterRead[0]?.categories, ["fixture-category"]));

  // Empty success is a valid short-lived cache entry. A caller can mutate its
  // returned array without manufacturing cached source metadata.
  let emptyCalls = 0;
  const emptyFirst = await cache("fixture-empty", "fixed", async () => {
    emptyCalls++;
    return [];
  });
  emptyFirst.push(metadata("invented-by-caller"));
  const emptySecond = await cache("fixture-empty", "fixed", async () => {
    throw new Error("unexpected empty cache miss");
  });
  check("empty results are cached once", () => assert.equal(emptyCalls, 1));
  check("caller mutation cannot populate a cached empty result", () =>
    assert.deepEqual(emptySecond, []));
  check("fixture made zero network requests", () => assert.equal(fetches, 0));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("PUBLIC SOURCE CACHE ISOLATION VERIFICATION FAILED");
    process.exitCode = 1;
  } else {
    console.log("PASS public source cache isolates original, coalesced and later-reader metadata (offline)");
  }
} finally {
  globalThis.fetch = originalFetch;
}
