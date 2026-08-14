// Verify round 24 finding (alpha-drift-r24-02, 2026-08-14, HIGH): ThemeSwitcher's
// own doc comment (components/ThemeSwitcher.tsx:9-22) says the default
// align="right" dropdown is only safe when ThemeSwitcher is "the last item
// in a right-aligned justify-between header" -- true on /inbox/[issueId]
// (no Settings button in that header), but a Settings gear button used to
// sit AFTER ThemeSwitcher on /inbox specifically, so the w-64 (256px)
// dropdown anchored ~50px short of the true right edge and overflowed off
// the left side of the viewport on narrow phones (iPhone SE/mini, ~320-
// 375px). Fixed by reordering /inbox's header icons so ThemeSwitcher is
// genuinely last, matching the precondition its own default already
// assumes -- not by adding new positioning logic to a component every
// theme-switcher call site in the app shares.
// Run: npx tsx scripts/verify-themeswitcher-inbox-overflow.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/inbox/page.tsx: ThemeSwitcher is now the LAST icon in its header row, matching its own align=right precondition");
{
  const src = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");
  const rowMatch = src.match(/<div className="flex items-center gap-2">([\s\S]*?)<\/div>/);
  check("(1a) the icon-group row was found", !!rowMatch);
  const row = rowMatch ? rowMatch[1] : "";
  const audioIdx = row.indexOf("<AudioToggle");
  const settingsIdx = row.indexOf('aria-label="Settings"');
  const themeSwitcherIdx = row.lastIndexOf("<ThemeSwitcher");
  check("(1b) all three elements (AudioToggle, Settings button, ThemeSwitcher) are present in the row", audioIdx > -1 && settingsIdx > -1 && themeSwitcherIdx > -1);
  check("(1c) ThemeSwitcher now renders AFTER the Settings button (was before it)", themeSwitcherIdx > settingsIdx);
  check("(1d) AudioToggle is still first (unchanged)", audioIdx < settingsIdx && audioIdx < themeSwitcherIdx);
  check("(1e) ThemeSwitcher is not passed an explicit align prop here -- relies on the default align=\"right\", which this fix makes actually correct for this row", !/<ThemeSwitcher\s+align=/.test(row));
}

console.log("(2) sanity: the other 2 ThemeSwitcher call sites already satisfy their own align precondition (unchanged by this fix, confirming this was the only broken site)");
{
  const issueIdSrc = readFileSync(new URL("../app/inbox/[issueId]/page.tsx", import.meta.url), "utf8");
  check("(2a) /inbox/[issueId]: ThemeSwitcher is still the last element in its row (no Settings button there)", (() => {
    const rowMatch = issueIdSrc.match(/<div className="flex items-center gap-2">([\s\S]*?)<\/div>/);
    if (!rowMatch) return false;
    const row = rowMatch[1];
    return row.trimEnd().endsWith("<ThemeSwitcher />");
  })());

  const settingsSrc = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(2b) /settings: ThemeSwitcher explicitly uses align=\"left\" (first item, left-aligned row)", /<ThemeSwitcher align="left" \/>/.test(settingsSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("THEMESWITCHER-INBOX-OVERFLOW VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL THEMESWITCHER-INBOX-OVERFLOW ASSERTIONS PASS");
