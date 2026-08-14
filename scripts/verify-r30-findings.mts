// Verify round 30 findings: self-audit-r30 found round 29's own TagChip
// WCAG fix only verified the 7 dark-theme overrides, never the :root LIGHT
// defaults that 18 of 25 themes actually inherit -- those were carried
// forward byte-for-byte identical to the pre-r29 hardcoded literals and
// still failed WCAG on up to 12 of 18 light themes. Also: Footer.tsx's
// year useState initializer re-ran a live Date() call on every render
// (including client hydration), producing a real hydration mismatch across
// any calendar-year boundary -- fixed via a genuine build-time literal
// (NEXT_PUBLIC_BUILD_YEAR, next.config.ts's `env` block) instead of a
// runtime computation. alpha-drift-r30-01/r30-02, both 2026-08-14.
// Run: npx tsx scripts/verify-r30-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function relLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function composite(bgRgb: [number, number, number], alpha: number, paperRgb: [number, number, number]): [number, number, number] {
  return [bgRgb[0] * alpha + paperRgb[0] * (1 - alpha), bgRgb[1] * alpha + paperRgb[1] * (1 - alpha), bgRgb[2] * alpha + paperRgb[2] * (1 - alpha)];
}

console.log("(1) app/globals.css: TagChip light-mode tokens now pass WCAG on all 18 light themes");
{
  const cssSrc = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  // alpha-drift-r30-06 (verify-script fix): bound the :root block by its OWN
  // closing "\n}" (found relative to where ":root {" itself starts), not by
  // indexOf("[data-theme") -- that string also appears inside this file's
  // own header COMMENT (line 9, prose describing the theming convention),
  // at a byte offset BEFORE the real :root block even begins. Slicing up to
  // that false match produced an near-empty string, so the negated regex
  // checks below would have passed trivially regardless of whether the old
  // ink values were actually gone -- caught before trusting it by directly
  // inspecting the computed start/end offsets.
  const earlyRootStart = cssSrc.indexOf("\n:root {");
  const earlyRootBlock = cssSrc.slice(earlyRootStart, cssSrc.indexOf("\n}", earlyRootStart));

  check("(1a) 'improved' ink was recalibrated away from the never-verified pre-r29 value", /--tag-improved-ink: #2B5F3A;/.test(cssSrc));
  check("(1b) 'fixed' ink was recalibrated away from the never-verified pre-r29 value", /--tag-fixed-ink: #725520;/.test(cssSrc));
  check("(1c) the old, still-failing 'improved' ink is gone from the :root block", !earlyRootBlock.includes("--tag-improved-ink: #2F6B40;"));
  check("(1d) the old, still-failing 'fixed' ink is gone from the :root block", !earlyRootBlock.includes("--tag-fixed-ink: #8A6324;"));
  // 'new'/'reliability'/'security' already passed on light themes (round 29
  // never needed to touch them) -- confirm they're genuinely UNCHANGED, not
  // silently altered as a side effect of this fix.
  check("(1e) 'new'/'reliability'/'security' inks are untouched (they already passed on light themes)", /--tag-new-ink: #5947A5;/.test(cssSrc) && /--tag-reliability-ink: #2F587C;/.test(cssSrc) && /--tag-security-ink: #8B3434;/.test(cssSrc));

  // Behavioral proof: extract the REAL :root bg/alpha/ink values and every
  // light theme's REAL --paper directly from the current file (not
  // hand-copied constants that could silently drift from the source), then
  // compute actual WCAG contrast for all 5 tags against all 18 light
  // themes -- exactly the sweep round 29's own verify script never ran.
  // Reuses earlyRootBlock (computed above) rather than re-deriving it.
  function extractRootTag(tag: string): { bgRgb: [number, number, number]; alpha: number; ink: string } {
    const bgMatch = earlyRootBlock.match(new RegExp(`--tag-${tag}-bg: rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\);`));
    const inkMatch = earlyRootBlock.match(new RegExp(`--tag-${tag}-ink: (#[0-9A-Fa-f]{6});`));
    if (!bgMatch || !inkMatch) throw new Error(`couldn't extract --tag-${tag}-* from :root`);
    return { bgRgb: [Number(bgMatch[1]), Number(bgMatch[2]), Number(bgMatch[3])], alpha: Number(bgMatch[4]), ink: inkMatch[1] };
  }
  const tags = ["new", "improved", "fixed", "reliability", "security"].map((t) => ({ name: t, ...extractRootTag(t) }));

  const LIGHT_THEMES = ["soft", "linen", "ink", "cottage", "arcade", "marina", "forest", "mono", "sunset", "beacon", "grown-nearby", "freejob", "freeresume", "job-terminal", "downs", "fishing", "mitchmark", "toggletown"];
  function extractPaper(theme: string): string {
    const idx = cssSrc.indexOf(`[data-theme="${theme}"] {`);
    if (idx === -1) throw new Error(`theme block not found: ${theme}`);
    const block = cssSrc.slice(idx, cssSrc.indexOf("\n}", idx));
    const m = block.match(/--paper:\s*(#[0-9A-Fa-f]{6})/);
    if (!m) throw new Error(`--paper not found in theme: ${theme}`);
    return m[1];
  }
  const lightPapers = LIGHT_THEMES.map((t) => ({ theme: t, paper: extractPaper(t) }));
  check("(1f) all 18 light theme blocks were found and have a real --paper (sanity check on the sweep itself)", lightPapers.length === 18 && lightPapers.every((p) => /^#[0-9A-Fa-f]{6}$/.test(p.paper)));

  for (const tag of tags) {
    let worst = Infinity;
    let worstTheme = "";
    for (const { theme, paper } of lightPapers) {
      const composited = composite(tag.bgRgb, tag.alpha, hexToRgb(paper));
      const ratio = contrastRatio(hexToRgb(tag.ink), composited);
      if (ratio < worst) {
        worst = ratio;
        worstTheme = theme;
      }
    }
    check(`(1g-${tag.name}) behavioral: ink ${tag.ink} passes WCAG AA (>=4.5:1) against every one of the 18 light themes' real --paper -- worst case ${worst.toFixed(2)}:1 on '${worstTheme}'`, worst >= 4.5);
  }

  // Sanity: prove the OLD (still-shipping-until-this-round) 'fixed' ink
  // genuinely DID fail on the real worst-case light theme, so this isn't a
  // check that would have passed regardless of the fix.
  const oldFixedInk = hexToRgb("#8A6324");
  const downsPaper = hexToRgb(lightPapers.find((p) => p.theme === "downs")!.paper);
  const oldFixedComposited = composite([212, 158, 60], 0.18, downsPaper);
  const oldFixedRatio = contrastRatio(oldFixedInk, oldFixedComposited);
  check(`(1h) sanity: the OLD 'fixed' ink genuinely failed WCAG on downs (confirms this was a real, shipping bug) -- actual ${oldFixedRatio.toFixed(2)}:1`, oldFixedRatio < 4.5);
}

console.log("(2) next.config.ts + components/Footer.tsx: build-time year is a genuine compile-time literal, not a runtime Date() call");
{
  const configSrc = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  check("(2a) next.config.ts defines NEXT_PUBLIC_BUILD_YEAR via the env config key", /env: \{\s*NEXT_PUBLIC_BUILD_YEAR: String\(new Date\(\)\.getFullYear\(\)\),\s*\}/.test(configSrc));

  const footerSrc = readFileSync(new URL("../components/Footer.tsx", import.meta.url), "utf8");
  check("(2b) Footer's useState initializer reads the build-time env var, not a bare Date() call", /useState\(\(\) => Number\(process\.env\.NEXT_PUBLIC_BUILD_YEAR\) \|\| new Date\(\)\.getFullYear\(\)\)/.test(footerSrc));
  check("(2c) the post-mount useEffect correction is untouched -- still calls a live Date() to self-correct after hydration", /useEffect\(\(\) => \{\s*setYear\(new Date\(\)\.getFullYear\(\)\);\s*\}, \[\]\);/.test(footerSrc));

  // Behavioral proof against the ACTUAL production build output: confirm
  // the bundler genuinely inlined a literal year (not a stale runtime
  // process.env reference, which wouldn't exist in a browser bundle at
  // all and would render as literal "undefined"/NaN). Requires a fresh
  // `npm run build` to have run before this script -- checked defensively.
  let builtServerHtmlHasLiteralYear = false;
  let inlinedInClientBundle = false;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const serverAppDir = new URL("../.next/server/app", import.meta.url);
    const sampleHtmlPath = path.default.join(new URL(serverAppDir).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "sample.html");
    if (fs.existsSync(sampleHtmlPath)) {
      const html = fs.readFileSync(sampleHtmlPath, "utf8");
      // The literal build year (as a real 4-digit number, not the string
      // "NaN" or "undefined") must appear in the prerendered static HTML.
      const currentYear = new Date().getFullYear();
      builtServerHtmlHasLiteralYear = html.includes(String(currentYear)) && !html.includes("NaN") && !html.includes("process.env.NEXT_PUBLIC_BUILD_YEAR");
    }
    const staticChunksDir = path.default.join(new URL(new URL("../.next/static/chunks", import.meta.url)).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    if (fs.existsSync(staticChunksDir)) {
      const files = fs.readdirSync(staticChunksDir).filter((f: string) => f.endsWith(".js"));
      for (const f of files) {
        const content = fs.readFileSync(path.default.join(staticChunksDir, f), "utf8");
        if (content.includes("Footer") && content.includes("getFullYear")) {
          // A genuinely inlined literal looks like `Number("2026")`, not a
          // reference to `process.env.NEXT_PUBLIC_BUILD_YEAR` (which is
          // undefined in a browser and would ship as `Number(undefined)`).
          if (/Number\("?\d{4}"?\)\s*\|\|\s*new Date\(\)\.getFullYear\(\)/.test(content)) {
            inlinedInClientBundle = true;
            break;
          }
        }
      }
    }
  } catch (e) {
    console.warn("  (build-artifact check skipped -- run `npm run build` first for the full behavioral proof):", e instanceof Error ? e.message : e);
  }
  check("(2d) behavioral: the actual built static HTML (.next/server/app/sample.html) contains the real current year as a literal, not NaN/undefined", builtServerHtmlHasLiteralYear);
  check("(2e) behavioral: the actual client JS bundle has the year genuinely inlined as a numeric literal (Turbopack/webpack compile-time substitution), not a live process.env reference that would be undefined in a browser", inlinedInClientBundle);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R30 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R30 FINDINGS ASSERTIONS PASS");
