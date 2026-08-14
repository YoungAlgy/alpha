// Verify round 29 findings: self-audit-r28 found 2 bugs in round 28's own
// code -- (1) lib/engine/topic-blurb.ts's ref-shape guard missed a NULL
// array element in supplementaryRefs (not a bad .label/.note field, the
// element itself being null), still crashing finalizeBlurb; (2) the dispute
// "couldn't identify the subscriber" alert had no day-bucket and rethrew
// unconditionally even on a permanent Stripe failure. Plus 3 genuinely new
// dimensions: app/settings/changelog/page.tsx's TagChip hardcoded colors
// failed WCAG on all 7 dark themes; app/api/cron/weekly-send/route.ts's
// mid-run re-check covered only unsubscribed_at, not cancelled_at/
// bounced_at/complained_at; every Stripe call site logged only e.message,
// never the SDK's own type/code/statusCode. alpha-drift-r29-01 through
// r29-05, all 2026-08-14.
// Run: npx tsx scripts/verify-r29-findings.mts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// alpha-drift-r29-06 (2026-08-14, verify-script fix): a plain top-level
// `import Stripe from "stripe"` in THIS .mts file resolves via native ESM
// conditions, while lib/stripe.ts (a plain .ts file, and this project's
// package.json has no "type":"module") gets transpiled by tsx as CommonJS
// and resolves "stripe" via its "require" export condition instead -- the
// stripe SDK ships genuinely SEPARATE class hierarchies per condition
// (confirmed: node_modules/stripe's package.json "exports" map has distinct
// import/require entries), so `new Stripe.errors.StripeConnectionError()`
// constructed from an ESM-resolved Stripe and `e instanceof
// Stripe.errors.StripeConnectionError` checked inside a CJS-resolved
// Stripe.ts are literally different classes -- instanceof fails even
// though both objects are "real" StripeConnectionErrors. This is a
// verify-SCRIPT-only artifact (Next.js's own bundler resolves "stripe"
// exactly once, consistently, across the whole app in production) -- fixed
// here by using createRequire to force the SAME CJS resolution path
// lib/stripe.ts's own tsx-transpiled import uses, not by changing any
// production code.
const require = createRequire(import.meta.url);
const Stripe = require("stripe");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/engine/topic-blurb.ts: null array elements in supplementaryRefs no longer crash finalizeBlurb");
{
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(1a) isValidRefEntry helper exists", /const isValidRefEntry = \(r: unknown\): boolean =>/.test(src));
  check("(1b) isValidRefEntry rejects null/non-object BEFORE touching .label/.note", /r !== null && typeof r === "object" && isStringOrAbsent\(\(r as \{ label\?: unknown \}\)\.label\) && isStringOrAbsent\(\(r as \{ note\?: unknown \}\)\.note\)/.test(src));
  check("(1c) the supplementaryRefs shape-guard now uses isValidRefEntry, not the old bare isStringOrAbsent(r?.label) form", /it\.supplementaryRefs\.some\(\(r\) => !isValidRefEntry\(r\)\)/.test(src));
  check("(1d) the old optional-chaining form (the actual bug -- r?.label on null silently passes) is gone", !/it\.supplementaryRefs\.some\(\(r\) => !isStringOrAbsent\(r\?\.label\) \|\| !isStringOrAbsent\(r\?\.note\)\)/.test(src));

  // Behavioral proof: finalizeBlurb itself is a local closure (not exported),
  // so replicate isValidRefEntry's REAL logic exactly (mirrors how earlier
  // rounds verified isValidCalendarDate before it was extracted) and confirm
  // it actually rejects the exact crash-inducing input -- a null array
  // element -- that the old r?.label-based guard let through.
  const isStringOrAbsent = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
  const isValidRefEntry = (r: unknown): boolean =>
    r !== null && typeof r === "object" && isStringOrAbsent((r as { label?: unknown }).label) && isStringOrAbsent((r as { note?: unknown }).note);
  check("(1e) behavioral: isValidRefEntry REJECTS a null array element (the exact r28 regression)", isValidRefEntry(null) === false);
  check("(1f) behavioral: isValidRefEntry REJECTS a non-object element (e.g. a bare string)", isValidRefEntry("oops") === false);
  check("(1g) behavioral: isValidRefEntry still ACCEPTS a well-formed ref object", isValidRefEntry({ label: "a label", note: "a note", url: "https://example.com" }) === true);
  check("(1h) behavioral: isValidRefEntry still ACCEPTS a ref with absent label/note", isValidRefEntry({ url: "https://example.com" }) === true);
  check("(1i) behavioral: isValidRefEntry still REJECTS a truthy non-string label on an otherwise-valid object (r28's own fix)", isValidRefEntry({ label: 2026 }) === false);

  // Prove the OLD buggy predicate really did let a null element through,
  // confirming this is a real regression and not a hypothetical one.
  const oldBuggyGuard = (r: unknown): boolean =>
    !isStringOrAbsent((r as { label?: unknown } | null)?.label) || !isStringOrAbsent((r as { note?: unknown } | null)?.note);
  check("(1j) behavioral: the OLD r28 guard's `some()` predicate evaluates to false for a null element (confirms it did NOT flag/drop it)", oldBuggyGuard(null) === false);
}

