// Verify the fix (alpha-drift-r19-01, 2026-08-07) for a real corruption
// bug: every length cap on user-supplied text (profile route's cleanRequired
// /cleanOptional, editor-note.ts's clamp) used plain String.prototype.slice,
// which cuts by UTF-16 code UNIT, not Unicode code point. A cut point
// landing mid-surrogate-pair (any emoji outside the BMP -- most modern
// emoji) leaves an unpaired surrogate: invalid UTF-16 that throws on
// encodeURIComponent() and has no valid UTF-8 encoding, so the save either
// silently corrupts the character or fails outright for input that looked
// well under the visible limit.
// Run: npx tsx scripts/verify-text-truncate.mts
const { codePointSafeSlice, codePointSafeTruncate } = await import("../lib/text-truncate.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) plain ASCII: behaves exactly like .slice() for a simple case");
check("(1) 'hello world'.slice equivalent at 5", codePointSafeSlice("hello world", 5) === "hello");

console.log("(2) the actual bug: a cut point that would land mid-surrogate-pair with plain .slice()");
{
  // 58 'a's + one astral emoji (😀, U+1F600 -- encoded as a surrogate PAIR,
  // 2 UTF-16 units) = 60 UTF-16 units total, but only 59 CODE POINTS.
  const s = "a".repeat(58) + "😀";
  const brokenBySlice = s.slice(0, 59); // the OLD behavior -- cuts mid-pair
  check("(2) confirms the bug this fix closes: plain .slice(59) DOES produce an unpaired surrogate", /[\uD800-\uDBFF]$/.test(brokenBySlice) && !/[\uDC00-\uDFFF]$/.test(brokenBySlice));

  const safe = codePointSafeSlice(s, 59);
  check("(2) codePointSafeSlice(59) keeps the WHOLE emoji intact instead of splitting it", safe === s);
  check("(2) result is valid UTF-16 -- round-trips through encodeURIComponent without throwing", (() => {
    try {
      encodeURIComponent(safe);
      return true;
    } catch {
      return false;
    }
  })());
}

console.log("(3) a cap that lands BEFORE the emoji entirely (no pair to split) drops it cleanly");
{
  const s = "a".repeat(58) + "😀";
  const safe = codePointSafeSlice(s, 58);
  check("(3) exactly the 58 'a's, emoji fully excluded, no partial surrogate left behind", safe === "a".repeat(58));
}

console.log("(4) a cap that lands AFTER the emoji entirely includes it whole");
{
  const s = "a".repeat(58) + "😀" + "b".repeat(10);
  const safe = codePointSafeSlice(s, 59);
  check("(4) 58 a's + the whole emoji, nothing from the trailing b's", safe === "a".repeat(58) + "😀");
}

console.log("(5) multiple astral characters in a row -- each one counted as ONE code point, not two");
{
  const s = "😀😀😀😀😀"; // 5 emoji, 10 UTF-16 units, 5 code points
  check("(5) capping at 3 code points keeps exactly 3 whole emoji", codePointSafeSlice(s, 3) === "😀😀😀");
  check("(5) never produces an odd/partial surrogate count", codePointSafeSlice(s, 3).length % 2 === 0);
}

console.log("(6) a string already shorter than the cap is returned unchanged");
check("(6) short string untouched", codePointSafeSlice("hi", 100) === "hi");

console.log("(7) cap of 0 returns empty string, no crash");
check("(7) cap=0 -> ''", codePointSafeSlice("anything", 0) === "");

console.log("(8) codePointSafeTruncate — alpha-drift-r20-08 (2026-08-13): the truncated-flag bug one layer up");
{
  // A string whose UTF-16 .length OVERCOUNTS its real code-point count: 300
  // 'a's + 20 astral emoji = 320 code points, but 340 UTF-16 units (each
  // emoji is 2 units). The naive `str.length > 320` check email.ts used to
  // run would read this as truncated (340 > 320) even though nothing needs
  // cutting at a 320-code-point cap.
  const s = "a".repeat(300) + "😀".repeat(20);
  check("(8) sanity: this fixture's OLD naive check (.length > 320) WOULD have wrongly fired", s.length > 320);
  check("(8) sanity: its real code-point count is exactly 320, not > 320", Array.from(s).length === 320);

  const { text, truncated } = codePointSafeTruncate(s, 320);
  check("(8) codePointSafeTruncate correctly reports NOT truncated", truncated === false);
  check("(8) and returns the string completely unchanged (no spurious cut)", text === s);

  const shortCase = codePointSafeTruncate("hello", 320);
  check("(8) an ordinary short string: not truncated, unchanged", shortCase.truncated === false && shortCase.text === "hello");

  const cutCase = codePointSafeTruncate("a".repeat(58) + "😀" + "b".repeat(10), 59);
  check("(8) a genuine cut: truncated=true", cutCase.truncated === true);
  check("(8) a genuine cut: text matches codePointSafeSlice's own result exactly", cutCase.text === codePointSafeSlice("a".repeat(58) + "😀" + "b".repeat(10), 59));

  const exactCase = codePointSafeTruncate("hello", 5);
  check("(8) exactly at the cap: NOT truncated (boundary is inclusive)", exactCase.truncated === false && exactCase.text === "hello");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("TEXT-TRUNCATE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL TEXT-TRUNCATE ASSERTIONS PASS");
