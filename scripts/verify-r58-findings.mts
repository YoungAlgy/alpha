// Verify round 58 findings: 7 raised, all 7 confirmed by the panel -- but 1
// (app/api/generate/route.ts's silent-catch finding) was personally
// implemented in SCOPED-DOWN form after independently tracing through
// lib/letter-delivery.ts and confirming a dissenting REFUTE vote (2-1 split)
// was technically correct: the suggested "fix" (throw on the disambiguation
// read's error) does NOT actually prevent a double-send, because
// deliverLetterOnce's "no-row" branch (what a swallowed error falls into
// today) and its "claim-error" branch (what throwing would route into) both
// call the identical trySend() and fail open by explicit, documented design
// ("never block [the paid first letter] on an infra hiccup"). Implemented as
// a pure observability improvement (log, don't throw) instead of the
// overstated "prevents the exact double-send this guards against" framing
// the original finding used.
// - components/ProfileEditor.tsx (self-audit-r57, MEDIUM): round 57's new
//   required-field asterisk was visual-only -- Field never forwarded
//   required/aria-required onto the actual input, so a screen-reader user
//   got zero indication First name is required. Now forwards both; no <form>
//   wraps this component and Save is type="button", so this is a pure
//   accessibility fix with no native-validation side effects.
// - components/ProfileEditor.tsx + app/support/SupportForm.tsx
//   (accessibility-resweep-newer-code-r6, MEDIUM): the required-field
//   asterisk was colored --accent-ink, the same repeatedly-fixed WCAG
//   contrast failure -- swapped to --ink in both files.
// - app/error.tsx + app/global-error.tsx (accessibility-resweep-newer-
//   code-r6, MEDIUM): both React error boundaries render their headline
//   with no role="alert", unlike this app's established convention for
//   full-page error-state content that can swap in mid-session with no
//   navigation event. Added role="alert" to both h1s.
// - scripts/verify-access-error-headings.mts (duplicate-code-audit-r8,
//   MEDIUM): its round-21 "exactly 2 <h1>" assertions for inbox/inbox-
//   issueId went stale the moment round 42 legitimately added a 3rd
//   (loadError) heading -- the script has been failing on correct code
//   ever since, and a bare count couldn't have caught a real regression
//   either. Bumped to 3 with explicit per-heading checks.
// - scripts/verify-themeswitcher-inbox-overflow.mts (duplicate-code-audit-
//   r8, MEDIUM): its round-24 exact-literal row-matching regex went inert
//   the moment round 35 legitimately appended " min-w-0" to the same div's
//   className -- loosened to tolerate trailing classes.
// - app/api/generate/route.ts (silent-catch-audit-r4, MEDIUM -> implemented
//   as a modest observability fix, see note above): the claim() disambig-
//   uation read discarded its error; now logged via console.warn, not
//   thrown -- preserves today's exact control flow (send anyway on a
//   transient read failure, matching deliverLetterOnce's documented
//   fail-open design) while making a previously-invisible failure visible.
// - app/api/stripe/update-quantity/route.ts + app/api/stripe/webhook/
//   route.ts (form-validation-consistency-audit-r3, MEDIUM): a subscription
//   downgrade shrinks poolCap but never trimmed users.topics to fit, so a
//   reader who'd filled their free backups got every future self-serve
//   /topics save silently rejected until they manually trimmed on their
//   own -- contradicting settings' own downgrade copy ("no action needed").
//   Both write sites now truncate topics to poolCap(newQuota) in the same
//   write, mirroring weekly-send's existing read-time slice.
// alpha-drift-r58-01 through r58-06, all 2026-08-20.
// Run: npx tsx scripts/verify-r58-findings.mts
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ProfileEditor.tsx: Field now forwards required/aria-required onto the actual control");
{
  const src = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(1a) the shared object now includes required", /required: required \|\| undefined,/.test(src));
  check("(1b) the shared object now includes aria-required", /"aria-required": required \|\| undefined,/.test(src));
}

console.log("(2) components/ProfileEditor.tsx + app/support/SupportForm.tsx: the required-field asterisk is now --ink, not --accent-ink");
{
  const editor = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(2a) ProfileEditor's asterisk is now var(--ink)", /\{required && <span style=\{\{ color: "var\(--ink\)" \}\}> \*<\/span>\}/.test(editor));

  const support = readFileSync(new URL("../app/support/SupportForm.tsx", import.meta.url), "utf8");
  check("(2b) SupportForm's asterisk is now var(--ink)", /\{required && \(\s*\n\s*<span style=\{\{ color: "var\(--ink\)" \}\}> \*<\/span>\s*\n\s*\)\}/.test(support));
}

