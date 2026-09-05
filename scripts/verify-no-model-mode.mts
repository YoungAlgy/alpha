// Fully offline verification for strict no-model mode. It proves that the
// topic and editor pipelines return local output without reaching fetch when
// the explicit runtime flag is enabled.
import assert from "node:assert/strict";

const originalMode = process.env.ALPHA_NO_MODEL_MODE;
const originalFetch = globalThis.fetch;
const providerEnvNames = [
  "BRAVE_SEARCH_API_KEY",
  "GEMINI_API_KEY",
  "YOU_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;
const originalProviderEnv = new Map(providerEnvNames.map((name) => [name, process.env[name]]));
for (const name of providerEnvNames) delete process.env[name];
process.env.ALPHA_NO_MODEL_MODE = "1";
globalThis.fetch = async () => {
  throw new Error("provider fetch should not run in no-model mode");
};

try {
  const { noModelModeEnabled } = await import("../lib/engine/provider-policy.ts");
  assert.equal(noModelModeEnabled(), true);

  // A grounded-search fallback is a model call too. No-model mode must skip
  // it before fetch, rather than only skipping the writer after search.
  process.env.GEMINI_API_KEY = "offline-gemini";
  const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
  assert.equal(await resolveTopicSignal("ai-news" as never, "2026-08-30"), undefined);
  delete process.env.GEMINI_API_KEY;

  const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
  const signal = {
    topicId: "ai-news",
    weekOf: "2026-08-30",
    context: "Recent signal for ai-news.\n\n=== THIS WEEK ===\n\n- A model release worth reading — https://example.com/model-release\n  The release changes how teams test smaller models.",
    // citableUrls uses normalizeUrl's host/path identity, without a scheme.
    citableUrls: new Set(["example.com/model-release"]),
  } as never;
  const blurb = await generateTopicBlurb("ai-news" as never, "2026-08-30", signal);
  assert.equal(blurb.items.length, 1);
  assert.equal(blurb.items[0]?.primaryRef?.url, "https://example.com/model-release");

  const { generateEditorNote } = await import("../lib/engine/editor-note.ts");
  const note = await generateEditorNote(
    { firstName: "Sam", city: "Tampa", topics: ["ai-news"] } as never,
    [blurb]
  );
  assert.match(note, /Worth sitting with that one\./);
  assert.ok(note.length > 20);

  console.log("PASS verify-no-model-mode (offline)");
} finally {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.ALPHA_NO_MODEL_MODE;
  else process.env.ALPHA_NO_MODEL_MODE = originalMode;
  for (const name of providerEnvNames) {
    const value = originalProviderEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
