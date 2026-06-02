// Verify the funnel email validator accepts what real subscribers type and
// rejects the typos that would silently break paid delivery. Run:
//   npx tsx scripts/verify-email-validation.mts
const { isValidEmail, emailError } = await import("../lib/validate-email.ts");

const ACCEPT = [
  "john@gmail.com",
  "a@b.co",
  "jane.doe+tag@sub.example.co.uk",
  "x@y.io",
  "name@domain.technology",
  "  trim.me@example.com  ", // leading/trailing space is trimmed → valid
  "O'Brien@example.com",
];

const REJECT = [
  "",
  "john@gmail", // the classic: no TLD — browser type=email ACCEPTS this
  "a@b", // no dot at all
  "notanemail",
  "@gmail.com",
  "john@.com",
  "john@gmail.c", // 1-char TLD
  "foo @bar.com", // space in local part
  "foo@bar .com", // space in domain
  "john@@gmail.com",
  "john gmail.com", // no @
];

let pass = 0;
let fail = 0;

console.log("ACCEPT (should be valid):");
for (const e of ACCEPT) {
  const ok = isValidEmail(e);
  const errNull = emailError(e) === null;
  const good = ok && errNull;
  console.log(`  ${good ? "OK " : "XX "} ${JSON.stringify(e)} → valid=${ok} err=${emailError(e) ?? "null"}`);
  good ? pass++ : fail++;
}

console.log("REJECT (should be invalid + carry a friendly message):");
for (const e of REJECT) {
  const ok = isValidEmail(e);
  const msg = emailError(e);
  const good = !ok && typeof msg === "string" && msg.length > 0;
  console.log(`  ${good ? "OK " : "XX "} ${JSON.stringify(e)} → valid=${ok} err=${msg ?? "null"}`);
  good ? pass++ : fail++;
}

// Empty must use the dedicated "enter your email" copy, not the typo copy.
const emptyMsg = emailError("");
const emptyGood = !!emptyMsg && /enter your email/i.test(emptyMsg);
console.log(`empty-string copy is the 'enter your email' message: ${emptyGood ? "OK" : "XX"} (${emptyMsg})`);
emptyGood ? pass++ : fail++;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("VALIDATION TABLE FAILED");
  process.exit(1);
}
console.log("ALL EMAIL VALIDATION ASSERTIONS PASS ✓");
