// Render the letter email HTML to a file + validate markup. No send.
import { writeFileSync } from "node:fs";
const { renderHTML } = await import("../lib/email.ts");
const { SAMPLE_ISSUE } = await import("../lib/sample-issue.ts");
const html = renderHTML({
  firstName: SAMPLE_ISSUE.recipientFirstName,
  teaser: SAMPLE_ISSUE.editorIntro.slice(0, 320).trim(),
  sectionList: SAMPLE_ISSUE.sections.map((s) => `• ${s.topicLabel}`).join("\n"),
  inboxUrl: "https://youngalgy.com/alpha/inbox",
  weekOf: SAMPLE_ISSUE.weekOf,
  magicLink: null,
  unsubscribeUrl: "https://youngalgy.com/alpha/api/unsubscribe?token=demo",
});
writeFileSync("/tmp/alpha-email-preview.html", html);
const checks: [string, boolean][] = [
  ["viewport meta", html.includes('name="viewport"')],
  ["color-scheme light", html.includes('name="color-scheme" content="light"')],
  ["supported-color-schemes", html.includes("supported-color-schemes")],
  ["mobile padding media query", html.includes("@media only screen and (max-width:600px)") && html.includes("alpha-wrap")],
  ["unsubscribe link", html.includes("/api/unsubscribe")],
  ["CTA to inbox", html.includes("/alpha/inbox")],
  ["no leftover template tokens", !html.includes("${")],
  ["balanced html tags", (html.match(/<div/g)||[]).length === (html.match(/<\/div>/g)||[]).length],
];
let ok = true;
for (const [n, p] of checks) { console.log(`${p ? "PASS" : "FAIL"}  ${n}`); if (!p) ok = false; }
console.log(`bytes: ${html.length}`);
process.exit(ok ? 0 : 1);
