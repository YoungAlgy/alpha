// Verify round 26 findings: #184 (admin/users' 4 maybeSingle() reads discarded
// error, masking real DB failures as "not found" or silently skipping Stripe
// cleanup during delete), #185 (previewFromIssue's email preheader truncation
// wasn't UTF-16 safe), #186 (clearAndGo('/welcome') hit the same multi-tab
// signOut race the code exempted /signin from), #187 (account/email/reconcile
// masked a DB read error as "no change needed"), #188 (daily-send.yml's
// coverage check used a capped array's .length instead of the *Total fields),
// #189 (weekOf validators accepted impossible calendar dates via JS Date
// rollover), #191 (stale CSRF endpoint count comment), #192 (admin `before`
// cursor unvalidated, `q` ILIKE-wildcard unescaped). #190 (migration misdate)
// is covered by its own file rename + content fix, checked here too.
// alpha-drift-r26-01 through r26-08, all 2026-08-14.
// Run: npx tsx scripts/verify-r26-findings.mts
import { readFileSync, existsSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function normalize(src: string): string {
  return src.replace(/\s+/g, " ");
}

console.log("(1) app/api/admin/users/route.ts: all 4 maybeSingle() reads now check error before checking !row/!existing");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  check("(1a) delete branch destructures error and bails before any destructive step", /const \{ data: targetUser, error: targetUserError \} = await sb[\s\S]{0,150}if \(targetUserError\)/.test(src));
  check("(1b) delete branch's ternary distinguishing missing-row from omitted-arg is unchanged (round 25's own fix)", /targetUser \? targetUser\.stripe_customer_id : null/.test(src));
  // grant_free/revoke_free interleave an existing round-17 comment between
  // the error check and the !existing/!row check, pushing them further
  // apart than a tight proximity window -- check each piece exists and
  // appears in the right RELATIVE order via indexOf, rather than bounding
  // the gap between them.
  const grantIdx = {
    destructure: src.indexOf('const { data: existing, error: existingError } = await sb'),
    errorCheck: src.indexOf("if (existingError) {"),
    notFoundCheck: src.indexOf("if (!existing) {"),
  };
  check("(1c) grant_free destructures error, checks it, THEN checks !existing (in that order)", grantIdx.destructure > -1 && grantIdx.destructure < grantIdx.errorCheck && grantIdx.errorCheck < grantIdx.notFoundCheck);

  const revokeIdx = {
    destructure: src.indexOf('const { data: row, error: rowError } = await sb\n      .from("users")\n      .select("stripe_customer_id")'),
    errorCheck: src.indexOf('console.error("[admin/users] revoke_free: pre-fetch failed:'),
  };
  check("(1d) revoke_free destructures error and logs on it (has its own dedicated error branch)", revokeIdx.destructure > -1 && revokeIdx.errorCheck > revokeIdx.destructure);

  check("(1e) clear_suppression destructures error and logs on it (has its own dedicated error branch)", src.includes('console.error("[admin/users] clear_suppression: pre-fetch failed:'));
  // Every error branch must actually log -- an error check that doesn't log
  // reintroduces exactly the "invisible in production" gap this fix closes.
  const errorLogCount = (src.match(/console\.error\("\[admin\/users\][^"]*pre-fetch failed:/g) || []).length;
  check("(1f) all 4 new error branches log via console.error (not silent)", errorLogCount === 4);
}

