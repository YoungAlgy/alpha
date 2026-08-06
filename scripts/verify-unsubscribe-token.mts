// Verify makeUnsubscribeToken/verifyUnsubscribeToken (lib/unsubscribe.ts) —
// pure, no live sends, no Supabase. Authenticates every one-click unsubscribe
// link this paid product ever emails; had zero dedicated coverage until this
// script (found in review 2026-08-06 — verify-letter-token.mts imports
// makeUnsubscribeToken exactly once, only to prove an unsubscribe token can't
// be replayed as a LETTER token, and never calls verifyUnsubscribeToken
// itself). Mirrors verify-letter-token.mts's structure.
// Run: npx tsx scripts/verify-unsubscribe-token.mts
process.env.UNSUBSCRIBE_SECRET = "test-secret-for-harness-only";

const { makeUnsubscribeToken, verifyUnsubscribeToken } = await import("../lib/unsubscribe.ts");
const { makeLetterToken } = await import("../lib/letter-token.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const uid = "11111111-2222-3333-4444-555555555555";
const otherUid = "99999999-2222-3333-4444-555555555555";

// (1) Round trip
console.log("(1) round trip");
const tok = makeUnsubscribeToken(uid);
check("mint → verify round-trips the userId", verifyUnsubscribeToken(tok) === uid);
check("two different users mint DIFFERENT tokens", makeUnsubscribeToken(uid) !== makeUnsubscribeToken(otherUid));
check("minting the SAME user twice is deterministic (no random salt)", makeUnsubscribeToken(uid) === makeUnsubscribeToken(uid));

// (2) Tampering
console.log("(2) tampering rejected");
const lastDot = tok.lastIndexOf(".");
const sig = tok.slice(lastDot + 1);
check(
  "tampered userId rejected (can't forge a DIFFERENT reader's unsubscribe)",
  verifyUnsubscribeToken(`${otherUid}.${sig}`) === null
);
check("tampered signature rejected", verifyUnsubscribeToken(`${uid}.AAAAAAAAAAAAAAAA`) === null);
check(
  "signature truncated by one char rejected (length check before timingSafeEqual)",
  verifyUnsubscribeToken(`${uid}.${sig.slice(0, -1)}`) === null
);
check("signature with one extra char rejected", verifyUnsubscribeToken(`${uid}.${sig}A`) === null);

// (3) Malformed input
console.log("(3) malformed input rejected, not thrown");
check("empty string rejected", verifyUnsubscribeToken("") === null);
check("no dot at all rejected", verifyUnsubscribeToken("no-dot-here") === null);
// lastDot < 1 guard: a dot at position 0 (empty userId) must be rejected too,
// not just a fully-missing dot.
check("dot at position 0 (empty userId) rejected", verifyUnsubscribeToken(".signature") === null);
check("garbage rejected", verifyUnsubscribeToken("!!!not-a-real-token!!!") === null);
check("overlong input rejected, doesn't throw", verifyUnsubscribeToken(`${uid}.${"A".repeat(5000)}`) === null);
// @ts-expect-error -- deliberately testing non-string input the route's own
// JSON parsing could theoretically hand this function on a malformed request.
check("non-string input rejected, doesn't throw", verifyUnsubscribeToken(null) === null);

// (4) Missing UNSUBSCRIBE_SECRET fails CLOSED (returns null), not an uncaught throw
console.log("(4) missing secret fails closed, not an uncaught 500");
const realSecret = process.env.UNSUBSCRIBE_SECRET;
delete process.env.UNSUBSCRIBE_SECRET;
let threw = false;
let resultWithNoSecret: string | null = "not-null-sentinel" as string | null;
try {
  resultWithNoSecret = verifyUnsubscribeToken(tok);
} catch {
  threw = true;
}
check("verifyUnsubscribeToken does NOT throw when UNSUBSCRIBE_SECRET is unset", !threw);
check("verifyUnsubscribeToken returns null (not a stale-cached secret's answer)", resultWithNoSecret === null);
process.env.UNSUBSCRIBE_SECRET = realSecret;

// (5) Domain separation: a LETTER token must not verify as an unsubscribe
// token (the reverse of verify-letter-token.mts's own existing check, which
// only tests the other direction).
console.log("(5) a letter token can't be replayed as an unsubscribe token");
const letterTok = makeLetterToken(uid, "2026-07-02");
check("letter token shape rejected outright by verifyUnsubscribeToken", verifyUnsubscribeToken(letterTok) === null);
// A letter token is `${userId}.${weekOf}.${exp}.${sig}` -- collapse it to the
// unsubscribe shape (userId.sig-like-last-segment) and confirm that STILL
// doesn't verify, since the HMAC input differs (unsubscribe signs just the
// userId; letter tokens sign a different string entirely).
const letterParts = letterTok.split(".");
const collapsedAsUnsubShape = `${letterParts[0]}.${letterParts[letterParts.length - 1]}`;
check(
  "letter token's own signature can't be replayed into unsubscribe's shape",
  verifyUnsubscribeToken(collapsedAsUnsubShape) === null
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("UNSUBSCRIBE-TOKEN VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL UNSUBSCRIBE-TOKEN ASSERTIONS PASS");
