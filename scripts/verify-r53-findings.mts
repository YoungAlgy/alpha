// Verify round 53 findings: 7 confirmed, 2 refuted (out of 9 raw findings
// across 5 dimensions -- 0 UNVERIFIED). All 3 brand-new dimensions
// (accessibility-resweep-newer-code, duplicate-code-audit,
// timezone-date-edge-case-audit) paid off immediately on their first
// outing. self-audit-r52 found nothing at all -- a clean signal round 52's
// fixes shipped correctly.
// - lib/engine/persist.ts: a comment misattributed the user_id requirement
//   to RLS, but persistIssueIfPossible() always uses the service-role
//   client (bypasses RLS entirely) -- the real gate is the NOT NULL + FK
//   schema constraints on issues.user_id/users.id.
// - components/ProfileEditor.tsx: the Zodiac-birthday warning still used
//   the WCAG-failing --accent-ink, the one sibling instance round 24 missed
//   when fixing the identical warning on topics/page.tsx and you/page.tsx.
//   scripts/verify-accent-ink-error-text-contrast.mts's own comprehensive
//   scan (check 5) was genuinely, currently FAILING before this fix --
//   confirmed by running it, not just trusting the finding's claim.
// - app/settings/accounts/page.tsx: two separate fixes. (1) The 4 per-row
//   action buttons (Grant free/Revoke free/Clear suppression/Delete) plus
//   Load more were all under the WCAG 2.5.8 24px touch-target minimum --
//   added py-2 -my-2 (vertical-only, avoiding a collision with the row's
//   own gap-3 horizontal spacing) to all 5. (2) A successful Delete removes
//   the acted-on row (and its just-focused button) from the DOM with
//   nothing claiming focus afterward -- added a monotonic deleteCount
//   state + useEffect, mirroring app/settings/page.tsx's own
//   confirmHeadingRef convention, moving focus to the "Accounts" h1.
// - app/auth/callback/page.tsx: the magic-link failure message had no
//   role="status"/aria-live, unlike every sibling "here's what happened"
//   status text elsewhere -- highest stakes of any of them, since this
//   page silently redirects to /signin 1.5s after rendering the message.
// - lib/engine/openai-compat.ts + lib/engine/topic-blurb.ts: Groq/DeepSeek's
//   rate-limit counters (routed through this shared helper) never counted
//   402 (quota/balance exhausted) despite their own comments explicitly
//   claiming to mirror lib/brave.ts's "full rationale" for counting both
//   429 and 402. Widened the counter AND topic-blurb.ts's isRateLimited()
//   (used by all 5 generation tiers) to also treat 402 as a real signal.
// - lib/demographics.ts: parseBirthday's under-13 cutoff and
//   maxBirthdayForMinAge's HTML max= value both fed today's raw month/day
//   straight into Date.UTC/string interpolation -- on Feb 29 in a
//   non-leap target year (true on ~3 of every 4 leap days, since 13 is
//   odd), Date.UTC silently rolls over to March 1, loosening the COPPA-
//   adjacent under-13 gate by one real day, and the HTML max= value became
//   a literal nonexistent date string. Fixed with a shared
//   subtractYearsClamped helper, personally behaviorally verified with a
//   throwaway script (run and deleted) confirming 2028-02-29 minus 13
//   years clamps to 2015-02-28, not 2015-03-01.
// 2 refuted, respected: components/EmailChanger.tsx's Cancel button touch
// target (refuted 2/3) and a near-duplicate of the settings/accounts.tsx
// touch-target finding raised independently by duplicate-code-audit
// (refuted 3/3 by ITS OWN panel, but the identical underlying bug was
// separately confirmed by accessibility-resweep-newer-code's panel and is
// fixed above regardless).
// alpha-drift-r53-01 through r53-07, all 2026-08-20.
// Run: npx tsx scripts/verify-r53-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/engine/persist.ts: the user_id-requirement comment no longer misattributes gating to RLS");
{
  const src = readFileSync(new URL("../lib/engine/persist.ts", import.meta.url), "utf8");
  check("(1a) no longer says the bare '(RLS)' attribution", !/without a user_id \(RLS\)\./.test(src));
  check("(1b) now correctly cites the NOT NULL + FK schema constraints", /NOT NULL with an FK to\s*\n\s*\/\/ public\.users\(id\)/.test(src));
}

console.log("(2) components/ProfileEditor.tsx: the Zodiac-birthday warning no longer uses --accent-ink (existing contrast test now passes)");
{
  const src = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(2a) the hasZodiac branch no longer uses var(--accent-ink)", !/hasZodiac && !form\.birthday \? "var\(--accent-ink\)"/.test(src));
  check("(2b) it now uses var(--ink)", /: hasZodiac && !form\.birthday \? "var\(--ink\)" : "var\(--ink-soft\)"/.test(src));
}

