// Verify round 20 tasks #139/#140/#141 (alpha-drift-r20-09/10/11, 2026-08-13):
// three small mobile UI gaps found live on /topics and /you.
//   #139: the sticky bottom Continue/Save bar had no background at all --
//         scrolling pill cards visually overlapped it for nearly the whole
//         scroll on a 375px viewport.
//   #140: the custom-topic "Add" submit button measured ~27x20px live, under
//         the WCAG 2.5.8 AA 24x24 minimum.
//   #141: gender toggle buttons (/you) and sub-genre pills (/topics) were
//         consistently ~38px tall, 2px under the commonly-cited 40px mobile
//         touch-target guideline (still passed the stricter 24px WCAG floor).
// These are pure CSS/class changes with no behavioral logic to unit-test --
// a source-level check that the exact classes landed is the proportionate
// coverage here, not a browser/DOM harness this repo doesn't have.
// Run: npx tsx scripts/verify-topics-touch-targets.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const topicsSrc = readFileSync(new URL("../app/topics/page.tsx", import.meta.url), "utf8");
const youSrc = readFileSync(new URL("../app/you/page.tsx", import.meta.url), "utf8");

console.log("(1) #139: sticky bottom bar has a real background (alpha-card, same treatment InstallPrompt.tsx uses)");
{
  check("(1) the sticky bottom-4 bar now carries alpha-card", /alpha-card sticky bottom-4/.test(topicsSrc));
  check("(1) padding widened from pt-4-only to a full p-4 (card needs edge breathing room on all sides)", /alpha-card sticky bottom-4 flex items-center justify-between gap-4 p-4"/.test(topicsSrc));
}

console.log("(2) #140: custom-topic Add button's tap target grown without moving its visual position");
{
  const addButtonBlock = topicsSrc.slice(topicsSrc.indexOf('type="submit"'), topicsSrc.indexOf('type="submit"') + 700);
  check("(2) p-2 -m-2 applied (same pattern this file already uses on the pill-remove button)", /className="alpha-ui text-sm underline underline-offset-4 p-2 -m-2"/.test(addButtonBlock));
}

console.log("(3) #141: gender toggles (/you) and sub-genre pills (/topics) bumped from py-2 to py-2.5");
{
  const genderPyTwoCount = (youSrc.match(/px-4 py-2 rounded-full/g) ?? []).length;
  const genderPyTwoFiveCount = (youSrc.match(/px-4 py-2\.5 rounded-full/g) ?? []).length;
  // 2 SOURCE occurrences, not 3: Male/Female share one JSX template inside
  // GENDERS.map() (rendered twice at runtime, written once in source);
  // "Prefer not to say" is the second, separate literal occurrence.
  check("(3) both source occurrences (the shared male/female template + prefer-not-to-say) now use py-2.5", genderPyTwoFiveCount === 2);
  check("(3) none were left behind on the old py-2", genderPyTwoCount === 0);

  const chipPyTwoCount = (topicsSrc.match(/px-3 py-2 rounded-full/g) ?? []).length;
  const chipPyTwoFiveCount = (topicsSrc.match(/px-3 py-2\.5 rounded-full/g) ?? []).length;
  check("(3) the sub-genre chip button now uses py-2.5", chipPyTwoFiveCount === 1);
  check("(3) not left behind on the old py-2", chipPyTwoCount === 0);
  // The OTHER rounded-full in topics/page.tsx (the custom-topic chip's
  // outer <span>, py-1.5) is a static wrapper, not an interactive touch
  // target -- its own Remove button already gets p-2/-m-2 padding (verified
  // in (2)'s pattern above) -- so it's deliberately NOT touched here.
  check("(3) the custom-topic chip span (a non-interactive wrapper) was correctly left alone", /px-3 py-1\.5 rounded-full/.test(topicsSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("TOPICS-TOUCH-TARGETS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL TOPICS-TOUCH-TARGETS ASSERTIONS PASS");
