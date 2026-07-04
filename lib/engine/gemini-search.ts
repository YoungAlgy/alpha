// Search fallback via Gemini's grounded-search tool: used ONLY when Brave
// itself signals quota exhaustion (source-resolver.ts checks
// braveRateLimitedCount before/after a call), never as a general "Brave came
// back dry" substitute — a genuinely quiet topic should still fall through to
// a fresher backup topic (the existing dry-topic behavior), not get
// force-filled by a second search provider.
//
// Grounding is one atomic call: Gemini searches AND writes an answer in the
// SAME request, so — unlike Brave, where results are ranked/filtered before
// any model sees them — there is no way to tell it which domains it may
// search. Two consequences handled here:
//   1. Citations come back as vertexaisearch.cloud.google.com redirect
//      wrappers, not the real source URL. Verified live: a plain HEAD request
//      with redirect:"follow" resolves to the real destination in one hop.
//      Every citation is resolved BEFORE any filtering can even see the real
//      host — filtering the redirect URL itself would be a no-op, since the
//      host is always vertexaisearch.cloud.google.com.
//   2. Filtering is necessarily POST-hoc, not pre-hoc: a citation whose
//      RESOLVED host is paywalled/junk (the same hostTier check the Brave
//      path uses) or already cited to this reader recently (excludeUrls) is
//      dropped before it can ever reach a subscriber, but Gemini's own
//      synthesized answer text may still have been informed by a page we'd
//      have denied outright as a direct citation. Accepted: the actual harm
//      this app guards against (a reader clicking a link and hitting a
//      paywall) can't happen if the URL itself is never surfaced, even if the
//      prose describing it drew on a paywalled source.

import { geminiGroundedSearch } from "./gemini-client";
import { hostTier } from "./source-authority";
import { normalizeUrl } from "./url-guard";
import type { TopicSignal } from "./types";
import type { TopicId } from "@/lib/types";

// Bounds how many redirect-resolution HEAD requests one fallback call makes.
const MAX_CITATIONS = 8;

// Resolve one grounding-redirect URL to its real destination. Best-effort: a
// citation that fails to resolve (timeout, dead redirect) is just dropped
// rather than failing the whole topic over one bad link.
async function resolveRedirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(6_000),
    });
    return res.url || null;
  } catch {
    return null;
  }
}

export async function resolveTopicSignalViaGemini(
  topicId: TopicId,
  weekOf: string,
  researchQuery: string,
  excludeUrls?: Set<string>
): Promise<TopicSignal | undefined> {
  let grounded;
  try {
    grounded = await geminiGroundedSearch(
      `${researchQuery}\n\nGive a substantive, informative answer covering what is genuinely new and worth knowing. Do not pad with generic background.`
    );
  } catch (e) {
    console.warn(`[gemini-search] ${topicId}: request failed: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
  if (!grounded) return undefined;

  const resolved = await Promise.all(
    grounded.citations.slice(0, MAX_CITATIONS).map(async (c) => ({
      title: c.title,
      real: await resolveRedirect(c.url),
    }))
  );

  const seen = new Set<string>();
  const survivors: Array<{ url: string; title: string; norm: string }> = [];
  for (const { title, real } of resolved) {
    if (!real) continue;
    const norm = normalizeUrl(real);
    if (!norm || seen.has(norm)) continue;
    let host: string;
    try {
      host = new URL(real).hostname;
    } catch {
      continue;
    }
    if (hostTier(host, real) === "denied") continue; // paywall/junk deny list
    if (excludeUrls?.has(norm)) continue; // already cited to this reader recently
    seen.add(norm);
    survivors.push({ url: real, title: title || host, norm });
  }

  if (survivors.length === 0) {
    console.warn(`[gemini-search] ${topicId}: no citations survived redirect-resolve + filtering`);
    return undefined;
  }

  const sourceLines = survivors.map((s) => `- ${s.title} — ${s.url}`).join("\n");
  const context = `Research summary for ${topicId} (as of ${weekOf}), gathered live via Gemini grounded search (Brave was rate-limited this run):\n\n${grounded.answerText}\n\n=== SOURCES (real, citable — verified direct links) ===\n${sourceLines}\n\nAll URLs listed above are real and citable. Do NOT invent URLs.`;
  const citableUrls = new Set(survivors.map((s) => s.norm));

  return { topicId, weekOf, context, citableUrls };
}
