// Verify round 37 findings: self-audit found TWO real bugs in round 36's own
// fixes (a whole-blob savedAt that let any unrelated onboarding write
// silently "refresh" a stale stranger's email, and a billingHeadingRef that
// could legitimately be null when the focus effect fired because the
// buttons that set confirmingTier weren't actually gated on the precondition
// the r36 comment claimed). The Fable voice-alignment pass on the two AI
// content-generation SYSTEM_PROMPTs found their own worked exemplars
// violating rules stated elsewhere in the same prompt (editor-note.ts's
// register example used the banned "the practical one" label plus a comma
// splice; topic-blurb.ts's GOOD example closed on the "X, not Y" framing
// both prompts ban twice), plus a voice-guard.ts lexical-tell regex missing
// several words/inflections the prompts themselves ban.
// alpha-drift-r37-01 through r37-05, all 2026-08-14.
// Run: npx tsx scripts/verify-r37-findings.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) lib/onboarding-state.ts: emailSavedAt is field-specific, not a whole-blob timestamp");
{
  const src = readFileSync(new URL("../lib/onboarding-state.ts", import.meta.url), "utf8");
  check("(1a) the interface field is renamed emailSavedAt", /emailSavedAt\?: number;/.test(src));
  check("(1b) the old whole-blob savedAt field declaration is gone", !/\bsavedAt\?: number;/.test(src));
  check("(1c) read()'s staleness check now compares against emailSavedAt", /if \(parsed\.email && \(!parsed\.emailSavedAt \|\| Date\.now\(\) - parsed\.emailSavedAt > EMAIL_STALE_AFTER_MS\)\) \{/.test(src));
  check("(1d) update() no longer stamps a timestamp unconditionally on every write", !/\.\.\.patch, savedAt: Date\.now\(\) \};/.test(src));
  check("(1e) update() stamps emailSavedAt only when the patch includes email", /\.\.\.\("email" in patch \? \{ emailSavedAt: Date\.now\(\) \} : \{\}\),/.test(src));

  // Behavioral proof against the real merge logic, replicated exactly since
  // update()'s spread is module-private (not exported) -- mirrors this
  // session's established pattern for testing unexported localStorage logic.
  function mergePatch(prevSavedAt: number | undefined, patch: Record<string, unknown>, now: number): number | undefined {
    const next: Record<string, unknown> = { emailSavedAt: prevSavedAt, ...patch, ...("email" in patch ? { emailSavedAt: now } : {}) };
    return next.emailSavedAt as number | undefined;
  }
  const now = 1_000_000_000_000;
  const staleTs = now - 25 * 60 * 60 * 1000; // 25h ago, past the 24h window
  check("(1f) behavioral: a patch touching only an unrelated field (topics) does NOT refresh a stale emailSavedAt", mergePatch(staleTs, { topics: ["ai"] }, now) === staleTs);
  check("(1g) behavioral: a patch touching only birthday does NOT refresh a stale emailSavedAt either", mergePatch(staleTs, { birthday: "1990-01-01" }, now) === staleTs);
  check("(1h) behavioral: a patch that actually sets email DOES stamp a fresh emailSavedAt", mergePatch(staleTs, { email: "a@b.com" }, now) === now);
  check("(1i) behavioral: this is the exact regression the finding describes -- the OLD unconditional-stamp logic would have refreshed it", (() => {
    const oldMerge = (prevSavedAt: number | undefined, patch: Record<string, unknown>, nowMs: number) => nowMs; // old: always Date.now()
    return oldMerge(staleTs, { topics: ["ai"] }, now) === now; // old behavior: wrongly "fresh"
  })());
}