console.log("(2) lib/email.ts: previewFromIssue is UTF-16-safe AND preserves the original 90-vs-87 buffer");
{
  const src = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  const fnMatch = src.match(/function previewFromIssue\(issue: Issue\): string \{([\s\S]*?)\n\}/);
  check("(2a) previewFromIssue was found", !!fnMatch);
  const fn = fnMatch ? fnMatch[1] : "";
  // The new explanatory comment mentions the OLD "lead.slice(0, 87)" text
  // by name (describing what this used to be) -- checking for that bare
  // substring would false-positive on the comment itself. Check for the
  // exact ORIGINAL executable expression instead, which the comment
  // deliberately doesn't reproduce verbatim.
  check("(2b) no longer uses the original raw lead.slice(0, 87).trimEnd() expression as real code", !/lead\.slice\(0, 87\)\.trimEnd\(\)/.test(fn));
  // alpha-drift-r27-02 (2026-08-14, self-audit): round 26's fix
  // (codePointSafeTruncate(lead, 87)) was itself UTF-16-safe but silently
  // collapsed the ORIGINAL 90-vs-87 trigger/cut buffer into a single
  // threshold -- narrowing the preview text for any 88-90-code-point
  // headline that used to pass through untouched. Round 27 restored the
  // buffer via a direct code-point array, so this section now checks for
  // THAT shape instead of the round-26 codePointSafeTruncate call.
  check("(2c) computes code points via Array.from (not raw .slice/.length) for both the trigger check and the cut", /const leadCodePoints = Array\.from\(lead\);/.test(fn));
  check("(2d) trigger threshold is still >90 code points (the original buffer, not collapsed to 87)", /leadCodePoints\.length > 90/.test(fn));
  check("(2e) cut point is still 87 code points when triggered", /leadCodePoints\.slice\(0, 87\)\.join\(""\)\.trimEnd\(\) \+ "…"/.test(fn));

  // Behavioral proof: reimplement the exact expression and confirm the
  // 88-90 code-point range is genuinely left untouched (the bug round 27
  // found), while >90 still truncates and <=87 was never affected either way.
  const preview = (lead: string) => {
    const cp = Array.from(lead);
    return cp.length > 90 ? cp.slice(0, 87).join("").trimEnd() + "…" : lead;
  };
  const mk = (n: number) => "a".repeat(n);
  check("(2f) behavioral: an 89-code-point headline (round 27's regression range) passes through UNTRUNCATED", preview(mk(89)) === mk(89));
  check("(2g) behavioral: a 90-code-point headline (the exact old trigger boundary) still passes through untouched", preview(mk(90)) === mk(90));
  check("(2h) behavioral: a 91-code-point headline DOES truncate, to 87 + ellipsis", preview(mk(91)) === mk(87) + "…");
}

console.log("(3) app/inbox/page.tsx: clearAndGo takes an opts param, 'I'm new, start fresh' skips signOut, the 2 signed-in call sites don't");
{
  const src = normalize(readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8"));
  check("(3a) clearAndGo's signature accepts skipSignOut", /async function clearAndGo\(path: string, opts: \{ skipSignOut\?: boolean \} = \{\}\)/.test(src));
  check("(3b) the signOut call now also checks !opts.skipSignOut", /if \(path !== "\/signin" && !opts\.skipSignOut && supabaseConfigured\(\)\) await supabaseClient\(\)\.auth\.signOut\(\);/.test(src));
  check("(3c) \"I'm new, start fresh\" passes skipSignOut: true", /clearAndGo\("\/welcome", \{ skipSignOut: true \}\)/.test(src));
  // The other 2 /welcome call sites (accessEnded's "Start a new letter", the
  // signed-in "Sign out") must NOT have been given skipSignOut -- they fire
  // from a context where this tab's own signed-in state is real, and the
  // whole point of the fix is that only the signed-OUT call site is exempt.
  // Matched against onClick={() => ...} specifically (not the bare string
  // "clearAndGo(\"/welcome\")", which also appears once inside this fix's
  // own explanatory prose comment, not as a real invocation).
  const welcomeCalls = src.match(/onClick=\{\(\) => clearAndGo\("\/welcome"[^)]*\)[^}]*\}/g) || [];
  check("(3d) exactly 3 real /welcome call sites (onClick handlers) exist", welcomeCalls.length === 3);
  check("(3e) exactly 1 of them passes skipSignOut (not all 3 -- the other 2 must keep signing out)", welcomeCalls.filter((c) => c.includes("skipSignOut")).length === 1);
}

