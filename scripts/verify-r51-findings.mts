// Verify round 51 findings: 3 confirmed, 3 refuted (out of 6 raw findings
// across 5 dimensions -- 0 UNVERIFIED, quietest round yet).
// - lib/analytics.ts: a stray backtick/quote typo in round 50's own new
//   comment text (self-audit-r50 catching a cosmetic mistake, not a
//   substantive one this time).
// - app/api/cron/weekly-send/route.ts: the CRON header comment (and a
//   sibling "the offset retry trigger" reference further down) still only
//   named 2 of daily-send.yml's actual 3 scheduled windows -- README.md
//   already had the correct count; this route.ts comment, which lives in
//   the actual code the cron calls, never absorbed the second (18:00 UTC)
//   retry added a day after the first.
// - app/api/resume/route.ts: a comment falsely claimed public.users has no
//   self-UPDATE RLS policy -- the "users self update" policy exists and is
//   actively relied on daily by lib/theme.ts/lib/user-sync.ts. The real
//   reason this route needs the service role is the SEPARATE
//   protect_user_privileged_columns BEFORE UPDATE trigger, which pins
//   unsubscribed_at back to its old value for any non-service_role caller.
//   Flagged as a landmine: this repo has a proven track record of dropping
//   an RLS policy a comment claimed was unused (and once had to ship a
//   same-day hotfix after doing so), so a false "no policy exists" claim
//   sitting right next to a real, load-bearing policy is a real risk.
// Round 80 superseded one prior adjudication: delayed, out-of-order checkout
// delivery is now treated as an integrity boundary. The mutation helper
// rejects any non-live subscription before its INSERT branch. Also refuted
// in the original round: a citation-accuracy
// follow-on on lib/analytics.ts's own round-50 fix (claims docs/SECRETS.md
// and scripts/verify-build-env.mjs document NEXT_PUBLIC_POSTHOG_KEY when
// neither actually does -- judged a defensible "see X for the general
// approach" reading, not a hard factual claim), and a proposal to add a
// smoke-test regression check for round 50's Referrer-Policy fix (judged
// nice-to-have test-coverage depth, not a defect in the shipped fix itself).
// alpha-drift-r51-01 and r51-02, plus one untagged typo fix, all 2026-08-20.
// Run: npx tsx scripts/verify-r51-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) lib/analytics.ts: the stray backtick/quote mismatch in round 50's own new comment is fixed");
{
  const src = readFileSync(new URL("../lib/analytics.ts", import.meta.url), "utf8");
  check("(1a) the malformed `next build\") is gone", !/`next build"\)/.test(src));
  check("(1b) the backtick pair is now properly closed", /`npm run cf:deploy` runs `next build`\)\./.test(src));
}

console.log("(2) app/api/cron/weekly-send/route.ts: the CRON comment now names all 3 daily-send schedule windows");
{
  const src = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(2a) the header comment names all current off-peak slots", /"17 14 \* \* \*" \(14:17 UTC primary\),\s*\n\s*\/\/ "37 15 \* \* \*" \(15:37 UTC first retry\), and "47 18 \* \* \*" \(18:47 UTC/.test(src));
  check("(2b) the sibling 'offset retry trigger' reference is now pluralized", /offset retry triggers\)/.test(src));
}

console.log("(3) app/api/resume/route.ts: the false 'no self-UPDATE RLS policy' claim is corrected");
{
  const src = readFileSync(new URL("../app/api/resume/route.ts", import.meta.url), "utf8");
  check("(3a) the false claim is no longer asserted as live fact (only quoted historically, prefixed with 'used to say')", !/goes through the service role \(public\.users has no self-UPDATE RLS policy/.test(src) && /this used to\s*\n\/\/ say "public\.users has no self-UPDATE RLS policy" -- wrong\./.test(src));
  check("(3b) it now correctly attributes the service-role need to the column-lock trigger", /separate protect_user_privileged_columns BEFORE UPDATE trigger/.test(src));
  check("(3c) it names the real live callers of the self-update policy", /lib\/theme\.ts's setTheme\(\),\s*\n\/\/ lib\/user-sync\.ts's syncUserProfile\(\)/.test(src));
}

console.log("(4) round-80 supersession: non-live checkout cannot reach the active INSERT branch");
{
  const src = readFileSync(new URL("../lib/webhook-user-mutation.ts", import.meta.url), "utf8");
  const guardIdx = src.indexOf('if (!id.subscriptionLive)');
  const insertIdx = src.indexOf('kind: "insert"', guardIdx);
  check("(4a) subscriptionLive is checked before any INSERT can be returned", guardIdx > -1 && insertIdx > guardIdx);
  check("(4b) the non-live branch returns an explicit skip result", /return \{ kind: "skip", reason: "subscription-not-live" \};/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R51 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R51 FINDINGS ASSERTIONS PASS");
