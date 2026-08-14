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

console.log("(2) lib/email.ts: previewFromIssue uses codePointSafeTruncate, not raw .slice()");
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
  check("(2c) uses codePointSafeTruncate(lead, 87)", /codePointSafeTruncate\(lead, 87\)/.test(fn));
  check("(2d) derives the ellipsis decision from the returned `truncated` flag, not a .length comparison (the same alpha-drift-r20-08 pattern the sibling call sites use)", /leadTruncated \? leadCut\.trimEnd\(\) \+ "…" : lead/.test(fn));
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
  check("(4b) checks rowError and returns 500 before the !row check", /if \(rowError\) \{ console\.error\("\[account\/email\/reconcile\] mirror read failed:", rowError\.message\); sendOpsAlert\(/.test(src));
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
  check("(9a) before is checked for a parseable date before use, with a clean 400 on failure", /if \(before && Number\.isNaN\(new Date\(before\)\.getTime\(\)\)\) \{\s*return NextResponse\.json\(\{ error: "Invalid 'before' cursor\." \}, \{ status: 400 \}\);/.test(src));
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