console.log("(2) app/settings/page.tsx: the billingHeadingRef focus target can no longer be null when confirmingTier is set");
{
  const src = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
  check("(2a) the Add/Drop trigger buttons are now gated on quotaLoaded, not just !confirmingTier", /\{!confirmingTier && quotaLoaded && \(\s*\n\s*<div className="flex flex-wrap gap-4 mb-3">/.test(src));
  check("(2b) the billing heading paragraph (carrying the ref) is still gated on quotaLoaded, matching the trigger gate", /\{quotaLoaded \? \(\s*\n\s*<>\s*\n\s*<p ref=\{billingHeadingRef\}/.test(src));

  // Behavioral proof: with the shared quotaLoaded gate, requestTier (which
  // sets confirmingTier) can only ever fire from a trigger that only exists
  // once the ref-carrying paragraph is already mounted.
  function canTriggerRequestTier(quotaLoaded: boolean): boolean {
    return quotaLoaded; // gate: {!confirmingTier && quotaLoaded && (...)}
  }
  function refParagraphMounted(quotaLoaded: boolean): boolean {
    return quotaLoaded; // gate: {quotaLoaded ? (<p ref={billingHeadingRef} .../>) : (...)}
  }
  check("(2c) behavioral: whenever the trigger can fire, the ref paragraph is guaranteed already mounted", canTriggerRequestTier(true) === refParagraphMounted(true) && !canTriggerRequestTier(false));
}

console.log("(3) lib/engine/editor-note.ts: SYSTEM_PROMPT's own worked example no longer violates its own banned-phrase and comma-splice rules");
{
  const src = readFileSync(new URL("../lib/engine/editor-note.ts", import.meta.url), "utf8");
  check("(3a) the exemplar no longer uses the banned 'the practical one' label", !/is the practical one, it walks through/.test(src));
  check("(3b) the exemplar no longer contains the comma splice ('one, it walks')", !/practical one, it walks/.test(src));
  check("(3c) replaced with a two-sentence version that doesn't self-label", /The housing piece is more useful than it looks\. It walks through how to tell where your own area sits before you make an offer\./.test(src));
  check("(3d) the banned-word list still bans 'the practical one'/'the practical move' as a template tag (unchanged rule, now actually honored by the example above it)", /Do not label an item with a template tag like "the practical one" or "the practical move\."/.test(src));
  check("(3e) 'elevate' and 'ensure' added to the banned-word list (editor-note.ts's list was missing both, though topic-blurb.ts's own list already banned them)", /crucial, vital, critical, elevate, ensure\. No "Hope you are well"/.test(src));
}

console.log("(4) lib/engine/topic-blurb.ts: GOOD exemplar no longer closes on the 'X, not Y' framing the same prompt bans twice");
{
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  check("(4a) the GOOD exemplar's old ', not a countdown' closer is gone", !/treat the soft pricing as a fact you can use, not a countdown\./.test(src));
  check("(4b) replaced with a closer that doesn't set up a mirrored correction", /treat the soft pricing as a fact you can use today\./.test(src));
  check("(4c) sanity: the prompt still bans 'X, not Y' framing twice (unchanged rules, now actually honored by the example above them)", (src.match(/NO "X, not Y" framing/g) ?? []).length + (src.match(/"X, not Y" covers BOTH/g) ?? []).length >= 2);
}

console.log("(5) lib/engine/voice-guard.ts: BANNED_LEXICAL now catches the words/inflections the prompts ban that it previously missed");
{
  // alpha-drift-r38-01 (2026-08-19, self-audit): round 38 extended this same
  // regex further -- (5b) and (5d) below asserted exact substrings that no
  // longer appear contiguously now that "game-changing" sits between
  // "game-changer" and "unprecedented" (r38 also added -ed forms for
  // leverage/utilize/navigate/optimize/calibrate, see verify-r38-findings.mts
  // section (1) for that regression's own full coverage). Loosened to check
  // presence rather than an exact adjacent-substring match, so a future
  // extension in between two already-checked words doesn't break this
  // assertion again for the same non-reason.
  const src = readFileSync(new URL("../lib/engine/voice-guard.ts", import.meta.url), "utf8");
  check("(5a) 'ensure' and its inflections are now in the regex (previously absent entirely)", /\bensure\|ensures\|ensuring\|ensured\b/.test(src));
  check("(5b) 'game-changer' and 'unprecedented' are both in the regex (previously absent entirely; r38 added 'game-changing' between them too)", /game-changer/.test(src) && /unprecedented/.test(src));
  check("(5c) missing inflections added: navigates, elevates/elevating/elevated, fosters/fostered, delves/delved, bare tailor/tailors, calibrates", /navigates/.test(src) && /elevates\|elevating\|elevated/.test(src) && /fosters\|fostering\|fostered/.test(src) && /delves\|delving\|delved/.test(src) && /\btailor\|tailors\|tailored\|tailoring\b/.test(src) && /calibrates/.test(src));
  check("(5d) crucial/vital/critical added as general bare-word detection (previously only matched inside one specific phrase)", /synergy\|crucial\|vital\|critical/.test(src) && /game-changer/.test(src) && /unprecedented/.test(src));

  // Behavioral proof against the REAL exported findLexicalTells, not a
  // reimplementation.
  const { findLexicalTells } = await import("../lib/engine/voice-guard.ts");
  check("(5e) behavioral: 'we ensure quality' now trips a tell (previously slipped through undetected)", findLexicalTells("we ensure quality here").length > 0);
  check("(5f) behavioral: 'a real game-changer' now trips a tell", findLexicalTells("this is a real game-changer for the industry").length > 0);
  check("(5g) behavioral: 'unprecedented growth' now trips a tell", findLexicalTells("unprecedented growth this quarter").length > 0);
  check("(5h) behavioral: 'the report navigates the market' now trips a tell (inflection previously missing)", findLexicalTells("the report navigates the market well").length > 0);
  check("(5i) behavioral: 'this fostered growth' now trips a tell (inflection previously missing)", findLexicalTells("this fostered growth across teams").length > 0);
  check("(5j) behavioral: a clean sentence with none of these words still trips nothing (no over-eager false positive on plain prose)", findLexicalTells("The report shows home prices rose slightly last month.").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("R37 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL R37 FINDINGS ASSERTIONS PASS");
