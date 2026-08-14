// Verify round 22 finding (alpha-drift-r22-04, 2026-08-14, HIGH): birthday
// was never validated for real before Stripe charged the card, but
// /api/generate's BodySchema.parse() rejects a malformed one with a
// deterministic 400 -- and that parse runs BEFORE verifyPaid(), so the
// rejection has nothing to do with whether the charge was real. Worse, the
// customer isn't signed in yet at that point (sign-in happens inside a
// SUCCESSFUL generate call), so a paid subscriber who somehow got a bad
// birthday into onboarding state had no session, no settings page, and thus
// no self-service way to fix it -- just a "Try again" button that reloads
// into the exact same 400, forever.
//
// The fix has two independent layers:
//   1. app/you/page.tsx: Continue is now gated on the SAME parseBirthday
//      rule the server enforces, via a new `birthdayValid` check -- a
//      malformed birthday can no longer leave onboarding through normal use.
//   2. app/writing/page.tsx: defense in depth. If /api/generate ever DOES
//      400 (e.g. a value that predates this fix, sitting in a returning
//      visitor's localStorage), attemptGenerate now self-heals ONCE by
//      retrying with birthday/gender stripped -- both are optional fields
//      in ProfileSchema, so dropping them still lets an already-paid
//      customer's letter generate (just without zodiac/tone personalization)
//      instead of leaving them permanently stuck.
//
// Full E2E (real Stripe checkout -> real malformed birthday -> real 400 ->
// real self-heal) isn't practical here: it needs a genuine completed Stripe
// Checkout session server-side (verifyPaid reads real Stripe state), which
// this script can't fabricate outside a real payment. Instead: exercise the
// real shared validator (lib/demographics.ts's parseBirthday, the actual
// function both layers now call) against realistic malformed inputs, and
// pin the actual source of both fixed files so a future edit that silently
// drops either layer fails this check instead of shipping unnoticed.
// Run: npx tsx scripts/verify-birthday-validation-timing.mts
import { readFileSync } from "node:fs";
import { parseBirthday, maxBirthdayForMinAge } from "../lib/demographics.ts";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) parseBirthday rejects the exact class of value the OLD /you gate let through");
{
  // The old gate was `birthday.length > 0` -- any non-empty string passed,
  // including these, which the server-side Zod refine has always rejected.
  check("(1a) year before 1900 rejected", parseBirthday("1899-12-31") === null);
  check("(1b) impossible calendar date (Feb 30) rejected", parseBirthday("2020-02-30") === null);
  check("(1c) under the site's own minimum-age floor rejected", parseBirthday(maxBirthdayForMinAge().slice(0, 4) + "5-06-15") === null);
  check("(1d) garbage shape rejected", parseBirthday("not-a-date") === null);
  check("(1e) a genuinely valid, old-enough birthday still passes", parseBirthday("1990-06-15") !== null);
  // Sanity: all five of the above are non-empty strings, so `.length > 0`
  // alone -- the old rule -- would have said every one of them was fine.
  check(
    "(1f) sanity: the OLD length-only rule would have waved all 4 bad ones through",
    ["1899-12-31", "2020-02-30", maxBirthdayForMinAge().slice(0, 4) + "5-06-15", "not-a-date"].every((s) => s.length > 0)
  );
}

console.log("(2) source: app/you/page.tsx gates Continue on the real parseBirthday rule");
{
  const src = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  check("(2a) imports parseBirthday from lib/demographics", /import\s*\{[^}]*parseBirthday[^}]*\}\s*from\s*"@\/lib\/demographics"/.test(src));
  check("(2b) computes a birthdayValid flag via parseBirthday", /const birthdayValid = birthday\.length === 0 \|\| parseBirthday\(birthday\) !== null/.test(src));
  check("(2c) canContinue actually includes birthdayValid, not just the old zodiac/length check", /const canContinue = \(!zodiacPicked \|\| birthday\.length > 0\) && birthdayValid/.test(src));
  check("(2d) the helper text surfaces an invalid-date message to the reader", /doesn't look right/.test(src));
}

console.log("(3) source: app/writing/page.tsx self-heals a 400 by stripping birthday/gender once");
{
  const src = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(3a) tracks a one-shot demographicsStripped flag", /let demographicsStripped = false/.test(src));
  check("(3b) the request body honors that flag by omitting birthday/gender", /demographicsStripped\s*\?\s*\{\s*\.\.\.profile,\s*birthday:\s*undefined,\s*gender:\s*undefined\s*\}\s*:\s*profile/.test(src));
  check(
    "(3c) a 400 (and only a 400 -- not other statuses) triggers the self-heal, gated to fire once",
    /r\.status === 400 &&\s*\n\s*!demographicsStripped &&\s*\n\s*\(profile\.birthday \|\| profile\.gender\)/.test(src)
  );
  check("(3d) the self-heal actually flips the flag before retrying", /demographicsStripped = true;\s*\n\s*retryTimer = setTimeout\(\(\) => attemptGenerate\(retriesLeft\), 0\)/.test(src));
  // The generic recovery card ("Try again", "Go to inbox") must still exist
  // for genuinely non-demographic failures (a real engine hiccup) -- this
  // fix is defense in depth for ONE specific cause, not a replacement for
  // the existing catch-all UI.
  check("(3e) the generic error recovery card is still intact for other failure classes", /Hiccup writing your first letter\./.test(src));
}

console.log("(4) alpha-drift-r22-06 (found+fixed 2026-08-14): /you's Skip button no longer discards a freshly-typed birthday/gender it never saved");
{
  const src = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  const skipFnMatch = src.match(/function skip\(\)[\s\S]*?\n  \}/);
  const skipFn = skipFnMatch ? skipFnMatch[0] : "";
  check("(4a) a dedicated skip() function exists (not an inline navigate-only handler)", skipFn.length > 0);
  check("(4b) the Skip button now calls skip(), not a bare router.push", /onClick=\{skip\}/.test(src));
  check("(4c) skip() calls update() -- it no longer just navigates away silently", /update\(\{/.test(skipFn));
  check("(4d) skip() saves gender the same way submit() does", /gender: coerceGender\(gender\) \?\? undefined/.test(skipFn));
  check(
    "(4e) skip() only saves birthday when it's actually valid -- an in-progress/invalid birthday is dropped, not saved malformed (same rule as canContinue)",
    /birthday: birthdayValid \? \(birthday \|\| undefined\) : undefined/.test(skipFn)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("BIRTHDAY-VALIDATION-TIMING VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL BIRTHDAY-VALIDATION-TIMING ASSERTIONS PASS");
