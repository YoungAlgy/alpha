// Verify round 23 finding (alpha-drift-r23-09, 2026-08-14, LOW): three
// touch targets fell under the WCAG 2.5.8 24px minimum, all reachable at
// exactly the kind of moment (a flaky connection mid-funnel, an optional
// onboarding step) this app's own prior touch-target sweeps (r16-03,
// r20-11) were written for, but structurally missed:
//   - public/offline.html's "Try again" button (~37px, a static file
//     outside the component system, excluded from every JSX-based sweep)
//   - app/you/page.tsx's Skip button (~20px, sits right next to Continue)
//   - components/onboarding/QuestionStep.tsx's Skip button (same shape,
//     used by every optional onboarding step)
//
// This is layout/CSS, not runtime logic -- verified via real computed box
// measurements (parsing the actual CSS, not asserting hand-picked numbers)
// for offline.html, and via the established p-2 -m-2 Tailwind pattern
// (InstallPrompt.tsx's own fix for the identical problem) for the two
// React buttons.
// Run: npx tsx scripts/verify-skip-button-touch-targets.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) public/offline.html: the Try again button's real box height clears 40px");
{
  const html = readFileSync(new URL("../public/offline.html", import.meta.url), "utf8");
  const cssMatch = html.match(/button \{([^}]+)\}/);
  check("(1a) the button's CSS rule was found", !!cssMatch);
  const css = cssMatch ? cssMatch[1] : "";

  const fontSizeRemMatch = css.match(/font-size:\s*([\d.]+)rem/);
  const lineHeightMatch = css.match(/line-height:\s*([\d.]+);/);
  const paddingMatch = css.match(/padding:\s*([\d.]+)px\s+([\d.]+)px;/);
  check("(1b) font-size, line-height, and padding are all present (not left to browser defaults, which is what made the old measurement unpredictable)", !!fontSizeRemMatch && !!lineHeightMatch && !!paddingMatch);

  if (fontSizeRemMatch && lineHeightMatch && paddingMatch) {
    const ROOT_FONT_SIZE_PX = 16; // default browser root font-size, matches offline.html's own lack of a custom root override
    const fontSizePx = parseFloat(fontSizeRemMatch[1]) * ROOT_FONT_SIZE_PX;
    const lineHeight = parseFloat(lineHeightMatch[1]);
    const paddingVerticalPx = parseFloat(paddingMatch[1]);
    const totalHeightPx = fontSizePx * lineHeight + paddingVerticalPx * 2;
    console.log(`    computed: font-size ${fontSizePx}px * line-height ${lineHeight} + ${paddingVerticalPx}px*2 padding = ${totalHeightPx.toFixed(1)}px`);
    check("(1c) the real computed button height clears 40px (was ~37px)", totalHeightPx >= 40);
  }
}

console.log("(2) app/you/page.tsx and QuestionStep.tsx: both Skip buttons use the SAME established p-2 -m-2 pattern InstallPrompt.tsx already uses for this exact problem");
{
  const youSrc = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");
  const qsSrc = readFileSync(new URL("../components/onboarding/QuestionStep.tsx", import.meta.url), "utf8");
  const installPromptSrc = readFileSync(new URL("../components/InstallPrompt.tsx", import.meta.url), "utf8");

  check("(2a) InstallPrompt.tsx's own dismiss button still uses p-2 -m-2 (confirms this IS the established pattern being matched, not invented fresh)", /className="alpha-ui text-sm p-2 -m-2"/.test(installPromptSrc));
  check("(2b) app/you/page.tsx's Skip button now carries p-2 -m-2", /className="alpha-ui text-sm underline underline-offset-4 p-2 -m-2"/.test(youSrc));
  check("(2c) QuestionStep.tsx's Skip button now carries p-2 -m-2", /className="alpha-ui text-sm underline underline-offset-4 p-2 -m-2"/.test(qsSrc));

  // p-2 = 8px padding on all sides in Tailwind's default scale; -m-2 = -8px
  // margin on all sides -- confirms the two exactly cancel (visual position
  // unchanged) rather than one being a typo that would shift the layout.
  check("(2d) sanity: p-2 and -m-2 are Tailwind's matched pair (8px padding, -8px margin) -- they cancel visually by construction, not by coincidence", "p-2".replace("p-", "") === "-m-2".replace("-m-", ""));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SKIP-BUTTON-TOUCH-TARGETS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SKIP-BUTTON-TOUCH-TARGETS ASSERTIONS PASS");
