// Verify the fix (alpha-drift-r19-01, 2026-08-07) for a real header-
// injection-shaped bug: round 18's own support-form replyTo fix interpolated
// a free-text, user-controlled display name straight into a compound RFC
// 5322 mailbox (`${name} <${email}>`) with zero sanitization. A name
// containing '<'/'>' produces a malformed compound address (two bracketed
// address groups); a name containing CR/LF is the classic raw-header-
// injection vector. sanitizeDisplayName() closes this.
// Run: npx tsx scripts/verify-sanitize-display-name.mts
const { sanitizeDisplayName } = await import("../lib/email.ts");

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SANITIZE-DISPLAY-NAME VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SANITIZE-DISPLAY-NAME ASSERTIONS PASS");
