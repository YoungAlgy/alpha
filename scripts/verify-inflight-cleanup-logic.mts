// Proves the inFlight cleanup logic in assemble.ts's genLive (2026-07-29,
// round 2 review) is correct for all three settlement outcomes:
//   1. Resolves to a REAL value -> stays cached (a later caller reuses it,
//      no re-invocation).
//   2. Resolves to null AND is genuinely dry (dryCache has the key) -> stays
//      cached (harmless — dryCache's own check fires first for any future
//      caller anyway).
//   3. Resolves to null but is NOT genuinely dry (the guard-dropped-to-zero-
//      items case) -> EVICTED, so a later caller gets a fresh, independent
//      invocation instead of inheriting one bad draw for the rest of the run.
//   4. REJECTS -> EVICTED, same reasoning as (3).
//
// This is a LOGIC-LEVEL proof, not a live-API test: forcing scenario (3)
// through the real generateTopicBlurb pipeline isn't practical to do
// deterministically — enforceSignalUrls (lib/engine/url-guard.ts) only nulls
// a bad ref, it never drops a whole item, so "every item empty" can only
// happen via the meta-leak guard dropping every item, which depends on
// non-deterministic model output we can't force on demand. The mechanism
// itself (a Map + a raw promise + a .then(onFulfilled, onRejected) cleanup)
// is plain, controllable JS, so this test recreates that EXACT pattern from
// assemble.ts (genLive, ~lines 157-227) verbatim, with a fake underlying
// function standing in for resolveTopicSignal+generateTopicBlurb, and proves
// each of the four outcomes behaves as designed by checking whether the fake
// function got invoked once (cached, reused) or twice (evicted, fresh retry).
// Run: npx tsx scripts/verify-inflight-cleanup-logic.mts

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// Recreates genLive's exact inFlight interaction shape (assemble.ts).
function makeGenLive(dryCache: Set<string>, inFlight: Map<string, Promise<string | null>>) {
  return async function genLive(dryKey: string, underlying: () => Promise<string | null>): Promise<string | null> {
    let raw = inFlight.get(dryKey);
    if (!raw) {
      raw = underlying();
      raw.then(
        (result) => {
          if (result === null && !dryCache.has(dryKey) && inFlight.get(dryKey) === raw) {
            inFlight.delete(dryKey);
          }
        },
        () => {
          if (inFlight.get(dryKey) === raw) inFlight.delete(dryKey);
        }
      );
      inFlight.set(dryKey, raw);
    }
    return raw;
  };
}

// --- 1) A real value stays cached — a later caller reuses it -----------
console.log("(1) resolved-to-real-value: stays cached, later caller reuses it");
{
  const dryCache = new Set<string>();
  const inFlight = new Map<string, Promise<string | null>>();
  const genLive = makeGenLive(dryCache, inFlight);
  let calls = 0;
  const underlying = async () => {
    calls++;
    return "a real blurb";
  };
  const first = await genLive("k1", underlying);
  const second = await genLive("k1", underlying);
  check("(1) both calls return the same real value", first === "a real blurb" && second === "a real blurb");
  check("(1) underlying only invoked ONCE (reused, not re-run)", calls === 1);
  check("(1) entry still present in inFlight afterward", inFlight.has("k1"));
}

// --- 2) A genuinely dry null (dryCache has it) stays cached -------------
console.log("(2) resolved-to-null, genuinely dry: stays cached, later caller reuses it");
{
  const dryCache = new Set<string>();
  const inFlight = new Map<string, Promise<string | null>>();
  const genLive = makeGenLive(dryCache, inFlight);
  let calls = 0;
  const underlying = async () => {
    calls++;
    dryCache.add("k2"); // mirrors the real "!signal" branch adding to dryCache BEFORE returning null
    return null;
  };
  const first = await genLive("k2", underlying);
  const second = await genLive("k2", underlying);
  check("(2) both calls return null", first === null && second === null);
  check("(2) underlying only invoked ONCE (reused, not re-run)", calls === 1);
}

// --- 3) A resolved null that is NOT genuinely dry gets evicted ----------
// (the exact gap round 2 found: a guard-dropped-to-zero-items result)
console.log("(3) resolved-to-null, NOT dry (guard-dropped): evicted, later caller gets a fresh attempt");
{
  const dryCache = new Set<string>();
  const inFlight = new Map<string, Promise<string | null>>();
  const genLive = makeGenLive(dryCache, inFlight);
  let calls = 0;
  const underlying = async () => {
    calls++;
    // Deliberately does NOT touch dryCache — mirrors the real
    // blurb.items.length===0 branch, which resolves null without marking dry.
    return calls === 1 ? null : "succeeded on the independent retry";
  };
  const first = await genLive("k3", underlying);
  // Give the .then() microtask a turn to run its cleanup before checking.
  await Promise.resolve();
  check("(3) first call resolves null (the guard-dropped outcome)", first === null);
  check("(3) entry was evicted from inFlight after settling", !inFlight.has("k3"));
  const second = await genLive("k3", underlying);
  check("(3) a later caller for the SAME key gets a genuinely fresh, independent attempt", second === "succeeded on the independent retry");
  check("(3) underlying was invoked TWICE (fresh retry actually happened, not reused)", calls === 2);
}

// --- 4) A rejection gets evicted ----------------------------------------
console.log("(4) rejected: evicted, later caller gets a fresh attempt");
{
  const dryCache = new Set<string>();
  const inFlight = new Map<string, Promise<string | null>>();
  const genLive = makeGenLive(dryCache, inFlight);
  let calls = 0;
  const underlying = async () => {
    calls++;
    if (calls === 1) throw new Error("simulated transient failure (e.g. a 429)");
    return "succeeded on the independent retry";
  };
  let firstErr: unknown;
  try {
    await genLive("k4", underlying);
  } catch (e) {
    firstErr = e;
  }
  await Promise.resolve();
  check("(4) first call rejected as expected", firstErr instanceof Error);
  check("(4) entry was evicted from inFlight after rejecting", !inFlight.has("k4"));
  const second = await genLive("k4", underlying);
  check("(4) a later caller for the SAME key gets a genuinely fresh, independent attempt", second === "succeeded on the independent retry");
  check("(4) underlying was invoked TWICE (fresh retry actually happened, not reused)", calls === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("INFLIGHT-CLEANUP-LOGIC VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL INFLIGHT-CLEANUP-LOGIC ASSERTIONS PASS");
