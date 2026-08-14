// Verify round 28 findings: #203 (ThemeSwitcher blur backstop closed on
// in-panel non-focusable clicks), #204 (dispute charge-retrieve rethrow made
// the specific alert unreachable), #205 (5-6 indexable pages lost
// og:image/twitter:image + og:site_name), #206 (generate's sessionId path had
// no per-payment cap), #207 (rate-limit.ts's per-isolate gap undocumented),
// #208 (GET /api/health had zero rate limiting), #209 (Stripe Checkout
// Session metadata retention -- redundant Subscription copy removed +
// disclosed), #210 (orphaned support_tickets excluded from export/delete),
// #211 (non-string ref label/note crashed sanitizeVoice), #212 (Gemini/
// OpenAI-compat finish-reason whitelisting). alpha-drift-r28-01 through
// r28-10, all 2026-08-15.
// Run: npx tsx scripts/verify-r28-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ThemeSwitcher.tsx: blur backstop no longer closes on a null relatedTarget");
{
  const src = readFileSync(new URL("../components/ThemeSwitcher.tsx", import.meta.url), "utf8");
  const fnMatch = src.match(/function handleWrapperBlur\(e: React\.FocusEvent<HTMLDivElement>\) \{([\s\S]*?)\n  \}/);
  check("(1a) handleWrapperBlur was found", !!fnMatch);
  const fn = fnMatch ? fnMatch[1] : "";
  check("(1b) only closes when relatedTarget is a real, non-null Node outside the wrapper", /if \(next && !wrapperRef\.current\?\.contains\(next\)\) \{\s*setOpen\(false\);\s*\}/.test(fn));
  check("(1c) the old `!next ||` branch (closed on ANY null relatedTarget, including in-panel clicks) is gone", !/!next \|\|/.test(fn));
  check("(1d) relatedTarget is still captured as `next`", /const next = e\.relatedTarget as Node \| null;/.test(fn));
}

