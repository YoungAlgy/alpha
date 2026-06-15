// Verify the welcome email renders correctly — PURE render, NO live send.
// Run: npx tsx scripts/verify-welcome-email.mts
import { writeFileSync } from "node:fs";
const { renderWelcomeHTML } = await import("../lib/email.ts");

const html = renderWelcomeHTML({
  firstName: "Sam",
  inboxUrl: "https://youngalgy.com/alpha/inbox",
});

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

check("greets the recipient by name", html.includes("You're in, Sam."));
check("links to the first letter (inbox)", html.includes('href="https://youngalgy.com/alpha/inbox"'));
check("sign-in fallback points at /signin", html.includes('href="https://youngalgy.com/alpha/signin"'));
check("sets the 3x cadence (Sun/Tue/Thu)", /three times a week/i.test(html) && /Sunday, Tuesday, and Thursday/i.test(html));
check("has the read-first-letter CTA", html.includes("Read your first letter"));
check("signed by Algy", html.includes("Algy"));
check("dark-mode guard present (color-scheme light)", html.includes('name="color-scheme" content="light"'));
check("mobile viewport present", html.includes("width=device-width"));
check("valid doctype + closes html", html.trim().startsWith("<!doctype html>") && html.trim().endsWith("</html>"));

// A name with HTML-unsafe characters must be escaped, not injected raw.
const evil = renderWelcomeHTML({ firstName: 'A<b>"&', inboxUrl: "https://x/alpha/inbox" });
check("escapes an HTML-unsafe name", evil.includes("A&lt;b&gt;") && !evil.includes("A<b>"));

writeFileSync("/tmp/alpha-welcome.html", html);
console.log("\nrendered → /tmp/alpha-welcome.html (open to eyeball)");
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("WELCOME EMAIL RENDER FAILED");
  process.exit(1);
}
console.log("ALL WELCOME EMAIL ASSERTIONS PASS (no live send)");
