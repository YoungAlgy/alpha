// Verify round 22 finding (alpha-drift-r22-01, 2026-08-14): lib/sample-issue.ts
// -- the hand-authored content shown on the public /sample marketing page --
// shipped the literal banned AI-tell word "leverage" ("platforms,
// aggregation, leverage"). Every AI-GENERATED blurb runs through
// findLexicalTells (topic-blurb.ts's cost-tiering treats a slip as "not good
// enough," on par with an empty section), but this file is entirely
// hand-written and never passes through that runtime guard at all -- so the
// one word list this app is most careful to keep out of a reader's letter
// was sitting, undetected, in the exact page meant to show off what a real
// letter looks like. This script closes that gap for good: any future
// hand-edit to sample-issue.ts that reintroduces a banned word now fails a
// real check, not just a live page nobody re-reads carefully.
// Run: npx tsx scripts/verify-sample-issue-voice.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");

const src = readFileSync(new URL("../lib/sample-issue.ts", import.meta.url), "utf8");

console.log("(1) sanity: findLexicalTells itself still catches the exact word this fix removes");
check("(1) 'leverage' is still a real banned word", findLexicalTells("this uses leverage").includes("leverage"));

console.log("(2) the actual bug this closes: reproduce the OLD text and confirm it WOULD have failed");
{
  const oldText = "Ben Thompson's Stratechery is the reference for understanding why tech companies do what they do: platforms, aggregation, leverage. Dense, but it changes how you see the whole board.";
  const oldTells = findLexicalTells(oldText);
  check("(2) the pre-fix sentence contains a real banned-word hit ('leverage')", oldTells.includes("leverage"));
}

console.log("(3) the fix: the CURRENT file contains zero banned lexical tells anywhere in its hand-authored content");
{
  const tells = findLexicalTells(src);
  if (tells.length > 0) console.log(`    XX banned words found in sample-issue.ts: ${tells.join(", ")}`);
  check("(3) zero banned words anywhere in the current file", tells.length === 0);
}

console.log("(4) the new replacement sentence reads naturally and doesn't reintroduce the word under a different inflection");
{
  const newSentenceMatch = src.match(/Ben Thompson's Stratechery[^"]*/);
  check("(4) the replacement sentence was found in the file", !!newSentenceMatch);
  check(
    "(4) it no longer contains 'leverage' in any form",
    !!newSentenceMatch && findLexicalTells(newSentenceMatch[0]).length === 0
  );
  check(
    "(4) the meaning is preserved -- still names platforms + aggregation as Stratechery's core lens",
    !!newSentenceMatch && newSentenceMatch[0].includes("platforms, aggregation")
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SAMPLE-ISSUE-VOICE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SAMPLE-ISSUE-VOICE ASSERTIONS PASS");
