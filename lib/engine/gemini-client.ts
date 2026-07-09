// Thin client over the Gemini API (raw REST, no SDK dependency needed for the
// two calls this app makes). A genuinely separate vendor from Anthropic/Brave,
// used ONLY as a fallback in two narrow roles (see gemini-search.ts and the
// fallback branch inside topic-blurb.ts/editor-note.ts's callAndParse) — never
// the primary path. Free tier via AI Studio (youngalgy@gmail.com).

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

// Env override so an operator can A/B models without a code change, same
// pattern as lib/engine/client.ts's BLURB_MODEL/EDITOR_NOTE_MODEL.
function pickModel(envVar: string, fallback: string): string {
  return process.env[envVar]?.trim() || fallback;
}

// gemini-2.5-flash: verified working against the real API before this file
// was wired into anything. Free tier is generous at this app's volume (see
// memory — 5,000 grounded prompts/month on Gemini 3.x; 2.5 Flash's own free
// allowance comfortably covers occasional-fallback use).
export const GEMINI_TEXT_MODEL = pickModel("ALPHA_GEMINI_TEXT_MODEL", "gemini-2.5-flash");
export const GEMINI_SEARCH_MODEL = pickModel("ALPHA_GEMINI_SEARCH_MODEL", "gemini-2.5-flash");

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY missing from environment");
  return key;
}

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  groundingMetadata?: {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

// Thrown when Gemini hit its own output ceiling — verified live against the
// real API (finishReason:"MAX_TOKENS" on a forced-truncated response), so
// callers can treat this the same way topic-blurb.ts's BlurbTruncatedError
// treats a truncated Claude response: never silently ship a cut-off result.
export class GeminiTruncatedError extends Error {}

// Bounded fetch (20s attempt, no retry — callers are themselves a fallback
// path off a primary provider, so a slow Gemini call should fail fast into
// whatever last resort follows it, not stack more wait time on top).
async function callGemini(
  model: string,
  body: Record<string, unknown>
): Promise<GeminiCandidate | undefined> {
  const res = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini ${model} ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as GeminiResponse;
  return data.candidates?.[0];
}

// Plain text generation (used for the topic-blurb / editor-note WRITING
// fallback — Anthropic itself unavailable). No grounding tool: by the time
// this runs, the caller already has real signal to write from and just needs
// a model to turn it into prose.
export async function geminiGenerateText(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number
): Promise<string> {
  const candidate = await callGemini(GEMINI_TEXT_MODEL, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    // thinkingBudget:0 disables Gemini's extended-thinking spend, same
    // reasoning as Claude's thinking:{type:"disabled"} on the blurb call —
    // this is a templated JSON/prose task, not one that benefits from it.
    generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
  });
  // A truncated response can still parse as valid (if unbalanced-brace luck
  // runs out) or worse, as valid-but-SHORTENED JSON — check BEFORE the text
  // is trusted, same reasoning as Claude's stop_reason==="max_tokens" guard.
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new GeminiTruncatedError(`Gemini hit its ${maxOutputTokens}-token ceiling`);
  }
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini returned no text");
  return text;
}

export interface GeminiGroundedResult {
  answerText: string;
  citations: Array<{ url: string; title: string }>;
}

// Grounded search: search + write happen in ONE atomic call on Gemini's side
// (see gemini-search.ts's header comment for why this means we can only
// post-filter citations, never pre-filter what Gemini is allowed to search).
export async function geminiGroundedSearch(query: string): Promise<GeminiGroundedResult | undefined> {
  const candidate = await callGemini(GEMINI_SEARCH_MODEL, {
    contents: [{ parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
  });
  // Unlike geminiGenerateText (whose OWN output is truncation-guarded), this
  // text becomes the RESEARCH the blurb writer trusts as fact — so a grounded
  // answer that didn't finish cleanly (MAX_TOKENS, SAFETY, RECITATION, ...) is
  // worse than none: a mid-thought cut can drop the qualifying clause or the
  // number that changes the meaning. Bail so the topic falls through to a
  // fresher backup instead of being written from a half-answer. (undefined and
  // "STOP" are the only clean finishes; anything else is a partial stop.)
  const finish = candidate?.finishReason;
  if (finish && finish !== "STOP") return undefined;
  const answerText = candidate?.content?.parts?.map((p) => p.text ?? "").join("\n").trim() ?? "";
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const citations = chunks
    .map((c) => ({ url: c.web?.uri ?? "", title: c.web?.title ?? "" }))
    .filter((c) => c.url);
  if (!answerText || citations.length === 0) return undefined;
  return { answerText, citations };
}
