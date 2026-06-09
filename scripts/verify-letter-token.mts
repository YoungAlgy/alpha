// Verify the letter-view token + email CTA wiring — pure, no live sends.
// Run: npx tsx scripts/verify-letter-token.mts
process.env.UNSUBSCRIBE_SECRET = "test-secret-for-harness-only";

const { makeLetterToken, verifyLetterToken, letterUrl } = await import("../lib/letter-token.ts");
const { makeUnsubscribeToken } = await import("../lib/unsubscribe.ts");
const { renderHTML } = await import("../lib/email.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const uid = "11111111-2222-3333-4444-555555555555";

// (1) Round trip
const tok = makeLetterToken(uid);
check("mint → verify round-trips to the same userId", verifyLetterToken(tok) === uid);

// (2) Tampering
const [u, e, s] = tok.split(".");
check("tampered userId rejected", verifyLetterToken(`99999999-2222-3333-4444-555555555555.${e}.${s}`) === null);
check("tampered expiry rejected", verifyLetterToken(`${u}.${Number(e) + 9999}.${s}`) === null);
check("tampered sig rejected", verifyLetterToken(`${u}.${e}.AAAAAAAAAAAAAAAA`) === null);
check("garbage rejected", verifyLetterToken("not-a-token") === null);
check("empty rejected", verifyLetterToken("") === null);
check("overlong rejected", verifyLetterToken("x".repeat(300)) === null);

// (3) Expiry honored
const expired = makeLetterToken(uid, -1); // TTL -1 day → already expired
check("expired token rejected", verifyLetterToken(expired) === null);

// (4) Domain separation: an unsubscribe token must NOT verify as a letter
// token (same secret, different HMAC input).
const unsub = makeUnsubscribeToken(uid);
check("unsubscribe token shape rejected outright", verifyLetterToken(unsub) === null);
// And a forged letter-shaped token built from the unsubscribe sig must fail.
const [uu, us] = [unsub.slice(0, unsub.lastIndexOf(".")), unsub.slice(unsub.lastIndexOf(".") + 1)];
check(
  "unsubscribe sig can't be replayed into a letter token",
  verifyLetterToken(`${uu}.${Math.floor(Date.now() / 1000) + 1000}.${us}`) === null
);

// (5) letterUrl shape
const url = letterUrl(uid, "https://youngalgy.com/");
check("letterUrl targets /alpha/letter?t=", url.startsWith("https://youngalgy.com/alpha/letter?t="));

// (6) Email CTA prefers the letter URL; signin small-print intact
const html = renderHTML({
  firstName: "Sam",
  teaser: "teaser",
  sectionList: "• A\n• B",
  inboxUrl: "https://youngalgy.com/alpha/inbox",
  letterUrl: url,
  weekOf: "2026-06-07",
  magicLink: null,
  unsubscribeUrl: null,
});
check("CTA href is the tokenized letter URL", html.includes(`href="${url.replace(/&/g, "&amp;")}"`) || html.includes(`href="${url}"`));
check("CTA is NOT the bare inbox link anymore", !html.includes('href="https://youngalgy.com/alpha/inbox"'));
check("sign-in small print kept", html.includes("/alpha/signin"));

// (7) Legacy fallback: no letterUrl → CTA falls back to inbox
const legacy = renderHTML({
  firstName: "Sam",
  teaser: "t",
  sectionList: "• A",
  inboxUrl: "https://youngalgy.com/alpha/inbox",
  letterUrl: null,
  weekOf: "2026-06-07",
  magicLink: null,
  unsubscribeUrl: null,
});
check("no token → CTA falls back to /inbox", legacy.includes('href="https://youngalgy.com/alpha/inbox"'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("LETTER TOKEN VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL LETTER-TOKEN ASSERTIONS PASS");