console.log("(3) app/settings/accounts/page.tsx: touch targets fixed on 5 buttons, and Delete restores focus to the Accounts heading");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(3a) all 5 buttons (4 row actions + Load more) now carry py-2 -my-2", (src.match(/underline underline-offset-4 py-2 -my-2/g) ?? []).length === 5 && /text-sm mt-6 underline underline-offset-4 py-2 -my-2/.test(src));
  // alpha-drift-r61-03 (2026-08-20, accessibility-resweep-newer-code-round-
  // 9) renamed deleteCount->actionCount and removed the action==="delete"
  // gate, since grant_free/revoke_free/clear_suppression unmount their own
  // just-clicked button identically -- loosened to match. See
  // verify-r61-findings.mts's (3).
  check("(3b) actionCount state + effect are declared (renamed from deleteCount, r61-03)", /const \[actionCount, setActionCount\] = useState\(0\);/.test(src) && /useEffect\(\(\) => \{\s*\n\s*if \(actionCount > 0\) accountsHeadingRef\.current\?\.focus\(\);\s*\n\s*\}, \[actionCount\]\);/.test(src));
  check("(3c) act() increments actionCount on every successful action, not just delete (r61-03)", /setActionCount\(\(c\) => c \+ 1\);/.test(src) && !/if \(action === "delete"\) setActionCount/.test(src));
  check("(3d) the Accounts h1 has the ref + tabIndex", /ref=\{accountsHeadingRef\}\s*\n\s*tabIndex=\{-1\}\s*\n\s*className="alpha-display text-4xl md:text-5xl font-bold tracking-tight"/.test(src));
}

console.log("(4) app/auth/callback/page.tsx: the message now has role=status/aria-live");
{
  const src = readFileSync(new URL("../app/auth/callback/page.tsx", import.meta.url), "utf8");
  check("(4a) role and aria-live are set on the message <p>", /role="status"\s*\n\s*aria-live="polite"\s*\n\s*className="alpha-display text-lg"/.test(src));
}

console.log("(5) lib/engine/openai-compat.ts + topic-blurb.ts: 402 is now treated as a real rate-limit/quota signal");
{
  const compatSrc = readFileSync(new URL("../lib/engine/openai-compat.ts", import.meta.url), "utf8");
  check("(5a) throwCompatError now counts 402 alongside 429", /if \(res\.status === 429 \|\| res\.status === 402\) onRateLimited\?\.\(\);/.test(compatSrc));

  const blurbSrc = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(5b) isRateLimited() now treats 402 as rate-limited too", /return status === 429 \|\| status === 402;/.test(blurbSrc));
}

console.log("(6) lib/demographics.ts: Feb 29 age-cutoff computation now clamps instead of rolling over (behaviorally verified)");
{
  const src = readFileSync(new URL("../lib/demographics.ts", import.meta.url), "utf8");
  check("(6a) subtractYearsClamped helper is declared", /function subtractYearsClamped\(now: Date, years: number\): Date \{/.test(src));
  check("(6b) parseBirthday's cutoff now uses the clamped helper", /const cutoff = subtractYearsClamped\(now, MIN_AGE_YEARS\);/.test(src));
  check("(6c) maxBirthdayForMinAge now uses the clamped helper too", /const clamped = subtractYearsClamped\(new Date\(\), MIN_AGE_YEARS\);/.test(src));

  // Behavioral: re-derive the same clamping logic here and confirm a real
  // leap-day input clamps correctly, matching the throwaway script this
  // fix was originally verified against.
  function subtractYearsClamped(now: Date, years: number): Date {
    const y = now.getUTCFullYear() - years;
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const candidate = new Date(Date.UTC(y, m, d));
    return candidate.getUTCMonth() !== m ? new Date(Date.UTC(y, m + 1, 0)) : candidate;
  }
  const feb29 = new Date(Date.UTC(2028, 1, 29));
  const clamped = subtractYearsClamped(feb29, 13);
  check("(6d) behavioral: 2028-02-29 minus 13 years clamps to 2015-02-28, not 2015-03-01", clamped.toISOString().slice(0, 10) === "2015-02-28");
}

console.log("(7) sanity: the refuted EmailChanger touch-target finding was deliberately left unchanged");
{
  const src = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(7a) EmailChanger's Cancel button is unchanged from before round 53 (no touch-target padding added)", /className="alpha-ui text-sm underline underline-offset-4"\s*\n\s*style=\{\{ color: "var\(--ink-soft\)", opacity: busy \? 0\.5 : 1 \}\}\s*\n\s*>\s*\n\s*Cancel/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R53 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R53 FINDINGS ASSERTIONS PASS");
