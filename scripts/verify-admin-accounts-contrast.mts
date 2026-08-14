// Verify round 21's WCAG contrast fix (alpha-drift-r21-02, 2026-08-14):
// app/settings/accounts/page.tsx colored its status labels, the new
// SUPPRESSED badge, and every action button with var(--accent-ink) on
// var(--paper) -- computed against the real hex values in app/globals.css,
// that pair fails the WCAG AA 4.5:1 normal-text minimum in 11 of this app's
// 25 themes (including root/forest, the default a fresh signup renders
// before ever picking a theme), and fails even the 3:1 large-text/UI floor
// in marina (2.78:1). Fixed by swapping to var(--ink) for every TEXT color
// on this page -- computed to clear 4.5:1 in every single theme.
// Run: npx tsx scripts/verify-admin-accounts-contrast.mts
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

console.log("(1) contrastRatio() sanity check against known WCAG reference pairs");
{
  check("(1) black on white = 21:1 (the maximum possible ratio)", Math.abs(contrastRatio("#000000", "#FFFFFF") - 21) < 0.01);
  check("(1) identical colors = 1:1 (no contrast at all)", Math.abs(contrastRatio("#A88947", "#A88947") - 1) < 0.01);
}

console.log("(2) every theme's real --ink/--paper pair clears WCAG AA 4.5:1 for normal text");
{
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const blocks = css.split(/(?=\[data-theme=|^:root)/m);
  const results: Array<{ name: string; inkContrast: number; accentInkContrast: number | null }> = [];
  for (const b of blocks) {
    const nameMatch = b.match(/\[data-theme="([^"]+)"\]|^:root/);
    if (!nameMatch) continue;
    const name = nameMatch[1] || "root";
    const paper = b.match(/--paper:\s*(#[0-9A-Fa-f]{6})/);
    const ink = b.match(/\n\s*--ink:\s*(#[0-9A-Fa-f]{6})/);
    const accentInk = b.match(/--accent-ink:\s*(#[0-9A-Fa-f]{6})/);
    if (!paper || !ink) continue;
    results.push({
      name,
      inkContrast: contrastRatio(ink[1], paper[1]),
      accentInkContrast: accentInk ? contrastRatio(accentInk[1], paper[1]) : null,
    });
  }
  check("(2) parsed a real, non-trivial number of themes from globals.css", results.length >= 20);
  const failingInk = results.filter((r) => r.inkContrast < 4.5);
  for (const r of failingInk) console.log(`    XX theme "${r.name}": ink/paper = ${r.inkContrast.toFixed(2)}:1 (below 4.5:1)`);
  check("(2) --ink on --paper clears 4.5:1 AA normal-text contrast in EVERY theme", failingInk.length === 0);

  // Confirms the finding's own claim as a sanity check on the parser + the
  // bug this fix closes -- accent-ink genuinely does fail in multiple themes.
  const failingAccentInk = results.filter((r) => r.accentInkContrast !== null && r.accentInkContrast < 4.5);
  check(
    "(2) sanity: --accent-ink DOES fail 4.5:1 in multiple real themes (confirms the bug this fix closes actually exists)",
    failingAccentInk.length >= 8
  );
  const root = results.find((r) => r.name === "root");
  check("(2) sanity: the DEFAULT theme (root, what a fresh signup sees) is one of the failing ones", !!root && root.accentInkContrast !== null && root.accentInkContrast < 3);
}

console.log("(3) source-level regression guard: the admin accounts page no longer uses accent-ink for any text");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  // Match the real style-value usage specifically (color: "var(--accent-ink)"),
  // not the fix's own explanatory comment, which quotes the token in prose.
  check("(3) zero remaining var(--accent-ink) style-color usages on this page", !/color:\s*"var\(--accent-ink\)"/.test(src));
  check("(3) statusLabel's Paying/Free-granted colors use var(--ink) now", /label: "Paying", color: "var\(--ink\)"/.test(src) && /label: "Free \(granted\)", color: "var\(--ink\)"/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("ADMIN-ACCOUNTS-CONTRAST VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ADMIN-ACCOUNTS-CONTRAST ASSERTIONS PASS");
