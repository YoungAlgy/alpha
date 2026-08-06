// Verify lib/resend-webhook-guards.ts — pure, no network. This is the one
// decision app/api/webhooks/resend/route.ts exists to get right: hard
// bounce vs. everything else. See the guard file's own comment for the
// blast radius of getting it backwards in either direction.
// Run: npx tsx scripts/verify-resend-webhook-guards.mts
const { isHardBounce, normalizeRecipients } = await import("../lib/resend-webhook-guards.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) isHardBounce — only 'Permanent' suppresses");
check("(1) 'Permanent' -> hard bounce, suppress", isHardBounce("Permanent") === true);
check("(1) 'Transient' -> NOT a hard bounce, must not suppress", isHardBounce("Transient") === false);
check("(1) 'Undetermined' -> NOT a hard bounce, must not suppress", isHardBounce("Undetermined") === false);
check("(1) undefined (malformed/missing field) -> must not suppress", isHardBounce(undefined) === false);
check("(1) an unrecognized future value from Resend -> must not suppress (fail closed, not open)", isHardBounce("SomeNewBounceCategory") === false);
check("(1) case-sensitive -- 'permanent' (wrong case) must NOT match", isHardBounce("permanent") === false);

console.log("(2) normalizeRecipients — shape, case, dedup");
check("(2) a normal array is lowercased", JSON.stringify(normalizeRecipients(["Reader@Example.com"])) === JSON.stringify(["reader@example.com"]));
check("(2) whitespace is trimmed", JSON.stringify(normalizeRecipients([" reader@example.com "])) === JSON.stringify(["reader@example.com"]));
check("(2) duplicates (post-normalization) are deduped", normalizeRecipients(["a@x.com", "A@X.com"]).length === 1);
check("(2) non-string entries are dropped, not thrown on", JSON.stringify(normalizeRecipients(["a@x.com", 42, null, {}])) === JSON.stringify(["a@x.com"]));
check("(2) blank/whitespace-only strings are dropped", JSON.stringify(normalizeRecipients(["a@x.com", "   ", ""])) === JSON.stringify(["a@x.com"]));
check("(2) a non-array input (malformed payload) returns an empty list, not a throw", JSON.stringify(normalizeRecipients("not-an-array")) === "[]");
check("(2) null input returns an empty list", JSON.stringify(normalizeRecipients(null)) === "[]");
check("(2) an empty array returns an empty list", JSON.stringify(normalizeRecipients([])) === "[]");
check("(2) multiple distinct real recipients are all kept, in order", JSON.stringify(normalizeRecipients(["a@x.com", "b@x.com"])) === JSON.stringify(["a@x.com", "b@x.com"]));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RESEND-WEBHOOK GUARDS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RESEND-WEBHOOK GUARDS ASSERTIONS PASS");
