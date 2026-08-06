// Verifies retryResendCall() (lib/email.ts), added 2026-08-05 (resilience
// audit finding): a single transient Resend error used to propagate straight
// to the cron's caller, throwing away up to 45 seconds of work and
// escalating to the full three-layer backup chain (real AI-provider spend)
// for what might have been one rate-limited request that would have
// succeeded a moment later.
//
// Tests the real function against an injected fake sendFn (dependency
// injection, same shape as lib/letter-delivery.ts's deliverLetterOnce) --
// no real Resend calls, no real network, fully deterministic and free.
// Run: npx tsx scripts/verify-resend-retry.mts

const { retryResendCall } = await import("../lib/email.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function okResponse(id: string) {
  return { data: { id }, error: null } as const;
}
function errResponse(name: string, message = "boom") {
  return { data: null, error: { name, statusCode: 500, message } } as const;
}

// --- 1) Success on the first try -- no retry needed, no delay ---------------
console.log("(1) first attempt succeeds -- no retry");
{
  let calls = 0;
  const start = Date.now();
  const result = await retryResendCall(async () => {
    calls++;
    return okResponse("re_first_try");
  });
  const elapsed = Date.now() - start;
  check("(1) called exactly once", calls === 1);
  check("(1) returned the success response", result.data?.id === "re_first_try");
  check("(1) no backoff delay incurred (fast)", elapsed < 200);
}

// --- 2) Retryable error, then succeeds on attempt 2 --------------------------
console.log("(2) retryable error (rate_limit_exceeded) then succeeds");
{
  let calls = 0;
  const result = await retryResendCall(async () => {
    calls++;
    if (calls === 1) return errResponse("rate_limit_exceeded");
    return okResponse("re_second_try");
  });
  check("(2) called exactly twice", calls === 2);
  check("(2) eventually returned the success response", result.data?.id === "re_second_try");
}

// --- 3) Retryable error every time -- exhausts all 3 attempts, returns the
//        last (still-erroring) response rather than throwing ---------------
console.log("(3) retryable error on every attempt -- exhausts retries, returns last error");
{
  let calls = 0;
  const result = await retryResendCall(async () => {
    calls++;
    return errResponse("internal_server_error", `attempt ${calls}`);
  });
  check("(3) called exactly 3 times (2 retries + original)", calls === 3);
  check("(3) returns an error response, does not throw", result.error !== null);
  check("(3) the error is from the LAST attempt", result.error?.message === "attempt 3");
}

// --- 4) Non-retryable error -- must NOT retry, fails fast --------------------
console.log("(4) non-retryable error (invalid_api_key) -- fails immediately, no retry");
{
  let calls = 0;
  const start = Date.now();
  const result = await retryResendCall(async () => {
    calls++;
    return errResponse("invalid_api_key");
  });
  const elapsed = Date.now() - start;
  check("(4) called exactly once (no retry attempted)", calls === 1);
  check("(4) returns the error response", result.error?.name === "invalid_api_key");
  check("(4) no backoff delay incurred (failed fast)", elapsed < 200);
}

// --- 5) Same for another non-retryable class: quota exceeded ----------------
console.log("(5) non-retryable error (monthly_quota_exceeded) -- fails immediately");
{
  let calls = 0;
  const result = await retryResendCall(async () => {
    calls++;
    return errResponse("monthly_quota_exceeded");
  });
  check("(5) called exactly once", calls === 1);
  check("(5) returns the error response", result.error?.name === "monthly_quota_exceeded");
}

// --- 6) A THROW (network failure, not a Resend error response) is also
//        retried, same as an error response --------------------------------
console.log("(6) network-level throw, then succeeds -- also retried");
{
  let calls = 0;
  const result = await retryResendCall(async () => {
    calls++;
    if (calls === 1) throw new Error("fetch failed: ECONNRESET");
    return okResponse("re_after_network_blip");
  });
  check("(6) called exactly twice", calls === 2);
  check("(6) eventually succeeded", result.data?.id === "re_after_network_blip");
}

// --- 7) A throw on every attempt -- exhausts retries, THEN throws (unlike
//        an error response, which returns rather than throws) --------------
console.log("(7) throw on every attempt -- exhausts retries, then throws");
{
  let calls = 0;
  let threw = false;
  try {
    await retryResendCall(async () => {
      calls++;
      throw new Error(`network blip ${calls}`);
    });
  } catch (e) {
    threw = true;
    check("(7) the thrown error is from the LAST attempt", e instanceof Error && e.message === "network blip 3");
  }
  check("(7) called exactly 3 times", calls === 3);
  check("(7) ultimately threw (matches the original no-retry throw behavior callers expect)", threw);
}

// --- 8) Backoff actually delays between attempts (not a busy-retry) --------
console.log("(8) backoff delay is real (not instant retries)");
{
  let calls = 0;
  const start = Date.now();
  await retryResendCall(async () => {
    calls++;
    if (calls < 3) return errResponse("rate_limit_exceeded");
    return okResponse("re_third_try");
  });
  const elapsed = Date.now() - start;
  // Two backoff waits (500ms + 1500ms nominal, plus jitter) must have
  // actually elapsed -- loose lower bound well under the nominal 2000ms to
  // avoid flaking on CI timer coarseness, but high enough to catch a
  // regression that removed the delay entirely.
  check(`(8) at least ~1.8s elapsed across two backoff waits (was ${elapsed}ms)`, elapsed >= 1800);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RESEND RETRY VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RESEND RETRY ASSERTIONS PASS");
