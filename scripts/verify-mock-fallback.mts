// Verify the empty-signal → mock fallback yields real, guard-passing links.
// (1) zero-URL context → extractSignalUrls size 0 (trigger condition correct)
// (2) Brave disabled → resolveTopicSignal returns mock with URLs
// (3) generation from mock → surviving links > 0
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && m[1] !== "BRAVE_SEARCH_API_KEY") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
delete process.env.BRAVE_SEARCH_API_KEY; // force mock path
const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
const { extractSignalUrls, isAllowedUrl } = await import("../lib/engine/url-guard.ts");

const zero = extractSignalUrls("This week: no results. (no results — error)").size;
console.log(`(1) zero-URL context → ${zero} URLs ${zero === 0 ? "✓" : "✗"}`);

const sig = await resolveTopicSignal("ai-news" as never, "2026-05-31");
const sigUrls = sig ? extractSignalUrls(sig.context).size : 0;
console.log(`(2) Brave-disabled resolveTopicSignal("ai-news") → ${sig ? "mock signal" : "UNDEFINED"}, ${sigUrls} URLs ${sigUrls > 0 ? "✓" : "✗"}`);
if (!sig) { console.log("FAIL — no fallback signal"); process.exit(1); }

const blurb = await generateTopicBlurb("ai-news" as never, "2026-05-31", sig);
const allowed = extractSignalUrls(sig.context);
const links = blurb.items.flatMap((it) => [it.primaryRef?.url, ...(it.supplementaryRefs?.map((r) => r.url) || [])]).filter(Boolean) as string[];
const viol = links.filter((u) => !isAllowedUrl(u, allowed)).length;
console.log(`(3) generated from mock → ${links.length} surviving links, ${viol} guard violations ${links.length > 0 && viol === 0 ? "✓" : "✗"}`);
process.exit(zero === 0 && sigUrls > 0 && links.length > 0 && viol === 0 ? 0 : 1);
