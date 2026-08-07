// Render the letter + welcome email HTML to files + validate markup. No send.
// alpha-drift-r14-06 (review 2026-08-06): extended to cover the table-based
// Outlook layout, the Gmail dark-mode re-assertion block, and the headline
// length defense (both the sender-side cap and the CSS-side overflow-wrap
// fallback), added alongside those fixes.
import { writeFileSync } from "node:fs";
const { renderHTML, renderWelcomeHTML } = await import("../lib/email.ts");
const { SAMPLE_ISSUE } = await import("../lib/sample-issue.ts");

const OUT_DIR = process.env.ALPHA_PREVIEW_DIR || ".";

// A deliberately absurd single-token headline -- no whitespace at all, so
// plain `white-space:pre-wrap` alone (which only breaks at whitespace)
// cannot wrap it; only overflow-wrap:anywhere/word-break:break-word can.
// Exercises the CSS-side defense directly, independent of the sender-side
// MAX_HEADLINE_LEN cap (that cap is inside sendLetterNotification, not
// renderHTML itself, so this script -- which calls renderHTML directly --
// bypasses it on purpose to prove the CSS fallback alone is sufficient).
const LONG_HEADLINE = "A".repeat(180);
const sectionListWithLongHeadline = [
  `• ${SAMPLE_ISSUE.sections[0]?.topicLabel ?? "Topic"} — ${LONG_HEADLINE}`,
  ...SAMPLE_ISSUE.sections.slice(1).map((s) => `• ${s.topicLabel}`),
].join("\n");

const html = renderHTML({
  firstName: SAMPLE_ISSUE.recipientFirstName,
  teaser: SAMPLE_ISSUE.editorIntro.slice(0, 320).trim(),
  sectionList: sectionListWithLongHeadline,
  inboxUrl: "https://alpha.everyday.report/inbox",
  weekOf: SAMPLE_ISSUE.weekOf,
  unsubscribeUrl: "https://alpha.everyday.report/api/unsubscribe?token=demo",
});
writeFileSync(`${OUT_DIR}/alpha-email-preview.html`, html);

const welcomeHtml = renderWelcomeHTML({
  firstName: SAMPLE_ISSUE.recipientFirstName,
  inboxUrl: "https://alpha.everyday.report/inbox",
  unsubscribeUrl: "https://alpha.everyday.report/api/unsubscribe?token=demo",
});
writeFileSync(`${OUT_DIR}/alpha-email-preview-welcome.html`, welcomeHtml);

function runChecks(label: string, html: string): boolean {
  console.log(`\n=== ${label} ===`);
  const checks: [string, boolean][] = [
    ["viewport meta", html.includes('name="viewport"')],
    ["color-scheme light", html.includes('name="color-scheme" content="light"')],
    ["supported-color-schemes", html.includes("supported-color-schemes")],
    ["mobile padding media query", html.includes("@media only screen and (max-width:600px)") && html.includes("alpha-wrap-td")],
    ["unsubscribe link", html.includes("/api/unsubscribe")],
    ["CTA to inbox", html.includes("/inbox")],
    ["no leftover template tokens", !html.includes("${")],
    ["balanced html tags", (html.match(/<div/g) || []).length === (html.match(/<\/div>/g) || []).length],
    // alpha-drift-r14-06 additions:
    ["Outlook MSO conditional comment present", html.includes("<!--[if mso]>")],
    ["outer table has an explicit HTML width attribute (Outlook honors this, not CSS max-width)", /width="560"/.test(html)],
    ["table rows are balanced (<table> opens/closes match)", (html.match(/<table/g) || []).length === (html.match(/<\/table>/g) || []).length],
    ["dark-mode media query present", html.includes("@media (prefers-color-scheme: dark)")],
    ["dark-mode block re-asserts the background with !important", /background:\s*#F4EFE0\s*!important/.test(html)],
    ["dark-mode class hooks are actually used on elements, not just declared", html.includes('class="alpha-ink') && html.includes('class="alpha-bg')],
  ];
  // Only the letter template has a <pre> sectionList block -- the welcome
  // email doesn't render one at all, so this check doesn't apply there.
  if (html.includes("<pre")) {
    checks.push([
      "pre block has overflow-wrap + word-break (CSS-side headline overflow defense)",
      /white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;/.test(html),
    ]);
  }
  let ok = true;
  for (const [n, p] of checks) {
    console.log(`${p ? "PASS" : "FAIL"}  ${n}`);
    if (!p) ok = false;
  }
  console.log(`bytes: ${html.length}`);
  return ok;
}

const letterOk = runChecks("letter email (renderHTML)", html);
const welcomeOk = runChecks("welcome email (renderWelcomeHTML)", welcomeHtml);

console.log(`\nWrote:\n  ${OUT_DIR}/alpha-email-preview.html\n  ${OUT_DIR}/alpha-email-preview-welcome.html`);
process.exit(letterOk && welcomeOk ? 0 : 1);