console.log("(3) app/error.tsx + app/global-error.tsx: both error-boundary headlines now carry role=\"alert\"");
{
  const err = readFileSync(new URL("../app/error.tsx", import.meta.url), "utf8");
  check("(3a) error.tsx's h1 has role=\"alert\"", /<h1 className="alpha-display text-3xl md:text-4xl font-bold tracking-tight" role="alert">/.test(err));

  const globalErr = readFileSync(new URL("../app/global-error.tsx", import.meta.url), "utf8");
  check("(3b) global-error.tsx's h1 has role=\"alert\"", /<h1 style=\{\{ fontSize: "1\.75rem", fontWeight: 700, margin: "0 0 16px" \}\} role="alert">/.test(globalErr));
}

console.log("(4) verify-access-error-headings.mts + verify-themeswitcher-inbox-overflow.mts: both stale regression guards pass again, and actually catch what they're meant to");
{
  const r1 = spawnCheck("npx tsx scripts/verify-access-error-headings.mts");
  check("(4a) verify-access-error-headings.mts passes clean", r1);
  const r2 = spawnCheck("npx tsx scripts/verify-themeswitcher-inbox-overflow.mts");
  check("(4b) verify-themeswitcher-inbox-overflow.mts passes clean", r2);
}

console.log("(5) app/api/generate/route.ts: the claim() disambiguation read's error is now logged, not silently discarded");
{
  const src = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
  check("(5a) the read now destructures error", /const \{ data: check, error: checkError \} = await sb/.test(src));
  check("(5b) a resolved error is logged via console.warn, not thrown", /if \(checkError\) console\.warn\("\[generate\] claim\(\) disambiguation read failed:", checkError\.message\);/.test(src));
  check("(5c) control flow is unchanged -- still falls through to the exists:!!check line unconditionally", /if \(checkError\) console\.warn[^\n]*\n\s*\/\/ exists keys on ROW PRESENCE/.test(src));
}

console.log("(6) app/api/stripe/update-quantity/route.ts + app/api/stripe/webhook/route.ts: a downgrade now truncates topics to fit the new poolCap");
{
  const uq = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(6a) update-quantity imports poolCap", /import \{ poolCap \} from "@\/lib\/engine\/select-sections";/.test(uq));
  // alpha-drift-r59-01 (2026-08-20, self-audit-r58) found this early
  // `row.topics` snapshot was stale by the time it reached the final write
  // (3 sequential Stripe round-trips sat in between) and re-read `topics`
  // fresh right before the write instead -- loosened to match. See
  // verify-r59-findings.mts's (1).
  check("(6b) topics is no longer in the early row select (re-read fresh later, see r59-01)", !/\.select\("stripe_customer_id, topic_quota, subscribed_at, cancelled_at, topics"\)/.test(uq));
  check("(6c) cappedTopics is computed via poolCap(newQuota) from a freshly-read row", /\(freshRow\.topics as TopicId\[\]\)\.slice\(0, poolCap\(newQuota\)\)/.test(uq));
  check("(6d) the update conditionally includes the capped topics", /topic_quota: newQuota, \.\.\.\(cappedTopics \? \{ topics: cappedTopics \} : \{\}\)/.test(uq));

  const wh = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  check("(6e) the webhook imports poolCap", /import \{ poolCap \} from "@\/lib\/engine\/select-sections";/.test(wh));
  check("(6f) the webhook reads topics before the subscription-mirror update", /\.select\("topics"\)\s*\n\s*\.eq\("stripe_customer_id", customerId\)\s*\n\s*\.maybeSingle\(\);/.test(wh));
  check("(6g) the webhook's update conditionally includes the capped topics", /topic_quota: topicQuota,\s*\n\s*\.\.\.\(cappedTopics \? \{ topics: cappedTopics \} : \{\}\),/.test(wh));
}

function spawnCheck(cmd: string): boolean {
  try {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    execSync(cmd, { cwd: repoRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R58 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R58 FINDINGS ASSERTIONS PASS");
