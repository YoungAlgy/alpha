// Verify round 22 finding (alpha-drift-r22-05, 2026-08-14, MEDIUM):
// components/onboarding/QuestionStep.tsx's Skip button used to force-write
// `undefined` for its field unconditionally. That's correct the first time
// through a fresh step (the input starts empty), but wrong on a revisit: a
// reader who already answered an optional question (funBlurb via /fun,
// projectBlurb via /focus -- the only two fields that currently render a
// Skip button), then hit Back to look at it again, lands with the field
// PRE-FILLED from saved state (the `useEffect` that syncs `value` from
// `state[field]`). Clicking Skip on that revisit -- even without touching
// the input -- silently erased the already-saved answer. Fixed by having
// skip() write whatever's CURRENTLY in the box (the same `trimmed ||
// undefined` expression submit() already uses), so an untouched revisit
// preserves the saved value and a genuinely empty field still clears to
// undefined exactly as before.
//
// This is a client-side React component with no server-callable logic to
// drive directly (its behavior lives entirely in closures over useState),
// so -- following this session's established fallback for that case --
// this verifies the actual source text rather than fabricating a DOM
// harness for one state-update call.
// Run: npx tsx scripts/verify-question-step-skip.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const src = readFileSync(new URL("../components/onboarding/QuestionStep.tsx", import.meta.url), "utf8");
const skipFnMatch = src.match(/function skip\(\)[\s\S]*?\n  \}/);
const skipFn = skipFnMatch ? skipFnMatch[0] : "";

console.log("(1) sanity: skip() was actually found and isolated from the rest of the file");
check("(1) skip() function body located", skipFn.length > 0);

console.log("(2) the old unconditional-erase bug is gone");
check(
  "(2) skip() no longer force-writes `[field]: undefined` unconditionally",
  !/update\(\{ \[field\]: undefined \}/.test(skipFn)
);

console.log("(3) the fix: skip() now writes the SAME expression submit() uses for a real save");
{
  const submitFnMatch = src.match(/function submit\([\s\S]*?\n  \}/);
  const submitFn = submitFnMatch ? submitFnMatch[0] : "";
  check("(3) submit() was located too, for comparison", submitFn.length > 0);
  check("(3) submit() saves `trimmed || undefined` (the existing, correct behavior)", /update\(\{ \[field\]: trimmed \|\| undefined \}/.test(submitFn));
  check("(3) skip() now saves the IDENTICAL `trimmed || undefined` expression, not a hand-duplicated variant that could drift", /update\(\{ \[field\]: trimmed \|\| undefined \}/.test(skipFn));
}

console.log("(4) behavior-preservation: a genuinely fresh/empty step still clears to undefined exactly as before (no regression for the common case)");
{
  // `trimmed` is `value.trim()`, and `value` is seeded from `initial = (state[field] as string) || ""`
  // on a fresh step with no saved value -- so on first-visit, trimmed === ""
  // and `trimmed || undefined` evaluates to `undefined`, byte-identical to
  // the old hardcoded literal for that specific case. Confirmed by reading
  // both expressions off the same source rather than asserting a runtime
  // value in isolation (there's no seam to call skip() without a real DOM).
  const trimmedDeclared = /const trimmed = value\.trim\(\);/.test(src);
  const initialFromState = /const initial = \(state\[field\] as string\) \|\| "";/.test(src);
  check("(4) `trimmed` is still derived the same way it always was", trimmedDeclared);
  check("(4) a fresh step's `value` still seeds from saved state, defaulting to empty string", initialFromState);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("QUESTION-STEP-SKIP VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL QUESTION-STEP-SKIP ASSERTIONS PASS");
