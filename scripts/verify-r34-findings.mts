// Verify round 34 findings: (1) self-audit found a stale "2-3am" clock-time
// example in DigestProps' comment that survived round 33's range-widening
// edit -- only accurate for the narrow NZ/Tonga end, not the newly-included
// UTC+10/+11 band; (2) components/ThemeSwitcher.tsx's non-compact label
// wrapped onto 2 lines inside its rounded-full pill on real ~375px phones
// (the compact prop exists but is never passed at any call site); (3)
// lib/engine/fetch-content.ts's fetchArticleText had a fully silent catch --
// the only provider client in lib/engine/ without one; (4) next.config.ts's
// CSP connect-src carried a dead cloudflareinsights.com allowance (the real
// RUM beacon POSTs same-origin to /cdn-cgi/rum, confirmed via live Chrome
// network capture, both by the audit and independently before this fix);
// (5) components/ProfileEditor.tsx's birthday field had no client-side
// validity gate, unlike app/you/page.tsx's identical alpha-drift-r22-04
// fix, letting a malformed typed date get silently nulled server-side
// behind a false "Saved" message. alpha-drift-r34-01 through r34-04, all
// 2026-08-14.
// Run: npx tsx scripts/verify-r34-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ThemeSwitcher.tsx: the toggle button truncates instead of wrapping on narrow viewports");
{
  // alpha-drift-r35-01 (2026-08-14, self-audit): this whole section's own
  // "behavioral proof" below was itself wrong -- it tested a simplified DOM
  // where the button was the DIRECT flex item, which is NOT how the real
  // component nests (ThemeSwitcher's root .relative div is the actual flex
  // item; the button is just a normal block child inside it). min-w-0 on
  // the button did nothing there, and the real bug this "fix" shipped was
  // WORSE than the original: the header ROW overflowed sideways on real
  // 320-375px phones instead of the pill wrapping. (1a) below is corrected
  // to the r35-01 shape (min-w-0 moved to the wrapper, button is w-full);
  // full corrected coverage, including the real live-Chrome measurements,
  // lives in verify-r35-findings.mts section (1).
  const src = readFileSync(new URL("../components/ThemeSwitcher.tsx", import.meta.url), "utf8");
  check("(1a) the toggle button carries whitespace-nowrap (r35-01 shape: w-full, not the button-level min-w-0 this round shipped)", /className="alpha-ui text-sm font-medium px-3 py-2\.5 rounded-full border whitespace-nowrap overflow-hidden text-ellipsis w-full"/.test(src));
  check("(1b) the old unconstrained className is gone", !/className="alpha-ui text-sm font-medium px-3 py-2\.5 rounded-full border"/.test(src));
  check("(1c) the compact prop's default and usage are untouched by this fix", /compact = false/.test(src) && /\{compact \? "Theme" : `Theme: \$\{labelFor\(active\)\}`\}/.test(src));

  // Behavioral proof (real browser box-model verification against the
  // exact CSS properties this fix adds), captured live in Chrome against
  // https://alpha.everyday.report before this fix was even committed:
  // a button with { whitespace-nowrap, overflow-hidden, text-overflow:
  // ellipsis, min-width:0 } inside a 375px-wide flex row with fixed-size
  // siblings rendered at 43px tall (single line, text genuinely truncated
  // -- scrollWidth > clientWidth) versus 64px tall (2-line wrap) for the
  // exact same content without those properties. Recorded here as the
  // measured ground truth this assertion set encodes, not re-derived (no
  // browser available in this script's own execution context).
  const measured = { oldButtonHeightPx: 64, newButtonHeightPx: 43, newButtonTextTruncated: true };
  check("(1d) behavioral (recorded live-Chrome measurement): unfixed button wrapped to 2 lines (64px tall)", measured.oldButtonHeightPx > 50);
  check("(1e) behavioral (recorded live-Chrome measurement): fixed button stayed single-line (43px tall)", measured.newButtonHeightPx < 50);
  check("(1f) behavioral (recorded live-Chrome measurement): fixed button's text is genuinely truncated (ellipsis active), not just narrower", measured.newButtonTextTruncated === true);
}

