// Verify the letter-view token + email CTA wiring — pure, no live sends.
// Covers v2 issue-scoped tokens AND legacy v1 (user-only) compatibility: v1
// tokens are baked into already-sent emails with a 90-day TTL, so they must
// keep verifying (they resolve weekOf=null → the page shows latest).
// Run: npx tsx scripts/verify-letter-token.mts
process.env.UNSUBSCRIBE_SECRET = "test-secret-for-harness-only";
import crypto from "node:crypto";

const { makeLetterToken, verifyLetterToken, letterUrl } = await import("../lib/letter-token.ts");
const { makeUnsubscribeToken } = await import("../lib/unsubscribe.ts");
const { renderHTML, subjectLine } = await import("../lib/email.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const uid = "11111111-2222-3333-4444-555555555555";
const week = "2026-07-02";

// (1) v2 round trip — token pins the ISSUE, not just the reader. (The v1
// user-only token made every email link open the same latest letter.)
const tok = makeLetterToken(uid, week);
const payload = verifyLetterToken(tok);
check("mint → verify round-trips userId", payload?.userId === uid);
check("mint → verify round-trips weekOf (issue-scoped)", payload?.weekOf === week);
check(
  "two issues mint DIFFERENT tokens for the same reader",
  makeLetterToken(uid, "2026-06-30") !== makeLetterToken(uid, "2026-07-02")
);

// (2) Tampering
const [u, w, e, s] = tok.split(".");
check("tampered userId rejected", verifyLetterToken(`99999999-2222-3333-4444-555555555555.${w}.${e}.${s}`) === null);
check("tampered weekOf rejected (can't point a link at another issue)", verifyLetterToken(`${u}.2026-01-01.${e}.${s}`) === null);
check("tampered expiry rejected", verifyLetterToken(`${u}.${w}.${Number(e) + 9999}.${s}`) === null);
check("tampered sig rejected", verifyLetterToken(`${u}.${w}.${e}.AAAAAAAAAAAAAAAA`) === null);
check("garbage rejected", verifyLetterToken("not-a-token") === null);
check("empty rejected", verifyLetterToken("") === null);
check("overlong rejected", verifyLetterToken("x".repeat(300)) === null);
check("malformed weekOf rejected", verifyLetterToken(`${u}.not-a-date.${e}.${s}`) === null);

// (3) Expiry honored
const expired = makeLetterToken(uid, week, -1); // TTL -1 day → already expired
check("expired v2 token rejected", verifyLetterToken(expired) === null);

// (4) LEGACY v1 tokens (in already-sent emails) still verify, weekOf=null.
// Mint one exactly the way v1 makeLetterToken did.
function mintV1(userId: string, ttlDays: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const sig = crypto
    .createHmac("sha256", "test-secret-for-harness-only")
    .update(`letter:${userId}.${exp}`)
    .digest("base64url")
    .slice(0, 16);
  return `${userId}.${exp}.${sig}`;
}
const v1 = mintV1(uid, 90);
const v1Payload = verifyLetterToken(v1);
check("legacy v1 token still verifies (old emails keep working)", v1Payload?.userId === uid);
check("legacy v1 token resolves weekOf=null (page shows latest)", v1Payload !== null && v1Payload.weekOf === null);
check("expired legacy v1 token rejected", verifyLetterToken(mintV1(uid, -1)) === null);
// A v1 signature must not verify as part of a v2-shaped token.
const [v1u, v1e, v1s] = v1.split(".");
check("v1 sig can't be replayed into a v2 token", verifyLetterToken(`${v1u}.${week}.${v1e}.${v1s}`) === null);

// (5) Domain separation: an unsubscribe token must NOT verify as a letter
// token (same secret, different HMAC input).
const unsub = makeUnsubscribeToken(uid);
check("unsubscribe token shape rejected outright", verifyLetterToken(unsub) === null);
const [uu, us] = [unsub.slice(0, unsub.lastIndexOf(".")), unsub.slice(unsub.lastIndexOf(".") + 1)];
check(
  "unsubscribe sig can't be replayed into a letter token",
  verifyLetterToken(`${uu}.${Math.floor(Date.now() / 1000) + 1000}.${us}`) === null
);

// (6) letterUrl shape
const url = letterUrl(uid, "https://alpha.everyday.report/", week);
check("letterUrl targets /letter?t=", url.startsWith("https://alpha.everyday.report/letter?t="));
check("letterUrl token carries the issue", verifyLetterToken(decodeURIComponent(url.split("?t=")[1]))?.weekOf === week);

// (7) Email CTA prefers the letter URL; signin small-print intact
const html = renderHTML({
  firstName: "Sam",
  teaser: "teaser",
  sectionList: "• A\n• B",
  inboxUrl: "https://alpha.everyday.report/inbox",
  letterUrl: url,
  weekOf: "2026-06-07",
  unsubscribeUrl: null,
});
check("CTA href is the tokenized letter URL", html.includes(`href="${url.replace(/&/g, "&amp;")}"`) || html.includes(`href="${url}"`));
check("CTA is NOT the bare inbox link anymore", !html.includes('href="https://alpha.everyday.report/inbox"'));
check("sign-in small print kept", html.includes("/signin"));

// (8) Legacy fallback: no letterUrl → CTA falls back to inbox
const legacy = renderHTML({
  firstName: "Sam",
  teaser: "t",
  sectionList: "• A",
  inboxUrl: "https://alpha.everyday.report/inbox",
  letterUrl: null,
  weekOf: "2026-06-07",
  unsubscribeUrl: null,
});
check("no token → CTA falls back to /inbox", legacy.includes('href="https://alpha.everyday.report/inbox"'));

// (9) Subject reads like a recognizable newsletter (Ally's feedback)
check("subject is personal + says newsletter + issue number", subjectLine("Ally", 1) === "Ally's newsletter · Issue 1");
check("subject pluralizes issue number", subjectLine("Sam", 7) === "Sam's newsletter · Issue 7");
check("no name → 'Your newsletter'", subjectLine("", 3) === "Your newsletter · Issue 3");
check("no issue number → falls back to the date", subjectLine("Ally", undefined, "2026-06-07") === "Ally's newsletter · June 7");
check("subject never leads with a raw news headline", !subjectLine("Ally", 1).includes("Healthcare"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("LETTER TOKEN VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL LETTER-TOKEN ASSERTIONS PASS");