console.log("(2) app/api/stripe/webhook/route.ts: dispute alert fires before the (now-conditional) rethrow");
{
  const src = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  const caseMatch = src.match(/case "charge\.dispute\.created": \{([\s\S]*?)case "charge\.dispute\.closed":/);
  check("(2a) the charge.dispute.created case was found", !!caseMatch);
  const block = caseMatch ? caseMatch[1] : "";
  check("(2b) retrieveError is captured in the catch, not rethrown immediately", /retrieveError = e;/.test(block));
  const noCustomerMatch = block.match(/if \(!customerId\) \{([\s\S]*?)\n\s*\}/);
  check("(2c) the !customerId branch was found", !!noCustomerMatch);
  const noCustomerBlock = noCustomerMatch ? noCustomerMatch[1] : "";
  check("(2d) the specific 'couldn't identify the subscriber' alert is sent inside that branch", /sendOpsAlert\(\s*"alpha\. dispute opened -- couldn't identify the subscriber"/.test(noCustomerBlock));
  // Ordering proof: the alert call must appear BEFORE the retrieveError rethrow
  // within the same block, not just both be present somewhere in the file.
  const alertIdx = noCustomerBlock.indexOf("sendOpsAlert(");
  const throwIdx = noCustomerBlock.indexOf("if (retrieveError) throw retrieveError;");
  check("(2e) the alert fires BEFORE the conditional rethrow (both found, alert first)", alertIdx >= 0 && throwIdx >= 0 && alertIdx < throwIdx);
  check("(2f) the rethrow is now conditional on retrieveError, not unconditional", /if \(retrieveError\) throw retrieveError;/.test(noCustomerBlock));
}

console.log("(3) SEO metadata: 6 indexable pages carry siteName + og:image + twitter summary_large_image");
{
  const pages = [
    { path: "../app/privacy/page.tsx", needsImages: true },
    { path: "../app/terms/page.tsx", needsImages: true },
    { path: "../app/support/page.tsx", needsImages: true },
    { path: "../app/welcome/layout.tsx", needsImages: true },
    { path: "../app/signin/layout.tsx", needsImages: true },
    { path: "../app/sample/page.tsx", needsImages: false }, // already had images pre-r28, only siteName was missing
  ];
  for (const { path, needsImages } of pages) {
    const src = readFileSync(new URL(path, import.meta.url), "utf8");
    const label = path.replace("../", "");
    check(`(3-${label}) siteName: "alpha." present in openGraph`, /siteName: "alpha\."/.test(src));
    check(`(3-${label}) twitter.card upgraded to summary_large_image`, /card: "summary_large_image"/.test(src));
    check(`(3-${label}) twitter.images present`, /twitter:\s*\{[\s\S]*?images:/.test(src));
    if (needsImages) {
      check(`(3-${label}) openGraph.images present with the real og-image.png asset`, /images: \[\{ url: "\/og-image\.png", width: 1200, height: 630/.test(src));
    }
  }
}

console.log("(4) app/api/generate/route.ts: unauthenticated sessionId path now rate-limited per-session");
{
  const src = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
  const branchMatch = src.match(/\} else if \(body\.sessionId\) \{([\s\S]*?)\n  \}/);
  check("(4a) the else-if(body.sessionId) branch was found", !!branchMatch);
  const branch = branchMatch ? branchMatch[1] : "";
  check("(4b) keyed on the sessionId itself, not IP or user id", /rateLimit\(`generate-session:\$\{body\.sessionId\}`/.test(branch));
  check("(4c) limit is 5/hour", /limit: 5,\s*windowMs: 60 \* 60 \* 1000/.test(branch));
  check("(4d) a 429 with Retry-After is returned when exhausted", /status: 429, headers: \{ "Retry-After": String\(sessionLimited\.retryAfterSec\) \}/.test(branch));
  // Sanity: this is genuinely a SIBLING branch to the authenticated userLimited
  // check above (else-if), not a replacement for it.
  check("(4e) sanity: the pre-existing authenticated per-user limiter (paid.verifiedUserId) is untouched", /rateLimit\(`generate-user:\$\{paid\.verifiedUserId\}`/.test(src));
}

console.log("(5) lib/rate-limit.ts: per-isolate concurrent-fan-out gap documented");
{
  const src = readFileSync(new URL("../lib/rate-limit.ts", import.meta.url), "utf8");
  check("(5a) the top-of-file comment names Cloudflare running multiple concurrent isolates", /Workers routinely runs MULTIPLE isolates for this same Worker script/.test(src) && /CONCURRENTLY/.test(src));
  check("(5b) confirms there is no Durable Object/coordination primitive in the request path today", /no Durable Object or other coordination primitive in the API request/.test(src));
  check("(5c) explicitly flags this as needing Algy's sign-off, not something to ship unilaterally", /need Algy's sign-off/.test(src) && /not\s*\n\/\/ something to build and ship unilaterally/.test(src));
  check("(5d) the rateLimit() function itself is untouched -- this was a documentation fix, not a behavior change", /export function rateLimit\(\s*key: string,\s*\{ limit, windowMs \}: RateLimitOptions\s*\): RateLimitResult \{/.test(src));
}

console.log("(6) app/api/health/route.ts: GET now rate-limited before the Supabase ping");
{
  const src = readFileSync(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  check("(6a) rateLimit + clientKeyFromRequest imported", /import \{ rateLimit, clientKeyFromRequest \} from "@\/lib\/rate-limit";/.test(src));
  check("(6b) GET now takes a req param", /export async function GET\(req: Request\) \{/.test(src));
  const fnMatch = src.match(/export async function GET\(req: Request\) \{([\s\S]*)/);
  const fn = fnMatch ? fnMatch[1] : "";
  const limitIdx = fn.indexOf("rateLimit(`health:");
  const checksIdx = fn.indexOf("const checks = {");
  check("(6c) the rate-limit check exists and runs BEFORE the checks object (and its checkSupabase() call) is built", limitIdx >= 0 && checksIdx >= 0 && limitIdx < checksIdx);
  check("(6d) generous cap (60/min) matches a monitoring endpoint's real periodic-caller traffic, not a tight abuse cap", /limit: 60, windowMs: 60 \* 1000/.test(fn));
  check("(6e) a 429 is returned on exhaustion with the no-store header preserved (this route's own stale-cache fix from an earlier round)", /status: 429,[\s\S]{0,150}"Cache-Control": "no-store, must-revalidate"/.test(fn));
}

console.log("(7) app/api/stripe/checkout/route.ts + app/privacy/page.tsx: Subscription metadata copy removed, Session-level retention disclosed");
{
  const checkoutSrc = readFileSync(new URL("../app/api/stripe/checkout/route.ts", import.meta.url), "utf8");
  check("(7a) subscription_data.metadata block is gone", !/subscription_data:\s*\{\s*metadata:/.test(checkoutSrc));
  check("(7b) the Checkout Session's own top-level metadata (the one field the SDK actually supports updating -- it doesn't) is still present", /metadata: \{\s*alpha_first_name: body\.firstName \?\? "",\s*alpha_city: body\.city \?\? "",\s*\},/.test(checkoutSrc));

  const privacySrc = readFileSync(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");
  check(
    "(7c) privacy policy discloses that name/city sent to Stripe at checkout survive on the Stripe checkout record permanently, even after account deletion",
    /Your first name and city also go to Stripe at checkout/.test(privacySrc) &&
      /own checkout record itself can&apos;t be edited or removed afterward/.test(privacySrc) &&
      /your name and city stay on that one record\s*\n\s*at Stripe, permanently/.test(privacySrc)
  );
}

console.log("(8) lib/stripe-cancel.ts + call sites: orphaned (user_id NULL) support tickets now covered by export and delete");
{
  const cancelSrc = readFileSync(new URL("../lib/stripe-cancel.ts", import.meta.url), "utf8");
  const fnMatch = cancelSrc.match(/export async function deleteSupportTicketsBeforeDelete\(([\s\S]*?)\n\}/);
  check("(8a) deleteSupportTicketsBeforeDelete was found", !!fnMatch);
  const fn = fnMatch ? fnMatch[1] : "";
  check("(8b) signature now takes an optional email param", /email\?: string \| null/.test(cancelSrc));
  check("(8c) when email is present, ALSO deletes orphaned (user_id IS NULL) rows matching it", /if \(email\) \{[\s\S]*?\.is\("user_id", null\)[\s\S]*?\.ilike\("email", escapedEmail\)/.test(fn));
  check("(8d) the email is wildcard-escaped before use in ilike (% and _ are ILIKE metacharacters)", /escapedEmail = email\.replace\(\/\[\\\\%_\]\/g, "\\\\\$&"\)/.test(fn));

  const acctDeleteSrc = readFileSync(new URL("../app/api/account/delete/route.ts", import.meta.url), "utf8");
  check("(8e) account/delete's call site now passes user.email", /deleteSupportTicketsBeforeDelete\(svc, user\.id, "\[account\/delete\]", user\.email\)/.test(acctDeleteSrc));

  const adminSrc = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(8f) admin/users's call site now passes targetUser?.email", /deleteSupportTicketsBeforeDelete\(sb, body\.userId, "\[admin\/delete\]", targetUser\?\.email\)/.test(adminSrc));

  const exportSrc = readFileSync(new URL("../app/api/account/export/route.ts", import.meta.url), "utf8");
  check("(8g) export route queries orphaned support_tickets the same way (user_id IS NULL, escaped ilike on email)", /\.is\("user_id", null\)[\s\S]*?\.ilike\("email", escapedEmail\)/.test(exportSrc));
  check("(8h) export response merges both sets into support_tickets", /support_tickets: \[\.\.\.supportTickets, \.\.\.orphanedSupportTickets\]/.test(exportSrc));
}

console.log("(9) lib/engine/topic-blurb.ts: finalizeBlurb's shape guard now validates ref label/note types");
{
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(9a) isStringOrAbsent helper exists", /const isStringOrAbsent = \(v: unknown\): boolean => v === undefined \|\| v === null \|\| typeof v === "string";/.test(src));
  check("(9b) primaryRef.label/.note are validated, dropping the item if either is a truthy non-string", /if \(it\.primaryRef && \(!isStringOrAbsent\(it\.primaryRef\.label\) \|\| !isStringOrAbsent\(it\.primaryRef\.note\)\)\) return false;/.test(src));
  check("(9c) supplementaryRefs[].label/.note are validated the same way", /it\.supplementaryRefs\.some\(\(r\) => !isStringOrAbsent\(r\?\.label\) \|\| !isStringOrAbsent\(r\?\.note\)\)/.test(src));
  check("(9d) the corrected comment no longer claims sanitizeVoice 'wouldn't crash' on bad input", /which was never actually true for this input class/.test(src));

  // Behavioral proof: replicate isStringOrAbsent's real logic (it's a local
  // closure, not exported) and confirm it actually rejects a truthy
  // non-string the way the shape guard depends on.
  const isStringOrAbsent = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
  check("(9e) behavioral: isStringOrAbsent accepts undefined", isStringOrAbsent(undefined) === true);
  check("(9f) behavioral: isStringOrAbsent accepts null", isStringOrAbsent(null) === true);
  check("(9g) behavioral: isStringOrAbsent accepts a real string", isStringOrAbsent("a real label") === true);
  check("(9h) behavioral: isStringOrAbsent REJECTS a bare number (the exact crash-inducing input class)", isStringOrAbsent(2026) === false);
  check("(9i) behavioral: isStringOrAbsent REJECTS a bare object", isStringOrAbsent({ not: "a string" }) === false);
}

console.log("(10) lib/engine/gemini-client.ts + lib/engine/openai-compat.ts: finish-reason whitelisting");
{
  const geminiSrc = readFileSync(new URL("../lib/engine/gemini-client.ts", import.meta.url), "utf8");
  const genTextMatch = geminiSrc.match(/export async function geminiGenerateText\(([\s\S]*?)\n\}/);
  check("(10a) geminiGenerateText was found", !!genTextMatch);
  const genText = genTextMatch ? genTextMatch[1] : "";
  check("(10b) whitelists ONLY 'STOP' (throws on any other present finish reason), not blacklisting MAX_TOKENS alone", /if \(finish && finish !== "STOP"\) \{\s*throw new GeminiTruncatedError/.test(genText));
  check("(10c) the old MAX_TOKENS-only check is gone from this function", !/finish === "MAX_TOKENS"/.test(genText));
  // geminiGroundedSearch was ALREADY correct before r28 -- sanity check it's
  // still the reference shape this fix was matched to, untouched by this round.
  const groundedMatch = geminiSrc.match(/export async function geminiGroundedSearch\(([\s\S]*?)\n\}/);
  const grounded = groundedMatch ? groundedMatch[1] : "";
  check("(10d) sanity: geminiGroundedSearch's pre-existing STOP-whitelist is intact, unchanged by this fix", /if \(finish && finish !== "STOP"\) return undefined;/.test(grounded));

  const compatSrc = readFileSync(new URL("../lib/engine/openai-compat.ts", import.meta.url), "utf8");
  const extractMatch = compatSrc.match(/export function extractCompatText\(([\s\S]*?)\n\}/);
  check("(10e) extractCompatText was found", !!extractMatch);
  const extract = extractMatch ? extractMatch[1] : "";
  check("(10f) whitelists ONLY 'stop' (throws on any other present finish_reason), not blacklisting 'length' alone", /if \(finish && finish !== "stop"\) \{\s*throw new TruncatedErrorCtor/.test(extract));
  check("(10g) the old length-only check is gone", !/finish_reason === "length"/.test(extract));

  // Behavioral proof: actually call extractCompatText with a content_filter
  // stop (the exact non-truncation-but-still-bad case this fix closes) and
  // confirm it throws, not just that the string "stop" appears in source.
  const { extractCompatText } = await import("../lib/engine/openai-compat.ts");
  class FakeTruncated extends Error {}
  let threwOnContentFilter = false;
  try {
    extractCompatText(
      { choices: [{ message: { content: "partial" }, finish_reason: "content_filter" }] },
      "TestProvider",
      1000,
      FakeTruncated
    );
  } catch (e) {
    threwOnContentFilter = e instanceof FakeTruncated;
  }
  check("(10h) behavioral: extractCompatText throws TruncatedErrorCtor on finish_reason='content_filter' (a moderation stop, not just length)", threwOnContentFilter);

  let acceptedCleanStop = true;
  try {
    const text = extractCompatText(
      { choices: [{ message: { content: "a clean finish" }, finish_reason: "stop" }] },
      "TestProvider",
      1000,
      FakeTruncated
    );
    acceptedCleanStop = text === "a clean finish";
  } catch {
    acceptedCleanStop = false;
  }
  check("(10i) behavioral: extractCompatText still accepts a clean finish_reason='stop' response", acceptedCleanStop);

  let acceptedAbsentFinish = true;
  try {
    const text = extractCompatText(
      { choices: [{ message: { content: "no finish_reason at all" } }] },
      "TestProvider",
      1000,
      FakeTruncated
    );
    acceptedAbsentFinish = text === "no finish_reason at all";
  } catch {
    acceptedAbsentFinish = false;
  }
  check("(10j) behavioral: extractCompatText tolerates an ABSENT finish_reason (a legitimately omittable field), same tolerance as gemini-client.ts", acceptedAbsentFinish);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R28 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R28 FINDINGS ASSERTIONS PASS");
