// Focused Round 80 provider checks. Fully offline: every fetch is replaced by
// a deterministic local response and unexpected destinations fail the run.
import assert from "node:assert/strict";
import { resolveTopicSignal } from "../lib/engine/source-resolver.ts";
import { generateTopicBlurb } from "../lib/engine/topic-blurb.ts";
import type { TopicSignal } from "../lib/engine/types.ts";
import {
  clearProviderEnv,
  restoreProviderEnv,
  snapshotProviderEnv,
} from "./provider-env-snapshot.mts";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirectedHead(realUrl: string): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "url", { value: realUrl });
  return response;
}

const originalFetch = globalThis.fetch;
const originalProviderEnv = snapshotProviderEnv();

try {
  // Brave is absent: Gemini should become the first live-search provider.
  clearProviderEnv();
  process.env.GEMINI_API_KEY = "offline-gemini";
  process.env.YOU_API_KEY = "offline-you";
  let geminiCalls = 0;
  let geminiRedirectCalls = 0;
  let unexpectedYouCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      geminiCalls += 1;
      return jsonResponse({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: "A current offline research summary." }] },
          groundingMetadata: {
            groundingChunks: [{
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/offline",
                title: "Current source",
              },
            }],
          },
        }],
      });
    }
    if (url.startsWith("https://vertexaisearch.cloud.google.com/")) {
      assert.equal(init?.method, "HEAD");
      geminiRedirectCalls += 1;
      return redirectedHead("https://www.reuters.com/world/offline-alpha-source");
    }
    if (url.startsWith("https://ydc-index.io/")) {
      unexpectedYouCalls += 1;
      throw new Error("You.com should not run after a usable Gemini result");
    }
    throw new Error(`Unexpected offline fetch: ${url}`);
  }) as typeof fetch;

  const viaGemini = await resolveTopicSignal("ai-news", "2026-08-27", { liveOnly: true });
  assert.ok(viaGemini);
  assert.equal(geminiCalls, 1);
  assert.equal(geminiRedirectCalls, 1);
  assert.equal(unexpectedYouCalls, 0);
  assert.match(viaGemini.context, /Brave was not configured this run/);

  // Brave is configured but every query fails: You.com should run after the
  // unavailable Brave attempt when Gemini is not configured.
  clearProviderEnv();
  process.env.BRAVE_SEARCH_API_KEY = "offline-brave";
  process.env.YOU_API_KEY = "offline-you";
  let failedBraveCalls = 0;
  let youCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input);
    if (url.startsWith("https://api.search.brave.com/")) {
      failedBraveCalls += 1;
      return new Response("offline outage", { status: 503 });
    }
    if (url.startsWith("https://ydc-index.io/")) {
      youCalls += 1;
      return jsonResponse({
        results: {
          web: [{
            url: "https://www.reuters.com/world/offline-you-source",
            title: "Independent current source",
            description: "A deterministic current-result snippet.",
            page_age: "1 day ago",
          }],
        },
      });
    }
    throw new Error(`Unexpected offline fetch: ${url}`);
  }) as typeof fetch;

  const viaYou = await resolveTopicSignal("ai-news", "2026-08-27", { liveOnly: true });
  assert.ok(viaYou);
  assert.ok(failedBraveCalls > 0);
  assert.ok(youCalls > 0);
  assert.match(viaYou.context, /SOURCE: https:\/\/www\.reuters\.com\/world\/offline-you-source/);

  // Brave answered every query successfully but found nothing. This is a
  // healthy quiet topic and must not be force-filled by Gemini or You.com.
  clearProviderEnv();
  process.env.BRAVE_SEARCH_API_KEY = "offline-brave";
  process.env.GEMINI_API_KEY = "offline-gemini";
  process.env.YOU_API_KEY = "offline-you";
  let healthyBraveCalls = 0;
  let quietFallbackCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input);
    if (url.startsWith("https://api.search.brave.com/")) {
      healthyBraveCalls += 1;
      return jsonResponse({ web: { results: [] } });
    }
    if (
      url.startsWith("https://generativelanguage.googleapis.com/") ||
      url.startsWith("https://ydc-index.io/")
    ) {
      quietFallbackCalls += 1;
      throw new Error("A healthy empty Brave result must stay quiet");
    }
    throw new Error(`Unexpected offline fetch: ${url}`);
  }) as typeof fetch;

  const healthyEmpty = await resolveTopicSignal("ai-news", "2026-08-27", { liveOnly: true });
  assert.equal(healthyEmpty, undefined);
  assert.ok(healthyBraveCalls > 0);
  assert.equal(quietFallbackCalls, 0);

  // One empty Brave response cannot prove a topic is quiet when sibling
  // queries failed. The incomplete search must open an independent provider.
  clearProviderEnv();
  process.env.BRAVE_SEARCH_API_KEY = "offline-brave";
  process.env.GEMINI_API_KEY = "offline-gemini";
  let partialBraveCalls = 0;
  let partialGeminiCalls = 0;
  let partialRedirectCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith("https://api.search.brave.com/")) {
      partialBraveCalls += 1;
      if (partialBraveCalls === 1) return jsonResponse({ web: { results: [] } });
      return new Response("offline partial outage", { status: 503 });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      partialGeminiCalls += 1;
      return jsonResponse({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: "Independent fallback found a current item." }] },
          groundingMetadata: {
            groundingChunks: [{
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/partial",
                title: "Fallback source",
              },
            }],
          },
        }],
      });
    }
    if (url.startsWith("https://vertexaisearch.cloud.google.com/")) {
      assert.equal(init?.method, "HEAD");
      partialRedirectCalls += 1;
      return redirectedHead("https://www.reuters.com/world/offline-partial-fallback");
    }
    throw new Error(`Unexpected offline fetch: ${url}`);
  }) as typeof fetch;

  const partialFallback = await resolveTopicSignal("ai-news", "2026-08-27", { liveOnly: true });
  assert.ok(partialFallback);
  assert.ok(partialBraveCalls > 1);
  assert.equal(partialGeminiCalls, 1);
  assert.equal(partialRedirectCalls, 1);
  assert.match(partialFallback.context, /Brave was unavailable this run/);

  // A permanent Groq 413 already triggers the client's bounded correction
  // loop. topic-blurb must not start a second copy of that loop.
  clearProviderEnv();
  process.env.GROQ_API_KEY = "offline-groq";
  let groqCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input);
    if (url === "https://api.groq.com/openai/v1/chat/completions") {
      groqCalls += 1;
      return new Response("payload too large", { status: 413 });
    }
    throw new Error(`Unexpected offline fetch: ${url}`);
  }) as typeof fetch;

  const citableUrl = "https://www.reuters.com/world/offline-groq-source";
  const signal: TopicSignal = {
    topicId: "ai-news",
    weekOf: "2026-08-27",
    context: `Current source material. SOURCE: ${citableUrl}\n${"Current reporting details. ".repeat(200)}`,
    citableUrls: new Set([citableUrl]),
  };
  await assert.rejects(
    generateTopicBlurb("ai-news", "2026-08-27", signal),
    /every configured free tier failed and Anthropic is not configured/
  );
  assert.equal(groqCalls, 4, "the outer retry must not repeat Groq's four-attempt 413 loop");

  console.log("PASS verify-r80-provider-fallbacks (offline, 20 assertions)");
} finally {
  globalThis.fetch = originalFetch;
  restoreProviderEnv(originalProviderEnv);
}
