// Offline regression for the terminal-writer empty-draft path. Every provider
// request is intercepted locally. `--baseline` runs the same assertions against
// the sibling verified release before the fix, providing mutation proof without
// rewriting either source tree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TopicSignal } from "../lib/engine/types.ts";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--baseline"),
  "usage: tsx scripts/verify-terminal-writer-fallback.mts [--baseline]"
);
const baseline = args[0] === "--baseline";
const targetRoot = baseline
  ? new URL("../../alpha-free-invite-release-20260905/", import.meta.url)
  : new URL("../", import.meta.url);

const providerEnv = [
  "ALPHA_ALLOW_PAID_AI",
  "ALPHA_NO_MODEL_MODE",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
] as const;

for (const name of providerEnv) delete process.env[name];
process.env.ALPHA_ALLOW_PAID_AI = "1";
process.env.ANTHROPIC_API_KEY = "offline-anthropic";

const originalFetch = globalThis.fetch;
let modelCalls = 0;

globalThis.fetch = (async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  assert.equal(url, "https://api.anthropic.com/v1/messages", `unexpected external request: ${url}`);

  const body = JSON.parse(String(init?.body)) as { model?: string };
  modelCalls += 1;
  if (body.model === "claude-haiku-4-5") {
    return new Response(JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "offline rate limit" },
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  assert.equal(body.model, "claude-sonnet-5");
  return new Response(JSON.stringify({
    id: "msg_offline_terminal_empty",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{
      type: "text",
      text: JSON.stringify({
        intro: "A terminal draft with no usable item.",
        items: [{ headline: "Missing body is rejected" }],
      }),
    }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

try {
  const [{ generateTopicBlurb }, { buildDeterministicBlurb }] = await Promise.all([
    import(new URL("lib/engine/topic-blurb.ts", targetRoot).href),
    import(new URL("lib/engine/deterministic-fallback.ts", targetRoot).href),
  ]);

  const safeUrl = "https://example.com/current-alpha-source";
  const signal: TopicSignal = {
    topicId: "ai-news",
    weekOf: "2026-09-05",
    citableUrls: new Set(["example.com/current-alpha-source"]),
    context: `=== TOP SOURCES (full text — read these and surface the real insight) ===

[1] Current Alpha source
    example.com · today
    SOURCE: ${safeUrl}

This safe source contains current reporting that the local formatter can retain.`,
  };

  let terminalError: unknown;
  try {
    await generateTopicBlurb("ai-news", "2026-09-05", signal);
  } catch (error) {
    terminalError = error;
  }

  assert.ok(terminalError instanceof Error, "terminal guard-empty Sonnet output must reject");
  assert.match(terminalError.message, /Sonnet draft had 0 usable items after guards/);
  assert.equal(modelCalls, 2, "Haiku and Sonnet must each run once, with no empty-draft retry");

  // Execute the exact catch body from the selected tree's assemble.ts. This
  // keeps the test coupled to the real handoff instead of reproducing it here.
  const assembleSource = readFileSync(new URL("lib/engine/assemble.ts", targetRoot), "utf8");
  const catchMatch = assembleSource.match(
    /catch \(generationError\) \{([\s\S]*?)\r?\n        \}\r?\n        \/\/ Only cache a real section\./
  );
  assert.ok(catchMatch?.[1], "assemble.ts generation fallback catch must remain detectable");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;
  const runActualAssembleCatch = new AsyncFunction(
    "generationError",
    "signal",
    "id",
    "weekOf",
    "buildDeterministicBlurb",
    `let blurb;${catchMatch[1]}\nreturn blurb;`
  );
  const assembledFallback = await runActualAssembleCatch(
    terminalError,
    signal,
    "ai-news",
    "2026-09-05",
    buildDeterministicBlurb
  ) as ReturnType<typeof buildDeterministicBlurb>;
  assert.ok(assembledFallback, "the existing assemble fallback must accept the safe signal");
  assert.equal(assembledFallback.items.length, 1);
  assert.equal(assembledFallback.items[0]?.headline, "Current Alpha source");
  assert.equal(assembledFallback.items[0]?.primaryRef?.url, safeUrl);

  console.log(`PASS verify-terminal-writer-fallback ${baseline ? "baseline" : "fixed"} (offline)`);
} finally {
  globalThis.fetch = originalFetch;
  for (const name of providerEnv) delete process.env[name];
}
