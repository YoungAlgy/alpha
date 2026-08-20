// Verify round 54 findings: 5 confirmed, 5 refuted (out of 10 raw findings
// across 5 dimensions -- 0 UNVERIFIED). keyboard-interactive-semantics-audit
// found nothing on its first outing (a fully dry debut).
// - app/api/cron/weekly-send/route.ts: round 53's own 402-widening fix
//   (lib/engine/openai-compat.ts's throwCompatError) made
//   deepseekRateLimitedCount() a real signal for a genuine balance-exhausted
//   outage -- but this ops-alert line, the one consumer outside topic-
//   blurb.ts, still hardcoded "returned 429" unconditionally. A sibling
//   Groq-side finding of the identical shape was raised the same round and
//   REFUTED 2/3 (lower severity -- Groq's documented free-tier limits are
//   genuinely rate-limit-shaped in practice) -- left unchanged, do not
//   re-flag without new evidence.
// - app/topics/page.tsx + app/theme/page.tsx: two real HIGH-severity races,
//   the round's headline findings. Both pages' signed-in hydrate effects did
//   an unconditional setPicked()/setTarget() the moment their own network
//   round trip resolved, with no check for whether the user had already
//   changed the pick locally since mount -- silently discarding a live tap/
//   toggle and replacing it with the OLD saved value, with zero indication
//   anything happened. Fixed with a ref latch (userEditedRef / userPickedRef)
//   set the first time the user makes a live edit; the hydrate effect skips
//   its own write once that ref is set, so a live edit always wins over a
//   same-mount hydrate response that merely started before it.
// - app/api/account/profile/route.ts: a comment grouped city with the three
//   optional/clearable blurbs, but the code (cleanRequired, same as
//   first_name) has always treated it as load-bearing -- matching
//   components/ProfileEditor.tsx's own independent requiredFilled check.
// - app/checkout/page.tsx: the theme-preview card, topics-chip row, and
//   City/Email summary lines all read useOnboarding()'s state directly with
//   no `loaded` gate, so a returning visitor with real saved data briefly
//   saw the wrong default theme, an empty topics row, and missing city/
//   email lines before snapping to their real choices -- the identical bug
//   class settings/page.tsx's quotaLoaded gate (rounds 19/44) already
//   closed elsewhere, now closed on the checkout page too.
// 5 refuted, all genuinely adjudicated: the Groq-side ops-alert wording
// (above), a checkout Subscribe-failure focus-restoration gap, QuestionStep's
// Skip button re-entrancy, settings/page.tsx's "Manage subscription" busy
// guard (portal.route.ts is a documented pre-existing dead 500 today,
// pending a one-time Stripe Dashboard config), and generate/route.ts's
// ProfileSchema.email validation-parity gap.
// alpha-drift-r54-01 through r54-05, all 2026-08-20.
// Run: npx tsx scripts/verify-r54-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/api/cron/weekly-send/route.ts: DeepSeek's ops-alert now covers 429 AND 402, Groq's is deliberately unchanged");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(1a) DeepSeek's alert no longer says 'returned 429' unconditionally", !/DeepSeek \(the uncapped backstop tier\) returned 429/.test(src));
  check("(1b) it now says 'hit a quota\\/balance wall ... (429 or 402)'", /DeepSeek \(the uncapped backstop tier\) hit a quota\/balance wall on \$\{deepseekRateLimited\} calls this run \(429 or 402\)/.test(src));
  check("(1c) Groq's alert is deliberately unchanged (refuted 2\\/3)", /Groq \(2nd content-generation tier\) returned 429 on \$\{groqRateLimited\} calls this run/.test(src));
}

console.log("(2) app/topics/page.tsx: a live user edit now always wins over a same-mount hydrate response");
{
  const src = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
  check("(2a) userEditedRef is declared", /const userEditedRef = useRef\(false\);/.test(src));
  // alpha-drift-r55-02 (2026-08-20, self-audit-r54) split this gate:
  // setTarget was found to be wrongly bundled under the same latch as
  // setPicked (target/quota is never user-edited state on this page) and
  // now runs unconditionally -- only setPicked(row.topics) is still gated.
  // See scripts/verify-r55-findings.mts's own (2b)/(2c) for the current shape.
  check("(2b) the hydrate effect's setPicked is gated behind it (setTarget no longer is, see r55-02)", /if \(!userEditedRef\.current\) \{\s*\n(?:[^\n]*\n){0,4}?\s*setPicked\(row\.topics as TopicId\[\]\);/.test(src));
  check("(2c) toggle() sets the ref", /function toggle\(id: TopicId\) \{\s*\n\s*userEditedRef\.current = true;/.test(src));
  // alpha-drift-r55-01 (2026-08-20, self-audit-r54) moved addCustom()'s ref
  // assignment past its own validation returns, so a no-op Add attempt
  // doesn't spuriously arm the latch -- see verify-r55-findings.mts's (3).
  check("(2d) addCustom() sets the ref immediately before its real setPicked call (moved past validation, see r55-01)", /userEditedRef\.current = true;\s*\n\s*tap\(\);\s*\n\s*setPicked\(\(prev\) => \[\.\.\.prev, id\]\);/.test(src));
  check("(2e) removeAt() sets the ref", /function removeAt\(id: TopicId\) \{\s*\n\s*userEditedRef\.current = true;/.test(src));
  check("(2f) move() sets the ref", /if \(to < 0 \|\| to >= picked\.length\) return;\s*\n\s*userEditedRef\.current = true;/.test(src));
}

console.log("(3) app/theme/page.tsx: a live tap now always wins over a same-mount hydrate response");
{
  const src = readFileSync(new URL("../app/theme/page.tsx", import.meta.url), "utf8");
  check("(3a) userPickedRef is declared", /const userPickedRef = useRef\(false\);/.test(src));
  check("(3b) the hydrate effect's setPicked is gated behind it", /if \(dbTheme && dbTheme in SWATCHES && !userPickedRef\.current\) setPicked\(dbTheme\);/.test(src));
  check("(3c) pickTheme() sets the ref", /function pickTheme\(id: ThemeId\) \{\s*\n\s*userPickedRef\.current = true;/.test(src));
}

console.log("(4) app/api/account/profile/route.ts: the comment now correctly says city is required, not clearable");
{
  const src = readFileSync(new URL("../app/api/account/profile/route.ts", import.meta.url), "utf8");
  check("(4a) no longer groups city with the clearable blurbs", !/city \+ the three blurbs are personalization: editable and clearable\./.test(src));
  check("(4b) now says first_name AND city are the two load-bearing fields", /first_name AND city are the two load-bearing fields/.test(src));
}

console.log("(5) app/checkout/page.tsx: the theme\\/topics\\/city\\/email summary is now gated on loaded");
{
  const src = readFileSync(new URL("../app/checkout/page.tsx", import.meta.url), "utf8");
  check("(5a) the grid block is now conditional on loaded", /\{loaded && <div className="grid md:grid-cols-\[160px_1fr\] gap-5 items-stretch">/.test(src));
  check("(5b) the conditional is properly closed", /\{state\.email && <MiniRow label="Email" value=\{state\.email\} \/>\}\s*\n\s*<\/div>\s*\n\s*<\/div>\}/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R54 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R54 FINDINGS ASSERTIONS PASS");
