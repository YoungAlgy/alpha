// Verify lib/account-topics-guards.ts — pure, no network. Exercises the
// whole validateTopicsSubmission chain (shape, empty-pool floor, per-user
// cap, dup check, isValidTopicId scan). This is the only write path into
// public.users.topics with an empty-pool floor -- see the guard file's own
// comment for why the DB's CHECK constraint doesn't catch it. Had zero
// dedicated coverage until this script (found in review 2026-08-06).
//
// alpha-drift-r14-02: also covers the two-phase split (validateTopicsShape
// then validateTopicsAgainstCap) the route now calls separately around its
// DB read -- an earlier single-function version of this file accidentally
// let a malformed body reach the DB before being rejected, turning a 400
// into a 500 during a transient DB read failure. Section (8) locks in that
// the shape phase alone needs no cap and catches every shape defect on its
// own, matching what the route now runs before ever touching Supabase.
// Run: npx tsx scripts/verify-account-topics-guards.mts
import { TOPICS } from "../lib/topics.ts";

const { validateTopicsSubmission, validateTopicsShape, validateTopicsAgainstCap } = await import(
  "../lib/account-topics-guards.ts"
);

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const realTopics = TOPICS.slice(0, 3).map((t) => t.id);
if (realTopics.length < 3) {
  console.log("SKIP: fewer than 3 real catalog topics found -- can't build a meaningful test set.");
  process.exit(0);
}

console.log("(1) shape checks — not an array, or an absurdly oversized array");
check("(1) non-array rejected", validateTopicsSubmission("not-an-array", 25).ok === false);
check("(1) null rejected", validateTopicsSubmission(null, 25).ok === false);
check(
  "(1) an array over the 100-item absolute ceiling is rejected even with a huge cap",
  validateTopicsSubmission(Array(101).fill(realTopics[0]), 1000).ok === false
);
check(
  "(1) exactly 100 items is NOT rejected by the absolute-ceiling check alone (cap check catches it separately below)",
  (() => {
    const r = validateTopicsSubmission(Array(100).fill(realTopics[0]), 1000);
    // 100 real-looking but duplicate entries -- shape check passes, dup check
    // further down correctly rejects it. Confirms the ceiling itself is >=100.
    return r.ok === false && r.error.toLowerCase().includes("duplicate");
  })()
);

console.log("(2) empty-pool floor — the actual gap this route existed to close");
const emptyResult = validateTopicsSubmission([], 25);
check("(2) an empty array is rejected", emptyResult.ok === false);
check(
  "(2) rejected with the right user-facing message, not a generic shape error",
  !emptyResult.ok && emptyResult.error === "Pick at least one topic."
);

console.log("(3) type scan — every entry must be a string");
check("(3) an array containing a non-string is rejected", validateTopicsSubmission([realTopics[0], 42], 25).ok === false);
check("(3) an array of objects is rejected", validateTopicsSubmission([{ id: realTopics[0] }], 25).ok === false);

console.log("(4) per-user cap — the caller's actual poolCap, not a flat constant");
const capResult = validateTopicsSubmission(realTopics, 2);
check("(4) exceeding the caller's real cap (3 topics, cap=2) is rejected", capResult.ok === false);
check(
  "(4) rejected with the cap NUMBER embedded in the message (so the UI can show it)",
  !capResult.ok && capResult.error.includes("2")
);
check("(4) exactly at the cap is accepted", validateTopicsSubmission(realTopics, 3).ok === true);
check("(4) under the cap is accepted", validateTopicsSubmission(realTopics.slice(0, 2), 5).ok === true);

console.log("(5) duplicate check");
const dupResult = validateTopicsSubmission([realTopics[0], realTopics[0]], 25);
check("(5) a duplicate topic in the list is rejected", dupResult.ok === false);
check("(5) rejected with the duplicate-specific message", !dupResult.ok && dupResult.error.includes("duplicate"));

console.log("(6) isValidTopicId scan — an unrecognized topic must be rejected");
const badIdResult = validateTopicsSubmission([...realTopics, "not-a-real-topic-id"], 25);
check("(6) an unrecognized topic id is rejected", badIdResult.ok === false);
check(
  "(6) rejected with the unrecognized-topic message, not silently dropped or truncated",
  !badIdResult.ok && badIdResult.error.includes("recognized")
);

console.log("(7) the happy path — real, unique, in-cap topics are accepted verbatim");
const goodResult = validateTopicsSubmission(realTopics, 25);
check("(7) ok: true", goodResult.ok === true);
check(
  "(7) the returned topics array matches the input exactly, same order, no mutation",
  goodResult.ok && JSON.stringify(goodResult.topics) === JSON.stringify(realTopics)
);

console.log("(8) two-phase split — shape alone needs no cap, and rejects a malformed body before any cap is known");
check("(8) non-array rejected by shape phase alone (no cap argument at all)", validateTopicsShape("not-an-array").ok === false);
check("(8) empty array rejected by shape phase alone", validateTopicsShape([]).ok === false);
check("(8) non-string entry rejected by shape phase alone", validateTopicsShape([42]).ok === false);
const shapeOk = validateTopicsShape(realTopics);
check("(8) a valid shape passes phase 1", shapeOk.ok === true);
check(
  "(8) phase 2 (cap check) on an already-shaped list behaves identically to the combined function",
  shapeOk.ok && JSON.stringify(validateTopicsAgainstCap(shapeOk.topics, 2)) === JSON.stringify(validateTopicsSubmission(realTopics, 2))
);
check(
  "(8) composed validateTopicsSubmission is exactly shape-then-cap, not a separate third implementation",
  JSON.stringify(validateTopicsSubmission(realTopics, 25)) ===
    JSON.stringify(validateTopicsShape(realTopics).ok ? validateTopicsAgainstCap((validateTopicsShape(realTopics) as { ok: true; topics: string[] }).topics, 25) : null)
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ACCOUNT-TOPICS GUARDS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCOUNT-TOPICS GUARDS ASSERTIONS PASS");
