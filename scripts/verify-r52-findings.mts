// Verify round 52 findings: 1 auto-confirmed + 1 personally-verified-and-
// fixed despite a 2/3 refutation, out of 5 raw findings across 5 dimensions
// (0 UNVERIFIED, verify stage worked cleanly).
// - app/inbox/page.tsx + app/inbox/[issueId]/page.tsx + app/archive/page.tsx:
//   a shared "alpha-drift-r16-15" comment (present-tense "the pending
//   migration") described 20260807000000_issues_rls_active_access_only.sql
//   as still not-yet-shipped -- it's been live for two weeks. Reworded all
//   3 files (they cross-reference each other) to past tense.
// - app/api/resume/route.ts: round 51's own fix (alpha-drift-r51-02) named
//   only 8 of the trigger's actual 10 locked columns, missing bounced_at/
//   complained_at (added by a LATER migration, 20260806030000, that
//   redefines the same function). This finding was REFUTED 2/3 by the
//   automated panel, but personally re-verified via direct grep against
//   the real migration file -- the factual claim is 100% accurate (unlike
//   the round-51 webhook finding, this is a pure list-completeness
//   question with an objectively verifiable answer, not a severity/
//   reachability judgment call better left to the panel) -- fixed anyway.
// A HIGH-severity idempotency-key finding on app/api/stripe/update-quantity/
// route.ts (a post-success response-lost retry could double-apply a tier
// change) was ALSO personally re-verified given the severity and Stripe-
// billing stakes: the underlying idempotency-key design flaw IS real, but
// all 3 independent verify votes converged on the same two rebuttal points
// (confirmTier()'s actual retry path requires deliberately re-navigating
// the full 2-step trigger+confirm UI flow, not a low-friction accidental
// retry; and the suggested fix, isDuplicateSubmission(), is an in-memory
// per-isolate Map that wouldn't reliably survive a retry landing on a
// DIFFERENT Cloudflare Worker isolate anyway) -- confirmed both points by
// reading the real client code, respected the refutation with genuine
// understanding rather than trusting the vote count alone. Also refuted: a
// changelog-entries-look-duplicated finding (changelog entries are
// point-in-time historical records, not something this marathon corrects
// retroactively) and a support_tickets initial-schema self-contradiction
// finding present since inception (editing an already-applied initial
// migration's historical comment isn't this marathon's practice; the
// finding itself notes zero functional impact).
// alpha-drift-r52-01 and r52-02, both 2026-08-20.
// Run: npx tsx scripts/verify-r52-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/inbox/page.tsx + siblings: the 'pending RLS migration' comment now reads past tense");
{
  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(1a) app/inbox/page.tsx no longer calls it 'the pending migration'", !/RLS enforces this too once the pending/.test(inboxSrc));
  check("(1b) it now says RLS also enforces this, live since 2026-08-07", /RLS also enforces this\s*\n\s*\/\/ \(20260807000000_issues_rls_active_access_only\.sql, live since\s*\n\s*\/\/ 2026-08-07/.test(inboxSrc));

  const issueIdSrc = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(1c) app/inbox/[issueId]/page.tsx no longer says 'can't wait on the pending RLS migration'", !/why this can't wait\s*\n\s*\/\/ on the pending RLS migration/.test(issueIdSrc));

  const archiveSrc = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(1d) app/archive/page.tsx no longer says 'can't wait on the pending RLS migration'", !/why this\s*\n\s*\/\/ can't wait on the pending RLS migration/.test(archiveSrc));
}

console.log("(2) app/api/resume/route.ts: the privileged-columns list now names all 10 currently-locked columns (personally verified fix despite a 2/3 refutation)");
{
  const src = readFileSync(new URL("../app/api/resume/route.ts", import.meta.url), "utf8");
  check("(2a) bounced_at is now named", /bounced_at\//.test(src));
  check("(2b) complained_at is now named", /complained_at\//.test(src));
  check("(2c) the superseding migration is cited", /20260806030000_resend_webhook_\s*\n\/\/ deliverability\.sql/.test(src));
}

console.log("(3) sanity: the refuted HIGH-severity update-quantity idempotency finding was deliberately left unchanged (personally re-verified, refutation respected)");
{
  const src = readFileSync(new URL("../app/api/stripe/update-quantity/route.ts", import.meta.url), "utf8");
  check("(3a) the idempotency key is unchanged from before round 52 (still scoped to currentQty/nextQty, not a logical-request key)", /const idemKey = `alpha-qty-\$\{sub\.id\}-\$\{currentQty\}-\$\{nextQty\}-\$\{Math\.floor\(Date\.now\(\) \/ 30000\)\}`;/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R52 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R52 FINDINGS ASSERTIONS PASS");
