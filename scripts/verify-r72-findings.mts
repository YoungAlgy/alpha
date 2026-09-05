// Verify round 72 findings: 3 raised, 1 confirmed, 2 refuted -- a genuinely
// quiet round (self-audit, silent-catch-audit, and form-validation-
// consistency-audit-r18 all came back fully empty), consistent with the
// backlog continuing to shrink rather than the audit going soft.
// - docs/BRAND_KIT.md (duplicate-code-audit-r21, LOW, 3/3 CONFIRM): section
//   9 said "Ten skins" and hand-listed only the original 10, but
//   lib/themes.ts's THEMES array has shipped 25 real, reader-selectable
//   themes since 2026-06-24 -- the doc was never updated across the 60+
//   rounds since. Fixed by pointing at lib/themes.ts as the single source
//   of truth instead of re-hardcoding a count/list that can drift again.
// - app/topics/page.tsx's custom-topic Add button/input self-disabling on
//   its own successful click (accessibility-resweep-newer-code-r20, MEDIUM,
//   1 CONFIRM/2 REFUTE): real mechanism, but the file has OTHER self-
//   disabling controls never flagged (the primary Save/Continue button,
//   topic-card/chip buttons), the dominant real path (Enter-to-submit,
//   mobile tap) never triggers it, and the finding's own proposed fix was
//   unsound on both halves (aria-disabled doesn't stop typing on the input;
//   the suggested leading guard would silently shadow the only two
//   user-facing error messages addCustom() has). Correctly left alone.
// - app/settings/accounts/page.tsx's "26 vs 25 themes" claim (duplicate-
//   code-audit-r21, LOW, 3/3 REFUTE): NOT a miscount -- 25 counts
//   lib/themes.ts's THEMES array, 26 counts app/globals.css's palette
//   blocks (25 [data-theme=...] rules PLUS a separately-declared :root
//   block, byte-identical to forest, that the app's own contrast-audit
//   tooling treats as its own checked context). Both numbers are correct
//   in their own frame; the proposed fix would have replaced a verified-
//   correct figure with a wrong one.
// alpha-drift-r72-01, 2026-08-21.
// Run: npx tsx scripts/verify-r72-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

console.log("(1) docs/BRAND_KIT.md: the theme-system section no longer undercounts the catalog at 10, and points at the real source of truth");
{
  const src = readFileSync(new URL("../docs/BRAND_KIT.md", import.meta.url), "utf8");
  check("(1a) the stale \"Ten skins\" / hardcoded 10-item list is gone", !/Ten skins\s*\nin `lib\/themes\.ts` \(soft, linen, ink, cottage, arcade, marina, midnight, forest, mono,\s*\nsunset\)/.test(src));
  check("(1b) it now cites the real count and points at lib/themes.ts as the authoritative list", /25 skins\s*\nlive in the `THEMES` array in `lib\/themes\.ts`/.test(src));
  check("(1c) the drift rationale (a hardcoded list goes stale) is stated so this can't silently regress again", /a hardcoded list silently goes stale the next time a theme is added or removed/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R72 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R72 FINDINGS ASSERTIONS PASS");
