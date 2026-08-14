// Verify round 23 finding (alpha-drift-r23-02, 2026-08-14, HIGH): --accent-ink
// -- the one color this app used for error/validation text, with no
// dedicated --danger/--error token -- fails WCAG AA 4.5:1 normal-text
// contrast against --paper in 12+ of this app's themes (2.88:1 in the
// default "forest" theme). Reachable at real, small-reading-size error
// text: /you's r22-04 birthday-invalid message, checkout's Stripe-failure
// message, QuestionStep's email-format validation error, /writing's "done"
// checkmark + "Wait on the inbox" link, SupportForm's error message, and
// topics's custom-topic error + save-error status line.
//
// Round 21 already established the precedent for this exact situation
// (--accent-ink is shared with many non-text UI surfaces app-wide, so
// recoloring the token itself is a much bigger design-system change than
// this finding calls for) -- swap the specific error/validation TEXT
// usages to --ink instead, which round 21 already proved clears 4.5:1 in
// EVERY theme. This does NOT touch --accent-ink's own definition or any of
// its ~50 other (decorative/branding/selection-state) usages app-wide.
// Run: npx tsx scripts/verify-accent-ink-error-text-contrast.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function hexToLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = hexToLuminance(hex1);
  const l2 = hexToLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

console.log("(1) sanity: --accent-ink genuinely DOES fail 4.5:1 in multiple real themes (confirms the bug this fix routes around actually exists)");
{
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const blocks = css.split(/(?=\[data-theme=|^:root)/m);
  const results: Array<{ name: string; accentInkContrast: number | null; inkContrast: number | null }> = [];
  for (const b of blocks) {
    const nameMatch = b.match(/\[data-theme="([^"]+)"\]|^:root/);
    if (!nameMatch) continue;
    const name = nameMatch[1] || "root";
    const paper = b.match(/--paper:\s*(#[0-9A-Fa-f]{6})/);
    const accentInk = b.match(/--accent-ink:\s*(#[0-9A-Fa-f]{6})/);
    const ink = b.match(/\n\s*--ink:\s*(#[0-9A-Fa-f]{6})/);
    if (!paper) continue;
    results.push({
      name,
      accentInkContrast: accentInk ? contrastRatio(accentInk[1], paper[1]) : null,
      inkContrast: ink ? contrastRatio(ink[1], paper[1]) : null,
    });
  }
  check("(1) parsed a real, non-trivial number of themes", results.length >= 20);
  const failingAccentInk = results.filter((r) => r.accentInkContrast !== null && r.accentInkContrast < 4.5);
  check("(1) --accent-ink fails 4.5:1 in 10+ real themes", failingAccentInk.length >= 10);
  const root = results.find((r) => r.name === "root");
  check("(1) sanity: the DEFAULT theme (root, what a fresh signup sees) is one of the failing ones", !!root && root.accentInkContrast !== null && root.accentInkContrast < 3);
  console.log("(2) --ink clears 4.5:1 in EVERY theme -- the color this fix routes error text to instead");
  const failingInk = results.filter((r) => r.inkContrast !== null && r.inkContrast < 4.5);
  for (const r of failingInk) console.log(`    XX theme "${r.name}": ink/paper = ${r.inkContrast?.toFixed(2)}:1 (below 4.5:1)`);
  check("(2) --ink on --paper clears 4.5:1 AA in every theme with both tokens defined", failingInk.length === 0);
}

console.log("(3) source: every specific error/validation-text site this fix touched now uses --ink, not --accent-ink, for TEXT color");
{
  const sites: Array<{ file: string; pattern: RegExp; label: string }> = [
    { file: "app/you/page.tsx", pattern: /\(birthday\.length > 0 && !birthdayValid\) \? "var\(--ink\)" : "var\(--ink-soft\)"/, label: "you/page.tsx birthday-invalid message" },
    { file: "app/checkout/page.tsx", pattern: /style=\{\{ color: "var\(--ink\)" \}\}/, label: "checkout/page.tsx Stripe failure message" },
    { file: "components/onboarding/QuestionStep.tsx", pattern: /style=\{\{ color: "var\(--ink\)" \}\}/, label: "QuestionStep.tsx validation error" },
    { file: "app/writing/page.tsx", pattern: /status === "done"\s*\?\s*"var\(--ink\)"\s*\n\s*: "var\(--ink-soft\)",/, label: "writing/page.tsx done-checkmark color" },
    { file: "app/support/SupportForm.tsx", pattern: /role="alert" className="alpha-ui text-sm" style=\{\{ color: "var\(--ink\)" \}\}/, label: "SupportForm.tsx error message" },
    { file: "app/topics/page.tsx", pattern: /role="alert" aria-live="assertive" className="alpha-ui text-xs" style=\{\{ color: "var\(--ink\)" \}\}/, label: "topics/page.tsx custom-topic error" },
    { file: "app/topics/page.tsx", pattern: /color: saveError \? "var\(--ink\)" : "var\(--ink-soft\)"/, label: "topics/page.tsx save-error status" },
  ];
  for (const site of sites) {
    const src = readFileSync(new URL(`../${site.file}`, import.meta.url), "utf8");
    check(`(3) ${site.label} uses --ink`, site.pattern.test(src));
  }
  // "Wait on the inbox" link is distinguishable by its own unique text.
  const writingSrc = readFileSync(new URL("../app/writing/page.tsx", import.meta.url), "utf8");
  const linkIdx = writingSrc.indexOf("Wait on the inbox");
  const linkRegion = linkIdx > -1 ? writingSrc.slice(Math.max(0, linkIdx - 300), linkIdx) : "";
  check("(3) writing/page.tsx 'Wait on the inbox' link uses --ink", /style=\{\{ color: "var\(--ink\)" \}\}/.test(linkRegion));
}

console.log("(4) source: --accent-ink's OWN definition is untouched -- this fix reroutes specific text usages, it does not recolor the shared token (round 21's precedent, deliberately not repeated as a token-wide change here)");
{
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const rootAccentInk = css.match(/:root\s*\{[^}]*--accent-ink:\s*(#[0-9A-Fa-f]{6})/);
  check("(4) root --accent-ink is still #A88947 (unchanged)", !!rootAccentInk && rootAccentInk[1] === "#A88947");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ACCENT-INK-ERROR-TEXT-CONTRAST VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ACCENT-INK-ERROR-TEXT-CONTRAST ASSERTIONS PASS");
