// Verify round 25 findings: #177 (privacy.tsx's "irreversible" delete claim
// contradicted by a 30-day encrypted DB backup, no disclosure), #178 (5
// standalone nav links under the 24px WCAG 2.5.8 touch-target minimum),
// #180 (--accent-ink used for plain informational text -- outside
// role=alert/status, so round 23/24's scan never caught it -- fails WCAG AA
// contrast), and #182 (privacy.tsx mislabels DeepSeek as a "free backup
// provider" and makes an unsubstantiated training-policy claim about it).
// alpha-drift-r25-01/02(covered separately)/03/04, all 2026-08-14.
// Run: npx tsx scripts/verify-r25-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function normalize(src: string): string {
  return src.replace(/\s+/g, " ");
}

console.log("(1) privacy.tsx: backup-retention disclosure added alongside the irreversible-delete claim");
{
  const src = normalize(readFileSync(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"));
  check("(1a) the original irreversible-delete claim is still present (not removed, just no longer the whole story)", /Delete your account and all associated data \(irreversible\) from the same place\./.test(src));
  check("(1b) new disclosure names the 30-day retention window", /encrypted daily backup of the database for up to 30 days/.test(src));
  check("(1c) new disclosure explains what this means for a deleted account", /your data can still exist in a backup taken before you deleted it/.test(src));
  check("(1d) frames it as a safety net for OUR mistakes, not a way to recover a reader's own deletion", /a safety net against our own mistakes, not\s*yours/.test(src));

  // Cross-check against the actual backup workflow so this disclosure can't
  // silently drift from reality the way the original claim did.
  const workflow = readFileSync(new URL("../.github/workflows/db-backup.yml", import.meta.url), "utf8");
  check("(1e) sanity: the real workflow's retention really is 30 days (disclosure matches reality, not a guess)", /retention-days:\s*30/.test(workflow));
}

console.log("(2) 5 standalone nav links now use the established py-3 -my-3 touch-target pattern");
{
  const sites: Array<{ file: string; label: string }> = [
    { file: "app/inbox/[issueId]/page.tsx", label: "← Archive" },
    { file: "app/page.tsx", label: "Sign in →" },
    { file: "app/letter/page.tsx", label: "Sign in →" },
    { file: "app/settings/accounts/page.tsx", label: "← Back to settings" },
    { file: "app/settings/changelog/page.tsx", label: "← Back to settings" },
  ];
  for (const site of sites) {
    const src = readFileSync(new URL(`../${site.file}`, import.meta.url), "utf8");
    check(`(2) ${site.file} (${site.label}) has py-3 -my-3 on its nav link`, /className="alpha-ui text-sm py-3 -my-3"/.test(src));
  }
}

console.log("(3) --accent-ink swapped to --ink-soft (passes 4.5:1 in all 26 themes) for plain informational text outside role=alert/status");
{
  const sites: Array<{ file: string; context: RegExp }> = [
    { file: "components/Digest.tsx", context: /className="alpha-mono mb-2"\s*style=\{\{ color: "var\(--ink-soft\)" \}\}/ },
    { file: "app/archive/page.tsx", context: /className="alpha-mono mb-1" style=\{\{ color: "var\(--ink-soft\)" \}\}/ },
    { file: "app/inbox/page.tsx", context: /className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"\s*style=\{\{ color: "var\(--ink-soft\)" \}\}/ },
    { file: "app/letter/page.tsx", context: /className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"\s*style=\{\{ color: "var\(--ink-soft\)" \}\}/ },
    { file: "app/sample/page.tsx", context: /className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"\s*style=\{\{ color: "var\(--ink-soft\)" \}\}/ },
  ];
  for (const site of sites) {
    const src = readFileSync(new URL(`../${site.file}`, import.meta.url), "utf8");
    check(`(3) ${site.file} uses --ink-soft now`, site.context.test(src));
  }

  // Recompute the actual contrast ratio the same way the existing accent-ink
  // verify script does, confirming --ink-soft genuinely clears 4.5:1 against
  // --paper in EVERY theme -- this is the fact the fix depends on, not an
  // assumption.
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
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const blocks = css.split(/(?=\[data-theme=|^:root)/m);
  const failing: string[] = [];
  let themeCount = 0;
  for (const b of blocks) {
    const nameMatch = b.match(/\[data-theme="([^"]+)"\]|^:root/);
    if (!nameMatch) continue;
    const name = nameMatch[1] || "root";
    const paper = b.match(/--paper:\s*(#[0-9A-Fa-f]{6})/);
    const inkSoft = b.match(/--ink-soft:\s*(#[0-9A-Fa-f]{6})/);
    if (!paper || !inkSoft) continue;
    themeCount++;
    const c = contrastRatio(inkSoft[1], paper[1]);
    if (c < 4.5) failing.push(`${name}: ${c.toFixed(2)}:1`);
  }
  check("(3) parsed a real, non-trivial number of themes", themeCount >= 20);
  for (const f of failing) console.log(`    XX ${f}`);
  check("(3) --ink-soft on --paper clears 4.5:1 AA in EVERY theme -- the fact this fix depends on", failing.length === 0);
}

console.log("(4) privacy.tsx: DeepSeek no longer mislabeled as a free provider, training claim narrowed to Gemini specifically");
{
  const src = normalize(readFileSync(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"));
  check("(4a) no longer calls the backup set \"the free backup providers\" (false for DeepSeek)", !/The free\s*backup providers we fall back to/.test(src));
  check("(4b) narrows the no-training caveat to Google's free Gemini tier specifically", /Google&apos;s\s*free Gemini tier, one of our backups, doesn&apos;t carry that same\s*guarantee/.test(src));
  check("(4c) the detailed, already-accurate Gemini-specific explanation in Third-party processors is untouched", /Google&apos;s own terms for that free tier allow\s*them to use what we send to improve their products/.test(src));

  // Strip the leading "// " comment marker from each line before matching --
  // the sentence this checks wraps across a `//`-prefixed comment line break,
  // so a raw \s+ match fails on the literal "//" sitting between the words.
  const deepseekSrc = readFileSync(new URL("../lib/engine/deepseek-client.ts", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/ ?/, ""))
    .join(" ");
  check("(4d) sanity: DeepSeek really is documented as paid/funded, not free (confirms the mislabel this fixes was real)", /a real\s*funded balance/.test(deepseekSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R25 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R25 FINDINGS ASSERTIONS PASS");
