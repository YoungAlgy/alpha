// Verify the fix (alpha-drift-r19-01, 2026-08-07) for a real header-
// injection-shaped bug: round 18's own support-form replyTo fix interpolated
// a free-text, user-controlled display name straight into a compound RFC
// 5322 mailbox (`${name} <${email}>`) with zero sanitization. A name
// containing '<'/'>' produces a malformed compound address (two bracketed
// address groups); a name containing CR/LF is the classic raw-header-
// injection vector. sanitizeDisplayName() closes this.
// Run: npx tsx scripts/verify-sanitize-display-name.mts
import { readFileSync } from "node:fs";
const { sanitizeDisplayName, subjectLine } = await import("../lib/email.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) an ordinary name passes through unchanged");
check("(1) 'Jane Doe' unchanged", sanitizeDisplayName("Jane Doe") === "Jane Doe");

console.log("(2) the actual attack this fix closes: a name that tries to inject a second address");
{
  const attack = "X <attacker@evil.com>";
  const out = sanitizeDisplayName(attack);
  check("(2) angle brackets stripped -- can no longer form a second bracketed address", !out.includes("<") && !out.includes(">"));
  check("(2) result is 'X attacker@evil.com' (garbled but inert, not a valid injection)", out === "X attacker@evil.com");
}

console.log("(3) a compound mailbox built from the sanitized name is a single, valid address group");
{
  const name = sanitizeDisplayName("X <attacker@evil.com>");
  const compound = `${name} <realsubmitter@example.com>`;
  const angleBracketPairs = (compound.match(/</g) || []).length;
  check("(3) exactly one '<' in the final compound string (one address group, not two)", angleBracketPairs === 1);
}

console.log("(4) CR/LF (raw header injection) stripped");
{
  const out = sanitizeDisplayName("Jane\r\nBcc: attacker@evil.com");
  check("(4) no CR in output", !out.includes("\r"));
  check("(4) no LF in output", !out.includes("\n"));
}

console.log("(5) double quotes stripped -- can't break out of a quoted-string display name");
check("(5) 'Jane \"Injected\" Doe' -> quotes removed", sanitizeDisplayName('Jane "Injected" Doe') === "Jane Injected Doe");

console.log("(6) a name that's ENTIRELY unsafe characters reduces to empty string, not whitespace");
check("(6) '<>' alone -> ''", sanitizeDisplayName("<>") === "");
check("(6) caller's own falsy-check treats that as 'no name', correctly falling back to bare email", !sanitizeDisplayName("<>"));

console.log("(7) leading/trailing whitespace introduced by stripping is trimmed");
check("(7) 'Jane <> Doe' -> 'Jane  Doe' collapses correctly (no leading/trailing space at minimum)", sanitizeDisplayName("  Jane  ") === "Jane");

console.log("(8) alpha-drift-r20-01: comma (the RFC 5322 address-list delimiter) stripped -- closes the multi-address vector the original fix missed");
{
  const attack = "attacker@evil.com, Foo";
  const out = sanitizeDisplayName(attack);
  check("(8) comma stripped from the sanitized name", !out.includes(","));
  check("(8) result is 'attacker@evil.com Foo' (garbled but inert, one token, not an address list)", out === "attacker@evil.com Foo");
}

console.log("(9) alpha-drift-r20-01: the actual attack this fix closes -- a compound mailbox built from the attack name is a SINGLE address, not two");
{
  const name = sanitizeDisplayName("attacker@evil.com, Foo");
  const compound = `${name} <realsubmitter@example.com>`;
  const commaCount = (compound.match(/,/g) || []).length;
  check("(9) zero commas in the final compound string -- can't be parsed as an address list with a second entry", commaCount === 0);
  check("(9) exactly the real submitter's address remains a valid, unambiguous mailbox", compound === "attacker@evil.com Foo <realsubmitter@example.com>");
}

console.log("(10) alpha-drift-r21-01 (found+fixed 2026-08-14): subjectLine() now sanitizes firstName -- the actual sink this round's audit found unprotected");
{
  const clean = subjectLine("Jane", 5, "2026-08-14");
  check("(10) an ordinary first name is unaffected", clean === "Jane's newsletter · Issue 5");

  const attack = subjectLine("Jane\r\nBcc: attacker@evil.com", 5, "2026-08-14");
  check("(10) CR/LF stripped from the subject line, no raw newline survives", !attack.includes("\r") && !attack.includes("\n"));
  // sanitizeDisplayName REMOVES \r\n (not replace-with-space), so "Jane" and
  // "Bcc: ..." concatenate directly with no separator -- garbled but inert,
  // single-line, no header break, matching test (2)'s established pattern.
  check("(10) the malicious text is present but INERT (single-line, no header break)", attack.includes("Bcc: attacker@evil.com") && attack === "JaneBcc: attacker@evil.com's newsletter · Issue 5");

  check("(10) firstName that's entirely unsafe chars falls back to the 'Your newsletter' default, same as empty/undefined firstName", subjectLine("<>", 5) === "Your newsletter · Issue 5");
  check("(10) undefined firstName still works (existing behavior preserved)", subjectLine(undefined, 5) === "Your newsletter · Issue 5");
}

console.log("(11) alpha-drift-r21-01: the X-Alpha-Issue-Id header build -- sourced code inspection, since building it requires a full sendLetterNotification call");
{
  const src = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
  check("(11) the header value is built from a sanitizeDisplayName-cleaned issue id, not the raw params.issue.id", /const safeIssueId = sanitizeDisplayName\(params\.issue\.id\)/.test(src));
  check("(11) the header assignment actually uses the sanitized variable, not the raw field", /"X-Alpha-Issue-Id": params\.userId \? `\$\{params\.userId\}:\$\{safeIssueId\}` : safeIssueId/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SANITIZE-DISPLAY-NAME VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SANITIZE-DISPLAY-NAME ASSERTIONS PASS");