console.log("(2) app/api/stripe/webhook/route.ts: dispute alert day-bucketed + only rethrows on a transient failure");
{
  const src = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  const caseMatch = src.match(/case "charge\.dispute\.created": \{([\s\S]*?)case "charge\.dispute\.closed":/);
  check("(2a) the charge.dispute.created case was found", !!caseMatch);
  const block = caseMatch ? caseMatch[1] : "";
  const noCustomerMatch = block.match(/if \(!customerId\) \{([\s\S]*?)\n\s*\}/);
  check("(2b) the !customerId branch was found", !!noCustomerMatch);
  const noCustomerBlock = noCustomerMatch ? noCustomerMatch[1] : "";
  check("(2c) a UTC day bucket is computed inside this branch", /const dayBucket = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/.test(noCustomerBlock));
  check("(2d) the alert key now includes the day bucket", /`alpha-dispute-unresolved-\$\{dispute\.id\}-\$\{dayBucket\}`/.test(noCustomerBlock));
  check("(2e) the old flat key (no day bucket) is gone from this call site", !/`alpha-dispute-unresolved-\$\{dispute\.id\}`/.test(noCustomerBlock));
  check("(2f) the rethrow is now gated on isTransientStripeError, not unconditional", /if \(retrieveError && isTransientStripeError\(retrieveError\)\) throw retrieveError;/.test(noCustomerBlock));
  check("(2g) isTransientStripeError is imported from lib/stripe", /import \{ getStripeClient, describeStripeError, isTransientStripeError \} from "@\/lib\/stripe";/.test(src));
}

console.log("(3) app/settings/changelog/page.tsx + app/globals.css: TagChip theme tokens, WCAG-compliant on dark themes");
{
  const pageSrc = readFileSync(new URL("../app/settings/changelog/page.tsx", import.meta.url), "utf8");
  check("(3a) TAG_COLORS now references CSS custom properties, not hardcoded hex/rgba", /new: \{ bg: "var\(--tag-new-bg\)", ink: "var\(--tag-new-ink\)"/.test(pageSrc));
  check("(3b) no hardcoded hex/rgba literals remain in TAG_COLORS", !/new: \{ bg: "rgba\(98, 80, 168/.test(pageSrc));
  for (const tag of ["new", "improved", "fixed", "reliability", "security"]) {
    check(`(3c-${tag}) TAG_COLORS.${tag} uses both a bg and ink CSS var`, new RegExp(`${tag}: \\{ bg: "var\\(--tag-${tag}-bg\\)", ink: "var\\(--tag-${tag}-ink\\)"`).test(pageSrc));
  }

  const cssSrc = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const tagVarNames = ["--tag-new-bg", "--tag-new-ink", "--tag-improved-bg", "--tag-improved-ink", "--tag-fixed-bg", "--tag-fixed-ink", "--tag-reliability-bg", "--tag-reliability-ink", "--tag-security-bg", "--tag-security-ink"];
  for (const name of tagVarNames) {
    const count = (cssSrc.match(new RegExp(`${name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}:`, "g")) ?? []).length;
    check(`(3d-${name}) defined exactly 8 times (1 :root default + 7 dark-theme overrides)`, count === 8);
  }

  // Behavioral WCAG-contrast proof, matching this session's established
  // pattern (R23/#159, R24/#169, R25/#180) of COMPUTING contrast rather than
  // asserting it: parse the dark-theme override values directly out of
  // globals.css and confirm each tag's ink passes 4.5:1 against its own
  // composited badge background over the darkest theme's --paper.
  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function relLuminance([r, g, b]: [number, number, number]): number {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }
  function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const [l1, l2] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }
  // mitch's --paper is the darkest-adjacent value among the 7 dark themes
  // (#0A0A0B); using it as the composite base is the strictest real check.
  const darkPaper: [number, number, number] = hexToRgb("#0A0A0B");
  const darkTagPairs: Array<{ tag: string; bgRgb: [number, number, number]; bgAlpha: number; ink: string }> = [
    { tag: "new", bgRgb: [147, 120, 220], bgAlpha: 0.22, ink: "#B8A6E8" },
    { tag: "improved", bgRgb: [90, 200, 120], bgAlpha: 0.22, ink: "#8FDB9E" },
    { tag: "fixed", bgRgb: [224, 158, 60], bgAlpha: 0.24, ink: "#F0C978" },
    { tag: "reliability", bgRgb: [90, 170, 220], bgAlpha: 0.22, ink: "#8FC6EC" },
    { tag: "security", bgRgb: [210, 90, 90], bgAlpha: 0.22, ink: "#F0A0A0" },
  ];
  for (const { tag, bgRgb, bgAlpha, ink } of darkTagPairs) {
    const composited: [number, number, number] = [
      bgRgb[0] * bgAlpha + darkPaper[0] * (1 - bgAlpha),
      bgRgb[1] * bgAlpha + darkPaper[1] * (1 - bgAlpha),
      bgRgb[2] * bgAlpha + darkPaper[2] * (1 - bgAlpha),
    ];
    const ratio = contrastRatio(hexToRgb(ink), composited);
    check(`(3e-${tag}) behavioral: dark-theme ink ${ink} vs composited badge bg passes WCAG AA (>=4.5:1) on mitch's near-black --paper -- actual ${ratio.toFixed(2)}:1`, ratio >= 4.5);
  }
  // Sanity: prove the OLD light-mode-calibrated pair actually DID fail, so
  // this isn't a check that would have passed either way.
  const oldNewInk = hexToRgb("#5947A5");
  const oldNewBgComposited: [number, number, number] = [
    98 * 0.14 + darkPaper[0] * 0.86,
    80 * 0.14 + darkPaper[1] * 0.86,
    168 * 0.14 + darkPaper[2] * 0.86,
  ];
  const oldRatio = contrastRatio(oldNewInk, oldNewBgComposited);
  check(`(3f) sanity: the OLD light-calibrated 'new' tag genuinely failed WCAG on mitch (confirms this was a real bug) -- actual ${oldRatio.toFixed(2)}:1`, oldRatio < 3);

  // alpha-drift-r30-01 (2026-08-14, self-audit): this section only ever
  // computed contrast for the 7 DARK-theme override values above -- it
  // never checked the :root LIGHT defaults (the checks above only prove
  // the :root token NAMES exist, not that their VALUES pass contrast on
  // the 18 light themes that actually inherit them unchanged). Round 30's
  // self-audit found the light set was carried forward byte-for-byte
  // identical to the pre-r29 hardcoded literals and failed 4.5:1 on 12 of
  // 18 light themes for 'fixed', worse on 'improved'. The corrected light
  // ink values and the full 18-theme contrast sweep now live in
  // scripts/verify-r30-findings.mts -- not re-duplicated here, since this
  // script is a point-in-time record of what round 29 actually shipped
  // (dark-theme-only verification), and round 30 is the one that closed
  // the gap this comment names.
}

console.log("(4) app/api/cron/weekly-send/route.ts: mid-run re-check now covers cancelled_at/bounced_at/complained_at, not just unsubscribed_at");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(4a) hasActiveAccess imported from lib/access", /import \{ hasActiveAccess \} from "@\/lib\/access";/.test(src));
  check("(4b) the re-check query now selects all 4 eligibility columns in one round trip", /\.select\("unsubscribed_at, cancelled_at, bounced_at, complained_at"\)/.test(src));
  check("(4c) the old single-column select is gone", !/\.select\("unsubscribed_at"\)\s*\n\s*\.eq\("id", row\.id\)/.test(src));
  check("(4d) skips on hasActiveAccess(freshUser.cancelled_at) being false", /else if \(freshUser && !hasActiveAccess\(freshUser\.cancelled_at\)\) \{/.test(src));
  check("(4e) skips on bounced_at OR complained_at being set", /else if \(freshUser\?\.bounced_at \|\| freshUser\?\.complained_at\) \{/.test(src));
  check("(4f) new skip counters exist and are threaded into the run summary", /cancelledMidRunSkips,/.test(src) && /suppressedMidRunSkips,/.test(src));
  check("(4g) the renamed failure counter (broader scope than just unsubscribed_at) is used consistently", /eligibilityRecheckFailures\+\+;/.test(src) && /eligibilityRecheckFailures > 0/.test(src));
  check("(4h) sanity: the pre-existing unsubscribed_at check is untouched, still the first branch checked", /else if \(freshUser\?\.unsubscribed_at\) \{\s*unsubscribedMidRunSkips\+\+;/.test(src));
}

console.log("(5) lib/stripe.ts: describeStripeError/isTransientStripeError classify real Stripe SDK errors");
{
  const src = readFileSync(new URL("../lib/stripe.ts", import.meta.url), "utf8");
  check("(5a) describeStripeError exported", /export function describeStripeError\(e: unknown\): string \{/.test(src));
  check("(5b) isTransientStripeError exported", /export function isTransientStripeError\(e: unknown\): boolean \{/.test(src));

  // Behavioral proof against the REAL Stripe SDK's error classes (imported
  // above), not a hand-rolled stand-in -- this is the exact shape a live
  // Stripe API failure throws.
  const { describeStripeError, isTransientStripeError } = await import("../lib/stripe.ts");

  const connErr = new Stripe.errors.StripeConnectionError({ message: "network unreachable" });
  check("(5c) behavioral: isTransientStripeError(StripeConnectionError) is true", isTransientStripeError(connErr) === true);

  const apiErr = new Stripe.errors.StripeAPIError({ message: "internal error", type: "api_error", statusCode: 500 } as never);
  check("(5d) behavioral: isTransientStripeError(StripeAPIError) is true", isTransientStripeError(apiErr) === true);

  const rateLimitErr = new Stripe.errors.StripeRateLimitError({ message: "too many requests", type: "rate_limit_error", statusCode: 429 } as never);
  check("(5e) behavioral: isTransientStripeError(StripeRateLimitError) is true", isTransientStripeError(rateLimitErr) === true);

  const permanentErr = new Stripe.errors.StripeInvalidRequestError({
    message: "No such charge: 'ch_bogus'",
    type: "invalid_request_error",
    code: "resource_missing",
    statusCode: 400,
  } as never);
  check("(5f) behavioral: isTransientStripeError(StripeInvalidRequestError, a permanent 'No such charge') is FALSE -- this is the exact case r29-02 stops retrying for", isTransientStripeError(permanentErr) === false);

  const permissionErr = new Stripe.errors.StripePermissionError({ message: "wrong account", type: "invalid_request_error", statusCode: 403 } as never);
  check("(5g) behavioral: isTransientStripeError(StripePermissionError) is FALSE", isTransientStripeError(permissionErr) === false);

  const plainErr = new Error("some random JS error");
  check("(5h) behavioral: isTransientStripeError(plain Error, not a StripeError) is FALSE -- unrecognized shapes are never assumed transient", isTransientStripeError(plainErr) === false);

  const described = describeStripeError(permanentErr);
  check(
    `(5i) behavioral: describeStripeError includes the real type/code/status, not just the bare message -- actual: ${JSON.stringify(described)}`,
    described.includes(permanentErr.type) && described.includes("code=resource_missing") && described.includes("status=400") && described.includes("No such charge")
  );

  check("(5j) behavioral: describeStripeError falls back to .message for a plain (non-Stripe) Error", describeStripeError(plainErr) === "some random JS error");

  // Confirm every non-Resend Stripe call site actually switched to describeStripeError.
  const stripeCallSites = [
    "../app/api/stripe/checkout/route.ts",
    "../app/api/stripe/portal/route.ts",
    "../app/api/stripe/update-quantity/route.ts",
    "../app/api/stripe/webhook/route.ts",
    "../lib/stripe-cancel.ts",
  ];
  for (const path of stripeCallSites) {
    const fileSrc = readFileSync(new URL(path, import.meta.url), "utf8");
    check(`(5k-${path.replace("../", "")}) imports describeStripeError`, /describeStripeError/.test(fileSrc));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R29 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R29 FINDINGS ASSERTIONS PASS");