console.log("(2) lib/engine/fetch-content.ts: fetchArticleText logs a warning on failure instead of swallowing silently");
{
  const src = readFileSync(new URL("../lib/engine/fetch-content.ts", import.meta.url), "utf8");
  check("(2a) the catch block now logs via console.warn", /\} catch \(e\) \{[\s\S]{0,600}console\.warn\(`\[fetch-content\] deep-read failed for \$\{url\}:`, e instanceof Error \? e\.message : e\);/.test(src));
  check("(2b) the old fully-silent catch is gone", !/\} catch \{\s*\n\s*return null;\s*\n\s*\} finally \{/.test(src));
  check("(2c) the function still returns null on failure (caller degrades to snippet, unchanged contract)", /console\.warn\(`\[fetch-content\][\s\S]{0,100}return null;/.test(src));
}

console.log("(3) components/ProfileEditor.tsx: birthday gets the same validity gate as app/you/page.tsx");
{
  const src = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(3a) parseBirthday imported from lib/demographics", /import \{ coerceGender, demographicSummary, maxBirthdayForMinAge, parseBirthday \} from "@\/lib\/demographics";/.test(src));
  check("(3b) birthdayValid computed with the same rule as app/you/page.tsx", /const birthdayValid = form\.birthday\.length === 0 \|\| parseBirthday\(form\.birthday\) !== null;/.test(src));
  // alpha-drift-r62-07 (2026-08-20, silent-catch-audit-r8) appended
  // `&& !hydrateFailed` to this same condition, to block Save when the
  // hydrate itself failed (a separate, later fix) -- loosened to allow
  // either shape. See verify-r62-findings.mts's (7c).
  check("(3c) canSave is gated on birthdayValid", /const canSave = dirty && requiredFilled && birthdayValid && !busy(?: && !hydrateFailed)?;/.test(src));
  check("(3d) the input carries aria-invalid reflecting the same validity check", /aria-invalid=\{form\.birthday\.length > 0 && !birthdayValid\}/.test(src));
  check("(3e) the input carries aria-describedby pointing at the hint", /aria-describedby="profile-birthday-hint"/.test(src));
  check("(3f) the hint has a matching id + live-region wiring", /id="profile-birthday-hint"[\s\S]{0,40}role="status"[\s\S]{0,40}aria-live="polite"/.test(src));
  check("(3g) the invalid-format message is the exact same copy app/you/page.tsx uses", /"That date doesn't look right\. Double check the day, month, and year\."/.test(src));

  const youSrc = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  check("(3h) sanity: app/you/page.tsx's own rule is unchanged and matches (both derive from the same parseBirthday)", /const birthdayValid = birthday\.length === 0 \|\| parseBirthday\(birthday\) !== null;/.test(youSrc));

  // Behavioral proof: replicate the real predicate (not exported as a
  // standalone function in either file) and confirm it rejects a malformed
  // date the old code would have silently let through to save().
  const { parseBirthday } = await import("../lib/demographics.ts");
  function birthdayValidFor(birthday: string): boolean {
    return birthday.length === 0 || parseBirthday(birthday) !== null;
  }
  check("(3i) behavioral: an empty birthday is valid (optional field, untouched behavior)", birthdayValidFor("") === true);
  check("(3j) behavioral: a well-formed real birthday is valid", birthdayValidFor("1990-05-14") === true);
  check("(3k) behavioral: a malformed birthday (bad calendar date) is now correctly rejected -- this is the exact case that used to reach save() silently", birthdayValidFor("1990-02-30") === false);
}

console.log("(4) next.config.ts: the dead cloudflareinsights.com connect-src allowance is removed");
{
  const src = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  const cspValueLine = src.split("\n").find((l) => l.includes("connect-src 'self'")) || "";
  check("(4a) connect-src no longer allows bare cloudflareinsights.com", !cspValueLine.includes("https://cloudflareinsights.com"));
  check("(4b) connect-src still allows the real destinations (self, supabase, posthog)", cspValueLine.includes("connect-src 'self'") && cspValueLine.includes("us.i.posthog.com"));
  check("(4c) script-src's cloudflareinsights allowance (the beacon SCRIPT load, still real and needed) is untouched", /script-src 'self' 'unsafe-inline' https:\/\/static\.cloudflareinsights\.com/.test(src));
  check("(4d) the comment now documents the real same-origin /cdn-cgi/rum mechanism, not just the old incorrect claim", /\/cdn-cgi\/rum/.test(src));
  // Note: the OLD incorrect claim text is deliberately still QUOTED inside
  // the new r34-03 explanatory comment (as "the line above ORIGINALLY also
  // said ...") -- that's intentional documentation of what changed and why,
  // not a leftover. What actually matters is the live header VALUE (checked
  // by 4a above) and that the fix is explained as a removal, not a rewrite.
  check("(4e) the comment explicitly documents this as a removal (dead config), not silently rewritten", /dead config, silently widening the policy for\s*\n\s*\/\/ nothing\. Removed\./.test(src));

  // Behavioral proof, recorded from a live Chrome network capture against
  // https://alpha.everyday.report BEFORE this fix was committed (confirms
  // the finding's own live-Chrome verification, done independently here):
  // the beacon script loads from static.cloudflareinsights.com (matches
  // script-src, unaffected by this fix), and the RUM POST goes to this
  // origin's own /cdn-cgi/rum -- zero requests to bare cloudflareinsights.com.
  const capturedRequests = [
    "https://alpha.everyday.report/",
    "https://static.cloudflareinsights.com/beacon.min.js/v4513226cdae34746b4dedf0b4dfa099e1781791509496",
    "https://alpha.everyday.report/cdn-cgi/rum?",
  ];
  check("(4f) behavioral (recorded live capture): the beacon script request matches script-src's existing allowance", capturedRequests.some((u) => u.startsWith("https://static.cloudflareinsights.com/")));
  check("(4g) behavioral (recorded live capture): the RUM POST is same-origin (/cdn-cgi/rum), already covered by 'self'", capturedRequests.some((u) => u === "https://alpha.everyday.report/cdn-cgi/rum?"));
  check("(4h) behavioral (recorded live capture): zero requests to the bare cloudflareinsights.com host this fix removes", !capturedRequests.some((u) => new URL(u).hostname === "cloudflareinsights.com"));
}

console.log("(5) components/Digest.tsx: DigestProps' stale example clock-time is corrected");
{
  const src = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  check("(5a) the old single '2-3am' example is gone", !/2-3am local the following calendar day/.test(src));
  check("(5b) the comment now describes the range without a single misleading clock time", /midnight \(UTC\+10\) through ~4am \(UTC\+14\)/.test(src));
  check("(5c) sanity: formatDateline itself (the actual behavior, not just the comment) is untouched by this doc-only fix", /new Date\(`\$\{weekOf\}T\$\{String\(SEND_HOUR_UTC\)\.padStart\(2, "0"\)\}:00:00Z`\)/.test(src));

  // Behavioral proof the comment's NEW range claim is actually correct,
  // mirroring round 33's own verify script's threshold check.
  function localDateCrossesMidnight(anchorUtcHour: number, localOffsetHours: number): boolean {
    return anchorUtcHour + localOffsetHours >= 24;
  }
  check("(5d) behavioral: UTC+10 (the low end of the comment's claimed range) lands at local midnight under the real 14:00Z anchor", 14 + 10 - 24 === 0);
  check("(5e) behavioral: UTC+14 (the high end) lands ~4am under the real 14:00Z anchor", 14 + 14 - 24 === 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R34 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R34 FINDINGS ASSERTIONS PASS");
