// Verify the fix (alpha-drift-r19-01, 2026-08-07) for a real contradiction:
// app/privacy/page.tsx promises "We don't track which individual letters you
// read," but PostHog attaches the current page URL to EVERY event while a
// reader is on /inbox/[issueId] -- not just the manual capturePageview()
// call, but every autocaptured click too. redactIssueIds() is wired in as
// PostHog's sanitize_properties hook (runs on every outgoing event
// regardless of capture method), so this tests it directly rather than the
// browser-only posthog-js integration around it.
// Run: npx tsx scripts/verify-analytics-redaction.mts
const { redactIssueIds } = await import("../lib/analytics.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) a real issue UUID in $current_url gets redacted");
{
  const props = { $current_url: "https://alpha.everyday.report/inbox/3f2a1b4c-5d6e-4f70-8091-a2b3c4d5e6f7" };
  const out = redactIssueIds(props);
  check("(1) UUID replaced with [id]", out.$current_url === "https://alpha.everyday.report/inbox/[id]");
}

console.log("(2) an autocapture-style event with $pathname AND $current_url both carrying the UUID -- both redacted");
{
  const props = {
    event: "$autocapture",
    $current_url: "https://alpha.everyday.report/inbox/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    $pathname: "/inbox/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };
  const out = redactIssueIds(props);
  check("(2) $current_url redacted", out.$current_url === "https://alpha.everyday.report/inbox/[id]");
  check("(2) $pathname redacted too -- sanitize_properties covers every string prop, not just one known key", out.$pathname === "/inbox/[id]");
}

console.log("(3) an unrelated page (no /inbox/ at all) is left completely untouched");
{
  const props = { $current_url: "https://alpha.everyday.report/archive", other: "value" };
  const out = redactIssueIds({ ...props });
  check("(3) non-inbox URL unchanged", out.$current_url === props.$current_url);
  check("(3) other string props untouched", out.other === "value");
}

console.log("(4) /inbox/ with no UUID after it (e.g. just the list page) is left untouched -- only a real issue id gets redacted");
{
  const props = { $current_url: "https://alpha.everyday.report/inbox" };
  const out = redactIssueIds(props);
  check("(4) bare /inbox (no id segment) unchanged", out.$current_url === props.$current_url);
}

console.log("(5) a UUID that appears somewhere OTHER than right after /inbox/ is not touched -- avoids over-matching unrelated ids");
{
  const props = { $current_url: "https://alpha.everyday.report/some-other-path?ref=3f2a1b4c-5d6e-4f70-8091-a2b3c4d5e6f7" };
  const out = redactIssueIds(props);
  check("(5) unrelated UUID left alone", out.$current_url === props.$current_url);
}

console.log("(6) non-string property values pass through untouched (no crash on numbers/booleans/objects)");
{
  const props = { count: 42, active: true, meta: { nested: "/inbox/3f2a1b4c-5d6e-4f70-8091-a2b3c4d5e6f7" } };
  const out = redactIssueIds({ ...props });
  check("(6) number untouched", out.count === 42);
  check("(6) boolean untouched", out.active === true);
  check("(6) nested object reference untouched (redaction is shallow, by design -- top-level string props only, matching every known PostHog URL property)", out.meta === props.meta);
}

console.log("(7) multiple distinct issue ids in the SAME string (e.g. a referrer chain) all get redacted, not just the first");
{
  const props = { chain: "from /inbox/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee to /inbox/11111111-2222-3333-4444-555555555555" };
  const out = redactIssueIds(props);
  check("(7) both ids redacted", out.chain === "from /inbox/[id] to /inbox/[id]");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ANALYTICS-REDACTION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ANALYTICS-REDACTION ASSERTIONS PASS");
