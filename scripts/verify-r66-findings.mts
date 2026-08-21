// Verify round 66 findings: 6 raised, 4 confirmed, 2 refuted (a HIGH claim
// about app/api/generate/route.ts and a MEDIUM claim about lib/user-sync.ts,
// both respected). A quiet round after 5 straight larger ones -- consistent
// with this marathon's established pattern (the backlog is genuinely
// shrinking, not the audit going soft).
// - app/settings/accounts/page.tsx (accessibility-resweep-newer-code-r14,
//   MEDIUM, 2-1 split): the admin "Load more" pagination control appended
//   rows with zero announcement -- the page's own sr-only role=status
//   region exists but was only ever fed by act()'s result. Both dissents
//   (one REFUTE-turned-caveat, one CONFIRM's own caveat) independently
//   caught that the naive fix (a fixed per-page count) would silently
//   no-op on every full 200-row page, since React bails out on an
//   identical string -- implemented with a running total instead, which
//   varies on every append.
// - app/archive/page.tsx (accessibility-resweep-newer-code-r14, MEDIUM):
//   the sibling subscriber-facing "Load more" had NO live region at all
//   anywhere in the file. New sr-only role=status region, mounted
//   UNCONDITIONALLY (not nested inside the state==="ready" gate, so the
//   exhaustion message doesn't mount and unmount in the same commit),
//   announcing both the running total and "that's all of them" when the
//   list is exhausted.
// - scripts/verify-cost-tiering.mts + lib/engine/client.ts (duplicate-
//   code-audit-r16, LOW): both files' comments described a stale 3-tier
//   cost-escalation chain (Gemini -> Haiku -> Sonnet) that predates Groq
//   and DeepSeek joining 2026-07-29 -- the verify script's own test
//   assertions were updated that day, but its header docstring wasn't,
//   for 4 weeks. Fixed the whole header block (not just the top two
//   lines, which the raw finding under-scoped) plus the identical stale
//   parenthetical in lib/engine/client.ts.
// - app/api/stripe/webhook/route.ts (silent-catch-audit-r12, MEDIUM):
//   checkout.session.completed's "existing row" lookup was the sole
//   discarded-error Supabase call left in this handler (every sibling
//   already checks). A transient read failure on an already-subscribed
//   user routed into a doomed INSERT with a misleading duplicate-key
//   error instead of the real cause. Deliberately NOT a blanket early
//   throw (which would break the currently-working "row genuinely
//   absent, direct-checkout" case) -- logged, and folded into the
//   existing insert-failure throw's message so the ops alert carries the
//   honest root cause when it does cascade.
// alpha-drift-r66-01 through r66-04, all 2026-08-21.
// Run: npx tsx scripts/verify-r66-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) app/settings/accounts/page.tsx: Load More now announces a running total, not a fixed per-page count that would repeat verbatim");
{
  const src = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
  check("(1a) the append path computes a running total", /const newTotal = \(users\?\.length \?\? 0\) \+ data\.users\.length;/.test(src));
  // alpha-drift-r67-03 (2026-08-21): superseded by a zero-row branch and an
  // exhaustion suffix (see verify-r67-findings.mts) -- the exact single-
  // line template this used to pin no longer exists. Reasserted here as
  // the semantic invariant this check actually cares about: the append
  // path still announces only on append, and the running total still
  // appears in that announcement.
  check("(1b) setActionMsg fires only on the append path, with the running total in the text", /if \(opts\?\.append\) \{[\s\S]{0,400}setActionMsg\(\s*\n[\s\S]{0,400}\$\{newTotal\} shown\.[\s\S]{0,200}\n\s*\);\s*\n\s*\}/.test(src));
}

console.log("(2) app/archive/page.tsx: a new sr-only live region announces Load More results, mounted unconditionally");
{
  const src = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
  check("(2a) loadMoreMsg state exists", /const \[loadMoreMsg, setLoadMoreMsg\] = useState<string \| null>\(null\);/.test(src));
  check("(2b) loadMore() sets a message that varies with the running total, and flags exhaustion", /const newTotal = items\.length \+ rows\.length;/.test(src) && /setLoadMoreMsg\(/.test(src) && /That's all of them\./.test(src));
  check("(2c) the live region is mounted unconditionally (not inside a state-gated block)", /<p role="status" aria-live="polite" className="sr-only">\s*\n\s*\{loadMoreMsg\}\s*\n\s*<\/p>\s*\n\s*\n\s*\{state === "loading"/.test(src));
}

console.log("(3) scripts/verify-cost-tiering.mts + lib/engine/client.ts: the header comments now describe the real 5-tier chain, not the stale 3-tier one");
{
  const verify = readFileSync(new URL("./verify-cost-tiering.mts", import.meta.url), "utf8");
  check("(3a) verify-cost-tiering.mts's header no longer claims the 3-tier chain", !/Gemini \(free\) -> Haiku \(cheap\) -> Sonnet \(last resort\), each escalation/.test(verify));
  check("(3b) it now documents all 5 tiers", /Gemini \(free\)\s*\n\/\/ -> Groq \(free\) -> DeepSeek \(paid, uncapped\) -> Haiku \(cheap\) -> Sonnet/.test(verify));
  check("(3c) test 3's stale 'escalation reaches Haiku' claim is gone", !/escalation reaches Haiku/.test(verify));

  const client = readFileSync(new URL("../lib/engine/client.ts", import.meta.url), "utf8");
  check("(3d) client.ts's parenthetical no longer claims the 3-tier chain", !/\(Gemini\s*\n\/\/ free -> Haiku cheap -> Sonnet last resort\)/.test(client));
  check("(3e) client.ts now documents Groq + DeepSeek in the chain", /Groq free -> DeepSeek paid-uncapped -> Haiku cheap/.test(client));
}

console.log("(4) app/api/stripe/webhook/route.ts: the existing-row lookup's error is now logged and folded into the insert-failure message");
{
  const src = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  check("(4a) the existing-row read now destructures error", /const \{ data: existing, error: existingErr \} = await sb/.test(src));
  check("(4b) a truthy existingErr is logged", /if \(existingErr\) \{\s*\n\s*console\.warn\("\[stripe-webhook\] existing-row lookup failed/.test(src));
  check("(4c) the insert-failure throw folds in existingErr when present, without gating the insert attempt itself", /throw new Error\(\s*\n\s*existingErr\s*\n\s*\? `user insert failed \(the earlier existing-row lookup had also failed: \$\{existingErr\.message\}\): \$\{insErr\.message\}`/.test(src));
  check("(4d) no blanket early throw was added on existingErr alone (the direct-checkout insert-succeeds path stays intact)", !/if \(existingErr\) throw/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R66 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R66 FINDINGS ASSERTIONS PASS");