console.log("(4) app/api/account/email/reconcile/route.ts: the mirror read now checks error before treating a missing/synced row as 'nothing to do'");
{
  const src = normalize(readFileSync(new URL("../app/api/account/email/reconcile/route.ts", import.meta.url), "utf8"));
  check("(4a) destructures error from the row read", /const \{ data: row, error: rowError \} = await svc/.test(src));
  // alpha-drift-r46-supersedes-r26 (2026-08-19, found while running the full
  // regression suite during round 46 -- unrelated to round 46's own fixes):
  // round 35's alpha-drift-r35-03 wrapped the bare sendOpsAlert() call in
  // after(...) (for Workers isolate-teardown safety) and added an
  // explanatory comment in between, so sendOpsAlert( no longer sits
  // immediately after rowError.message); on the normalized single-line
  // string. Widened to allow anything in between, still anchored on the
  // same rowError-before-!row ordering this assertion exists to prove.
  check("(4b) checks rowError and returns 500 before the !row check", /if \(rowError\) \{ console\.error\("\[account\/email\/reconcile\] mirror read failed:", rowError\.message\);[\s\S]{0,500}?sendOpsAlert\(/.test(src));
  check("(4c) the original !row-or-synced 200 short-circuit is still intact for the real no-op case", /if \(!row \|\| \(row\.email \?\? ""\)\.toLowerCase\(\) === authEmail\) \{ return NextResponse\.json\(\{ ok: true, changed: false \}\); \}/.test(src));
}

console.log("(5) .github/workflows/daily-send.yml: coverage check reads *Total fields, falls back to .length");
{
  const src = readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
  check("(5a) blankCount prefers skippedBlankSubscribersTotal", /skippedBlankSubscribersTotal/.test(src));
  check("(5b) deferredCount prefers deferredTotal", /deferredTotal/.test(src));
  check("(5c) still falls back to .length when the *Total field is absent", /s\.skippedBlankSubscribers \? s\.skippedBlankSubscribers\.length : 0/.test(src) && /s\.deferred \? s\.deferred\.length : 0/.test(src));
}

console.log("(6) shared isValidCalendarDate helper exists and both weekOf validators use it");
{
  const demoSrc = readFileSync(new URL("../lib/demographics.ts", import.meta.url), "utf8");
  check("(6a) isValidCalendarDate exported", /export function isValidCalendarDate\(year: number, month: number, day: number\): boolean/.test(demoSrc));
  check("(6b) isValidCalendarDateString exported", /export function isValidCalendarDateString\(raw: string\): boolean/.test(demoSrc));
  check("(6c) parseBirthday itself now calls the shared helper, not its own inline round-trip", /if \(!isValidCalendarDate\(year, month, day\)\) return null;/.test(demoSrc));

  const genSrc = readFileSync(new URL("../app/api/generate/route.ts", import.meta.url), "utf8");
  check("(6d) generate route's weekOf refine calls isValidCalendarDateString before the date-math check", /if \(!isValidCalendarDateString\(s\)\) return false;/.test(genSrc));

  const cronSrc = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
  check("(6e) weekly-send's ?weekOf= override also calls isValidCalendarDateString", /weekOfOverride && \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(weekOfOverride\) && isValidCalendarDateString\(weekOfOverride\)/.test(cronSrc));

  // Behavioral proof, not just source presence: April 31 must actually be
  // rejected, and a real date must actually be accepted.
  const mod = await import("../lib/demographics.ts");
  check("(6f) behavioral: 2026-04-31 (JS Date rollover case) is rejected", mod.isValidCalendarDateString("2026-04-31") === false);
  check("(6g) behavioral: 2026-04-30 (the real last day of April) is accepted", mod.isValidCalendarDateString("2026-04-30") === true);
  check("(6h) behavioral: 2026-02-29 (2026 is not a leap year) is rejected", mod.isValidCalendarDateString("2026-02-29") === false);
  check("(6i) behavioral: 2024-02-29 (2024 IS a leap year) is accepted", mod.isValidCalendarDateString("2024-02-29") === true);
}

console.log("(7) round-25 migration's date stamp corrected (filename + comment) to the real 2026-08-14");
{
  const oldPath = new URL("../supabase/migrations/20260815000000_drop_useless_bounced_complained_indexes.sql", import.meta.url);
  const newPath = new URL("../supabase/migrations/20260814010000_drop_useless_bounced_complained_indexes.sql", import.meta.url);
  check("(7a) the old (wrongly-dated) filename no longer exists", !existsSync(oldPath));
  check("(7b) the renamed, correctly-dated filename exists", existsSync(newPath));
  if (existsSync(newPath)) {
    const src = readFileSync(newPath, "utf8");
    check("(7c) header comment now says (2026-08-14)", /round 25's fresh-angle audit \(2026-08-14\)/.test(src));
    check("(7d) the two DROP INDEX statements are still intact (a rename didn't lose the actual content)", /drop index if exists public\.users_bounced_at_idx;/.test(src) && /drop index if exists public\.users_complained_at_idx;/.test(src));
  }
}

console.log("(8) src/worker-entry.ts: CSRF endpoint count corrected to 9, matching CSRF_GUARDED_SUFFIXES");
{
  const src = readFileSync(new URL("../src/worker-entry.ts", import.meta.url), "utf8");
  check("(8a) no longer says \"8 state-changing endpoints\" anywhere", !/8 state-changing endpoints/.test(src));
  const nineCount = (src.match(/9 state-changing endpoints/g) || []).length;
  check("(8b) both occurrences now say \"9 state-changing endpoints\"", nineCount === 2);

  const guardSrc = readFileSync(new URL("../lib/csrf-guard.ts", import.meta.url), "utf8");
  const arrMatch = guardSrc.match(/export const CSRF_GUARDED_SUFFIXES = \[([\s\S]*?)\]/);
  const entryCount = arrMatch ? (arrMatch[1].match(/'\/api\//g) || []).length : 0;
  check("(8c) sanity: CSRF_GUARDED_SUFFIXES really does have 9 entries (the count this comment must match)", entryCount === 9);
}

console.log("(9) app/api/admin/users/route.ts: `before` cursor validated, `q` ILIKE wildcards escaped");
{
  const src = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
  // alpha-drift-r27-01 (2026-08-14): the original (9a) check only matched
  // the source text of the Number.isNaN guard -- round 27's self-audit
  // found that guard alone doesn't catch a JS-Date-rollover value like
  // "2026-04-31T...Z" (silently normalizes to a valid, non-NaN date), the
  // exact gap this round's own weekOf fix closed elsewhere. Updated to
  // check for the added isValidCalendarDate cross-check AND to actually
  // exercise both branches behaviorally, not just confirm the source text
  // is present -- the false-negative round 27 itself flagged in this exact
  // spot last round.
  check("(9a) before's NaN check is still present (catches shape-invalid input like \"not-a-date\")", /Number\.isNaN\(new Date\(before\)\.getTime\(\)\)/.test(src));
  check("(9a-2) before is ALSO cross-checked against isValidCalendarDate (catches shape-valid-but-impossible input like a rolled-over date)", /isValidCalendarDate\(\+beforeDateMatch\[1\], \+beforeDateMatch\[2\], \+beforeDateMatch\[3\]\)/.test(src));
  check("(9a-3) isValidCalendarDate is imported from lib/demographics", /import \{ isValidCalendarDate \} from "@\/lib\/demographics";/.test(src));

  // Behavioral proof: mirror the route's exact validation expression against
  // real inputs, not just confirm the source text exists.
  const { isValidCalendarDate } = await import("../lib/demographics.ts");
  const validateBefore = (before: string) => {
    const m = before.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const calendarValid = !m || isValidCalendarDate(+m[1], +m[2], +m[3]);
    return !(Number.isNaN(new Date(before).getTime()) || !calendarValid);
  };
  check("(9a-4) behavioral: a genuine created_at timestamp is accepted", validateBefore("2026-08-14T10:30:00.000Z") === true);
  check("(9a-5) behavioral: shape-invalid garbage is rejected", validateBefore("not-a-date") === false);
  check("(9a-6) behavioral: the JS-Date-rollover case (2026-04-31, silently becomes May 1) is now correctly rejected -- this is the exact input round 27's self-audit found slipping through the old NaN-only check", validateBefore("2026-04-31T00:00:00.000Z") === false);
  check("(9a-7) behavioral: another rollover case (2026-02-30, no such day) is rejected", validateBefore("2026-02-30T00:00:00.000Z") === false);

  check("(9b) escapedQ is derived from q with wildcard escaping", /const escapedQ = q\?\.replace\(\/\[\\\\%_\]\/g, "\\\\\$&"\);/.test(src));
  check("(9c) the ilike call now uses escapedQ, not the raw q", /usersQuery = usersQuery\.ilike\("email", `%\$\{escapedQ\}%`\);/.test(src));
  check("(9d) no remaining raw, unescaped `%${q}%` interpolation", !/ilike\("email", `%\$\{q\}%`\)/.test(src));

  // Behavioral proof of the escape regex itself.
  const escape = (s: string) => s.replace(/[\\%_]/g, "\\$&");
  check("(9e) behavioral: a literal % is escaped to \\%", escape("50%") === "50\\%");
  check("(9f) behavioral: a literal _ is escaped to \\_", escape("a_b") === "a\\_b");
  check("(9g) behavioral: an ordinary email-shaped query is untouched", escape("algy@example.com") === "algy@example.com");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R26 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R26 FINDINGS ASSERTIONS PASS");
