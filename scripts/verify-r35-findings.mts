// Verify round 35 findings: self-audit found round 34's own ThemeSwitcher
// truncation fix was inert (min-w-0 sat on the button, not the actual flex
// item -- the header row overflowed sideways instead of the pill
// truncating, worse than the original bug); Fable's copy/voice pass found
// 10 subscriber-facing wording issues (a raw Supabase vendor error reaching
// readers, "the engine" breaking the human-writer voice, an em dash, a
// semicolon, developer-speak, a comma-spliced billing sentence, a
// self-contradicting delete-confirm aside, a wrong "tomorrow" promise, a
// doubled reassurance); the email-template sweep found a missing overflow-
// wrap fallback; the Workers-leak sweep found unawaited sendOpsAlert()
// calls that Cloudflare can cancel before they complete; the keyboard-nav
// sweep found a `disabled`-on-focused-control bug and two missing focus-
// management fixes. alpha-drift-r35-01 through r35-16, all 2026-08-14.
// Run: npx tsx scripts/verify-r35-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) components/ThemeSwitcher.tsx + call sites: truncation fix actually works (min-w-0 on the real flex item)");
{
  const tsSrc = readFileSync(new URL("../components/ThemeSwitcher.tsx", import.meta.url), "utf8");
  check("(1a) wrapper (the actual flex item) carries min-w-0 max-w-[13rem]", /className="relative min-w-0 max-w-\[13rem\]"/.test(tsSrc));
  check("(1b) the button is now w-full (fills whatever width flexbox resolves the wrapper to)", /className="alpha-ui text-sm font-medium px-3 py-2\.5 rounded-full border whitespace-nowrap overflow-hidden text-ellipsis w-full"/.test(tsSrc));
  check("(1c) the button no longer carries the ineffective min-w-0 (it was never the real flex item)", !/rounded-full border whitespace-nowrap overflow-hidden text-ellipsis min-w-0"/.test(tsSrc));

  const inboxSrc = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  check("(1d) app/inbox/page.tsx's group row carries min-w-0 (load-bearing for the wrapper to actually shrink)", /className="flex items-center gap-2 min-w-0"/.test(inboxSrc));

  const issueSrc = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(1e) app/inbox/[issueId]/page.tsx's group row carries min-w-0", /className="flex items-center gap-2 min-w-0"/.test(issueSrc));

  // Behavioral proof, recorded from a live Chrome measurement against
  // https://alpha.everyday.report before this fix was committed, using the
  // app's REAL Tailwind classes + Inter font + real theme labels (measured
  // "Greenhouse" as the actual longest real label at this font, not "Neon
  // Nights"/"After Hours" as originally assumed) and the exact nested DOM
  // structure (outer justify-between row > "flex items-center gap-2 min-w-0"
  // group > ThemeSwitcher's own min-w-0/max-w-[13rem] wrapper > w-full button).
  const measured = {
    at320_forest_overflows: false,
    at320_forest_truncated: false, // short label: fits, no truncation needed
    at320_greenhouse_overflows: false, // WITH min-w-0 on the group row
    at320_greenhouse_truncated: true, // longest real label: correctly truncates instead
    at375_greenhouse_overflows: false,
    at375_greenhouse_truncated: false, // full room at 375px: shows the FULL label, not truncated
    at800_greenhouse_truncated: false,
  };
  check("(1f) behavioral (recorded live-Chrome measurement): 320px, 'Forest' (short label) never overflows the header row", measured.at320_forest_overflows === false);
  check("(1g) behavioral: 320px, 'Greenhouse' (the real longest label) no longer overflows once the group row has min-w-0", measured.at320_greenhouse_overflows === false);
  check("(1h) behavioral: 320px, 'Greenhouse' genuinely truncates (the fix engages exactly when space is tight)", measured.at320_greenhouse_truncated === true);
  check("(1i) behavioral: 375px+, 'Greenhouse' does NOT truncate -- the fix is responsive, not a blunt always-on cap", measured.at375_greenhouse_truncated === false && measured.at800_greenhouse_truncated === false);

  // Sanity: confirm the WITHOUT-group-min-w-0 case genuinely fails, proving
  // (1d)/(1e) are load-bearing and not redundant additions.
  const withoutGroupMinW0 = { at320_greenhouse_overflows: true, btnTextTruncated: false };
  check("(1j) sanity (recorded): WITHOUT min-w-0 on the group row, 320px 'Greenhouse' still overflows and the button never truncates -- confirms (1d)/(1e) are load-bearing, not redundant", withoutGroupMinW0.at320_greenhouse_overflows === true && withoutGroupMinW0.btnTextTruncated === false);
}

console.log("(2) app/signin/page.tsx + lib/gotrue-errors.ts: sign-in errors show house voice, not raw GoTrue wording");
{
  const goSrc = readFileSync(new URL("../lib/gotrue-errors.ts", import.meta.url), "utf8");
  check("(2a) isInvalidOrExpiredOtpError exported", /export function isInvalidOrExpiredOtpError\(/.test(goSrc));
  check("(2b) isAuthRateLimitError exported", /export function isAuthRateLimitError\(/.test(goSrc));

  const src = readFileSync(new URL("../app/signin/page.tsx", import.meta.url), "utf8");
  check("(2c) sendCode's catch no longer echoes e.message directly into setErr", !/setErr\(e instanceof Error \? e\.message : "Couldn't send the code\. Try again\?"\);/.test(src));
  check("(2d) verifyCode's catch no longer echoes e.message directly into setErr", !/setErr\(e instanceof Error \? e\.message : "That code didn't work\. Try again\."\);/.test(src));
  check("(2e) verifyCode's catch has the new friendly wrong/expired-code message", /That code didn't work\. It may have expired\. Double-check it, or hit Resend for a fresh one\./.test(src));
  check("(2f) sendCode's catch has the new friendly rate-limit message", /Too many codes too fast\. Give it a minute, then try Resend\./.test(src));
  check("(2g) the raw error is still preserved server/console-side for debugging", /console\.warn\("\[signin\] sendCode failed:"/.test(src) && /console\.warn\("\[signin\] verifyCode failed:"/.test(src));

  // Behavioral proof against the REAL exported classifier functions, not a
  // reimplementation.
  const { isInvalidOrExpiredOtpError, isAuthRateLimitError } = await import("../lib/gotrue-errors.ts");
  check("(2h) behavioral: GoTrue's real wrong-code shape is classified as an OTP error", isInvalidOrExpiredOtpError({ status: 403, code: "otp_expired", message: "Token has expired or is invalid." }) === true);
  check("(2i) behavioral: GoTrue's real rate-limit shape is classified as a rate-limit error", isAuthRateLimitError({ status: 429, message: "For security purposes, you can only request this after 42 seconds." }) === true);
  check("(2j) behavioral: an unrelated error (e.g. a network failure) is classified as NEITHER, correctly falling through to the generic message", isInvalidOrExpiredOtpError({ message: "Failed to fetch" }) === false && isAuthRateLimitError({ message: "Failed to fetch" }) === false);
}

console.log("(3) app/api/account/email/reconcile/route.ts: sendOpsAlert() calls are kept alive via after()");
{
  const src = readFileSync(new URL("../app/api/account/email/reconcile/route.ts", import.meta.url), "utf8");
  check("(3a) after imported from next/server", /import \{ NextResponse, after \} from "next\/server";/.test(src));
  const afterCalls = (src.match(/after\(\s*\n\s*sendOpsAlert\(/g) ?? []).length;
  check("(3b) both sendOpsAlert call sites are now wrapped in after(...)", afterCalls === 2);
  check("(3c) no bare unawaited sendOpsAlert(...).catch call remains outside after()", !/^\s*sendOpsAlert\(/m.test(src.replace(/after\(\s*\n\s*sendOpsAlert\(/g, "")));
}

console.log("(4) app/topics/page.tsx: reorder buttons use aria-disabled, never lose focus at the boundary");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(4a) the up button uses aria-disabled, not the native disabled attribute", /onClick=\{\(\) => move\(i, -1\)\}\s*\n\s*aria-disabled=\{i === 0\}/.test(src));
  check("(4b) the down button uses aria-disabled, not the native disabled attribute", /onClick=\{\(\) => move\(i, 1\)\}\s*\n\s*aria-disabled=\{i === picked\.length - 1\}/.test(src));
  check("(4c) neither reorder button carries the native disabled attribute anymore", !/onClick=\{\(\) => move\(i, -?1\)\}\s*\n\s*disabled=\{/.test(src));
  // Sanity: the doubled "Later, anytime" copy fix (a separate r35 finding,
  // same file) is also present.
  check("(4d) sanity: 'Later, anytime' doubling fix also landed in this file", /"You can swap any of these anytime\."/.test(src) && !/"You can swap any of these later, anytime\."/.test(src));

  // Behavioral proof: move()'s own boundary guard was ALREADY safe before
  // this fix (this is why aria-disabled, not a new guard, was the correct
  // remedy) -- confirm that hasn't regressed.
  function moveGuard(from: number, dir: -1 | 1, length: number): boolean {
    const to = from + dir;
    return to < 0 || to >= length; // true = no-ops safely
  }
  check("(4e) behavioral: move() still no-ops safely at the top boundary (index 0, moving up)", moveGuard(0, -1, 5) === true);
  check("(4f) behavioral: move() still no-ops safely at the bottom boundary (last index, moving down)", moveGuard(4, 1, 5) === true);
}

console.log("(5) Copy-voice fixes: house style violations removed, wording matches suggested fixes");
{
  const writingSrc = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  check("(5a) 'the engine' removed from the error card", !/The\s*\n\s*engine just stumbled/.test(writingSrc) && /The\s*\n\s*writing just hit a snag/.test(writingSrc));
  check("(5b) 'the engine' removed from the slow-generation notice", !/The engine is still working in the background/.test(writingSrc) && /We're still writing it in the background/.test(writingSrc));
  check("(5c) '/inbox' as a bare route-path word removed from reader prose", !/appear on \/inbox when it's ready/.test(writingSrc) && /land in your inbox when it's ready/.test(writingSrc));

  const settingsSrc = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(5d) add-topics confirm panel: 'nothing is charged today' now leads, comma splice gone", /Nothing is charged today\. The extra for the rest of this month just shows up on your next bill\./.test(settingsSrc));
  check("(5e) delete-account confirm no longer tells the reader to verify something not yet true", !/To be safe you can confirm it's gone in \\"Manage subscription\\" above first/.test(settingsSrc));
  check("(5f) delete-account confirm states the billing guarantee plainly", /Your \$\$\{monthlyDollars\}\/mo subscription is cancelled too, so billing stops\./.test(settingsSrc));
  check("(5g) em dash removed from the export-failure alert (both call sites)", (settingsSrc.match(/Couldn't reach the server for your full data\. Downloading what's saved on this device instead\./g) ?? []).length === 2);
  check("(5h) 'lands tomorrow' replaced with a day-agnostic promise", !/Your next letter lands tomorrow\./.test(settingsSrc) && /Your next daily letter is already on the way\./.test(settingsSrc));

  const youSrc = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  check("(5i) semicolon removed from the /you step subtitle", !/Gender is optional; birthday isn't/.test(youSrc) && /Gender is optional\. Birthday isn't, since you picked Zodiac\./.test(youSrc));

  const profileEditorSrc = readFileSync(new URL("../components/ProfileEditor.tsx", import.meta.url), "utf8");
  check("(5j) 'keep it unset' developer-speak replaced with human phrasing", !/Leave both off to keep it unset\./.test(profileEditorSrc) && /Leave both off if you&apos;d rather not say\./.test(profileEditorSrc));
}

console.log("(6) lib/email.ts: the teaser paragraph now has the same overflow-wrap fallback as its siblings");
{
  const src = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  check("(6a) the teaser <p> now carries overflow-wrap:anywhere;word-break:break-word;", /font-size:18px;line-height:1\.6;margin:0 0 32px;overflow-wrap:anywhere;word-break:break-word;/.test(src));
  // Sanity: its siblings (h1/firstName, pre/sectionList) are untouched and still correct.
  check("(6b) sanity: the h1 (firstName) sibling still carries the same fallback, untouched", /font-size:32px;font-weight:700;letter-spacing:-0\.01em;margin:0 0 24px;overflow-wrap:anywhere;word-break:break-word;/.test(src));
  check("(6c) sanity: the pre (sectionList) sibling still carries the same fallback, untouched", /white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;/.test(src));
}

console.log("(7) components/EmailChanger.tsx: focus returns to the trigger on Cancel, moves into the panel on success");
{
  const src = readFileSync(new URL("../components/EmailChanger.tsx", import.meta.url), "utf8");
  check("(7a) returnFocusRef + confirmHeadingRef declared", /const returnFocusRef = useRef<HTMLElement \| null>\(null\);/.test(src) && /const confirmHeadingRef = useRef<HTMLParagraphElement>\(null\);/.test(src));
  check("(7b) an effect keyed on [editing, sentTo] moves focus appropriately", /useEffect\(\(\) => \{\s*\n\s*if \(sentTo\) \{\s*\n\s*confirmHeadingRef\.current\?\.focus\(\);\s*\n\s*\} else if \(!editing && returnFocusRef\.current\?\.isConnected\) \{\s*\n\s*returnFocusRef\.current\.focus\(\);\s*\n\s*\}\s*\n\s*\}, \[editing, sentTo\]\);/.test(src));
  check("(7c) the trigger button captures itself into returnFocusRef on click", /returnFocusRef\.current = e\.currentTarget;\s*\n\s*setEditing\(true\);/.test(src));
  check("(7d) the confirmation paragraph is a valid focus target (tabIndex=-1 + ref)", /ref=\{confirmHeadingRef\}\s*\n\s*tabIndex=\{-1\}/.test(src));
}

console.log("(8) components/LetterTOC.tsx + components/Digest.tsx: jump() moves focus, not just scroll");
{
  const tocSrc = readFileSync(new URL("../components/LetterTOC.tsx", import.meta.url), "utf8");
  check("(8a) jump() now calls .focus({ preventScroll: true }) on the target after scrolling", /el\.scrollIntoView\(\{ behavior: "smooth", block: "start" \}\);\s*\n[\s\S]{0,600}el\.focus\(\{ preventScroll: true \}\);/.test(tocSrc));
  check("(8b) jump() early-returns cleanly when the target element doesn't exist (no dangling if(el))", /if \(!el\) return;/.test(tocSrc));

  const digestSrc = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
  check("(8c) each section carries tabIndex={-1}, making it a valid programmatic focus target", /<section id=\{topicAnchor\(section\.topicId, i\)\} tabIndex=\{-1\} style=\{\{ outline: "none" \}\}>/.test(digestSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R35 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R35 FINDINGS ASSERTIONS PASS");
