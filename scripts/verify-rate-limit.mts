// Verify lib/rate-limit.ts's core logic — pure, no network (short real sleeps
// for the window-reset case since rateLimit() uses wall-clock Date.now()
// directly, no injectable clock). Gates every admin action (30/hr), the
// update-quantity billing change (10/hr), account/topics edits (30/hr), and
// account/email/reconcile (30/hr), but had zero dedicated coverage (found in
// review 2026-08-06 — grep across scripts/*.mts for "lib/rate-limit" or
// "rateLimit(" returned zero matches). Two things make this a real gap, not
// theoretical: (1) clientKeyFromRequest's header-precedence comment
// documents an ACTUAL historical vulnerability -- reading x-forwarded-for
// before cf-connecting-ip let any caller defeat every rate limit in the app
// by sending a fresh random IP header per request, the week alpha moved to
// Cloudflare Workers; (2) this is exactly the kind of logic that "compiles
// clean and passes lint" if silently reordered or off-by-one'd in a future
// refactor, with nothing to catch it.
// Run: npx tsx scripts/verify-rate-limit.mts
const { rateLimit, isDuplicateSubmission, clientKeyFromRequest, _debugMapSizes } = await import("../lib/rate-limit.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- rateLimit(): core window/count math ------------------------------------
console.log("(1) rateLimit — under the limit allows, counts down remaining");
const k1 = `test-key-${Date.now()}-a`;
const r1a = rateLimit(k1, { limit: 3, windowMs: 60_000 });
check("(1) first call: ok=true", r1a.ok === true);
check("(1) first call: remaining = limit - 1 = 2", r1a.remaining === 2);
const r1b = rateLimit(k1, { limit: 3, windowMs: 60_000 });
check("(1) second call: ok=true, remaining=1", r1b.ok === true && r1b.remaining === 1);
const r1c = rateLimit(k1, { limit: 3, windowMs: 60_000 });
check("(1) third call: ok=true, remaining=0 (exactly AT the limit)", r1c.ok === true && r1c.remaining === 0);

console.log("(2) rateLimit — the call that EXCEEDS the limit blocks");
const r2 = rateLimit(k1, { limit: 3, windowMs: 60_000 });
check("(2) fourth call (over limit): ok=false", r2.ok === false);
check("(2) fourth call: remaining=0", r2.remaining === 0);
check("(2) fourth call: retryAfterSec > 0 (a real countdown, not 0)", r2.retryAfterSec > 0);
const r2b = rateLimit(k1, { limit: 3, windowMs: 60_000 });
check("(2) still blocked on a 5th call, same window", r2b.ok === false);

console.log("(3) rateLimit — limit <= 0 always blocks, never divides by zero or similar");
const k3 = `test-key-${Date.now()}-c`;
const r3a = rateLimit(k3, { limit: 0, windowMs: 60_000 });
check("(3) limit=0 blocks immediately", r3a.ok === false);
const r3b = rateLimit(k3, { limit: -5, windowMs: 60_000 });
check("(3) negative limit blocks immediately", r3b.ok === false);

console.log("(4) rateLimit — window reset allows again after resetAt (short real window)");
const k4 = `test-key-${Date.now()}-d`;
rateLimit(k4, { limit: 1, windowMs: 100 });
const r4blocked = rateLimit(k4, { limit: 1, windowMs: 100 });
check("(4) blocked while still inside the window", r4blocked.ok === false);
await sleep(150);
const r4reset = rateLimit(k4, { limit: 1, windowMs: 100 });
check("(4) allowed again once the window has genuinely elapsed", r4reset.ok === true);

console.log("(5) rateLimit — different keys never share a bucket");
const kA = `test-key-${Date.now()}-e1`;
const kB = `test-key-${Date.now()}-e2`;
rateLimit(kA, { limit: 1, windowMs: 60_000 });
const rB = rateLimit(kB, { limit: 1, windowMs: 60_000 });
check("(5) a fresh key is NOT affected by a different key's exhausted bucket", rB.ok === true);

// --- isDuplicateSubmission(): identity, not volume --------------------------
console.log("(6) isDuplicateSubmission — same key within the window is a duplicate");
const dk1 = `dup-key-${Date.now()}-a`;
check("(6) first call: not a duplicate", isDuplicateSubmission(dk1, 60_000) === false);
check("(6) immediate second call, same key: IS a duplicate", isDuplicateSubmission(dk1, 60_000) === true);
check("(6) third call, same key, still within window: still a duplicate", isDuplicateSubmission(dk1, 60_000) === true);

console.log("(7) isDuplicateSubmission — a different key is never a duplicate of another");
const dk2a = `dup-key-${Date.now()}-b1`;
const dk2b = `dup-key-${Date.now()}-b2`;
isDuplicateSubmission(dk2a, 60_000);
check("(7) a different key is NOT a duplicate", isDuplicateSubmission(dk2b, 60_000) === false);

console.log("(8) isDuplicateSubmission — expires after its own short window");
const dk3 = `dup-key-${Date.now()}-c`;
isDuplicateSubmission(dk3, 100);
await sleep(150);
check("(8) same key allowed again once ITS window elapsed", isDuplicateSubmission(dk3, 100) === false);

// --- clientKeyFromRequest(): the documented Cloudflare-migration regression guard ---
console.log("(9) clientKeyFromRequest — cf-connecting-ip preferred over x-forwarded-for");
const reqBoth = new Request("https://alpha.everyday.report/api/support", {
  headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 8.8.8.8" },
});
check(
  "(9) cf-connecting-ip wins even when x-forwarded-for is ALSO present -- the actual regression this guards",
  clientKeyFromRequest(reqBoth) === "1.2.3.4"
);

console.log("(10) clientKeyFromRequest — x-forwarded-for fallback uses the FIRST (leftmost) entry, not the whole chain");
const reqFwdOnly = new Request("https://alpha.everyday.report/api/support", {
  headers: { "x-forwarded-for": "5.5.5.5, 6.6.6.6, 7.7.7.7" },
});
check(
  "(10) leftmost entry of the chain used when cf-connecting-ip is absent",
  clientKeyFromRequest(reqFwdOnly) === "5.5.5.5"
);

console.log("(11) clientKeyFromRequest — x-real-ip fallback, then 'unknown'");
const reqRealIp = new Request("https://alpha.everyday.report/api/support", { headers: { "x-real-ip": "3.3.3.3" } });
check("(11) x-real-ip used when neither cf-connecting-ip nor x-forwarded-for present", clientKeyFromRequest(reqRealIp) === "3.3.3.3");
const reqNone = new Request("https://alpha.everyday.report/api/support");
check("(11) 'unknown' when no IP-bearing header is present at all", clientKeyFromRequest(reqNone) === "unknown");

// --- alpha-drift-r18-01 (found+fixed 2026-08-07): neither Map evicted an
// expired entry, growing unbounded for the life of a warm isolate. Eviction
// is deliberately behavior-neutral (an expired-but-present entry already
// behaves identically to a missing one from the public API's point of
// view -- see rateLimit's own `!b || b.resetAt < now` check), so the only
// way to actually prove memory gets freed, not just that behavior stays
// correct, is via _debugMapSizes(), exported for exactly this. ------------
console.log("(12) rateLimit — sweep actually shrinks the buckets Map once past the threshold, not just tolerates it");
{
  const before = _debugMapSizes().buckets;
  // 1005 distinct, already-expired-by-the-time-we-check keys -- pushes the
  // Map past BUCKET_SWEEP_THRESHOLD (1000) entirely with garbage this test
  // owns, so the assertion below can't be satisfied by coincidental cleanup
  // of some OTHER test's keys above.
  for (let i = 0; i < 1005; i++) {
    rateLimit(`sweep-test-bucket-${Date.now()}-${i}`, { limit: 1, windowMs: 10 });
  }
  await sleep(50); // let every one of them genuinely expire
  const grown = _debugMapSizes().buckets;
  check("(12) Map genuinely grew past the sweep threshold", grown - before >= 1000);
  // One more call is what triggers sweepBuckets (checked at the TOP of
  // rateLimit, before this call's own key is added) -- so this call's own
  // fresh key can't itself be swept, but every expired one from the loop
  // above should be gone by the time it returns.
  rateLimit(`sweep-test-trigger-${Date.now()}`, { limit: 1, windowMs: 60_000 });
  const after = _debugMapSizes().buckets;
  check(
    `(12) sweep evicted the expired entries -- size dropped from ${grown} to ${after}, not left to grow forever`,
    after < grown - 900
  );
}

console.log("(13) isDuplicateSubmission — crossing the sweep threshold doesn't break correctness (can't observe the 1hr eviction ceiling itself in a fast test -- no injectable clock, and unlike rateLimit's caller-provided windowMs, SUBMISSION_MAX_AGE_MS is an internal constant chosen to safely outlive every real windowMs this file is called with, not something a test should shrink just to make it fast)");
{
  for (let i = 0; i < 1005; i++) {
    isDuplicateSubmission(`sweep-test-submission-${Date.now()}-${i}`, 60_000);
  }
  const freshKey = `sweep-test-submission-fresh-${Date.now()}`;
  check("(13) a fresh key past the threshold still correctly reports 'not a duplicate' first", isDuplicateSubmission(freshKey, 60_000) === false);
  check("(13) the SAME key immediately after still correctly reports 'IS a duplicate'", isDuplicateSubmission(freshKey, 60_000) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RATE-LIMIT VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RATE-LIMIT ASSERTIONS PASS");
