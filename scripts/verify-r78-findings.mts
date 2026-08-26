// Verify round 78 findings: 2 raised, 2 confirmed, 0 refuted -- the first
// round since 74 with zero refutations.
// - app/globals.css (accessibility-resweep-newer-code-r26, filed MEDIUM,
//   shipped at LOW per unanimous severity correction, 3/3 CONFIRM):
//   .alpha-hero (the landing page + /welcome headline "breathe" animation)
//   was the last infinite, auto-starting animation in the app with no
//   prefers-reduced-motion guard -- every other animation (the intro veil,
//   ScrollFadeIn, FirstLetterCelebration, app/writing/page.tsx's own
//   dedicated block) already checks it, and round 63 fixed this exact
//   class on 2 sibling elements. .alpha-hero sits on the app's two most-
//   reachable public pages (landing + /welcome), predates round 63's
//   sweep by 3 months, and was simply missed. Fixed with animation:none
//   inside the existing reduced-motion block -- no !important needed
//   since the base rule is a plain stylesheet class, not inline-styled.
// - scripts/gen-og-image.mjs (duplicate-code-audit-r27, MEDIUM, 3/3
//   CONFIRM): the live social-share card (Open Graph / Twitter image,
//   confirmed byte-identical to what's actually deployed) still baked in
//   "YOUNGALGY.COM/ALPHA", the pre-2026-07-03-domain-move parent-site
//   address -- the asset was never regenerated after the move. Directly
//   contradicts the metadata's own correct alpha.everyday.report URL
//   sitting in the same card. Fixed by dropping the domain segment
//   entirely (a same-domain swap would overrun the card's right margin at
//   this font size/letter-spacing, per all 3 votes' measurements) rather
//   than replacing it, matching lib/email.ts's own no-domain footer
//   convention. Regenerated public/og-image.png via the fixed script (one
//   vote independently ran the regeneration into a scratchpad first and
//   confirmed it's fully deterministic/byte-reproducible before this was
//   shipped for real).
// alpha-drift-r78-01, r78-02, both 2026-08-21.
// Run: npx tsx scripts/verify-r78-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/globals.css: .alpha-hero's infinite breathe animation is now disabled under prefers-reduced-motion, alongside the intro veil + scroll-fade rules");
{
  const src = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  check("(1a) .alpha-hero's animation is disabled inside the existing reduced-motion block", /\.alpha-scroll-fade \{ transition: none !important; \}[\s\S]{0,700}\.alpha-hero \{ animation: none; \}\s*\n\}/.test(src));
  check("(1b) the base .alpha-hero rule (still animated for everyone else) is untouched", /\.alpha-hero \{\s*\n\s*animation: alpha-wordmark-breathe 4800ms ease-in-out infinite;\s*\n\s*transform-origin: center;\s*\n\}/.test(src));
}

console.log("(2) scripts/gen-og-image.mjs + public/og-image.png: the social-share card no longer displays the stale pre-domain-move address");
{
  const src = readFileSync(new URL("../scripts/gen-og-image.mjs", import.meta.url), "utf8");
  check("(2a) the SVG footer text no longer bakes in the stale domain (the comment's own prose mentions the string, so match the rendered-text shape, not a bare substring)", !/>A PERSONAL LETTER[\s\S]{0,30}YOUNGALGY/.test(src));
  check("(2b) the footer text still reads A PERSONAL LETTER, just without the domain", />A PERSONAL LETTER<\/text>/.test(src));
  check("(2c) the header comment now cites the real current domain", /the image\s*\n\/\/ shown when alpha\.everyday\.report is shared/.test(src));

  const pngStat = readFileSync(new URL("../public/og-image.png", import.meta.url));
  check("(2d) public/og-image.png was actually regenerated (non-trivial PNG, not a stale/empty file)", pngStat.length > 1000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R78 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R78 FINDINGS ASSERTIONS PASS");
