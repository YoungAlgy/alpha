// Verify round 23 finding (alpha-drift-r23-01, 2026-08-14, HIGH): the
// privacy policy's Third-party processors section claimed profile data
// (name, city, gender, generation label, job/project/fun context) is
// included in the generation request for TOPIC SECTIONS -- both when
// Anthropic writes one as the last-resort tier ("also writes each topic
// section... your name, city... are included") and when Gemini/Groq/
// DeepSeek write one ("whichever one writes a section sees the same
// fields Anthropic does"). Neither claim is true: generateTopicBlurb()
// never receives a user/profile parameter at all, regardless of which
// provider tier services it -- only generateEditorNote() does, and that's
// a structurally separate pipeline. Profile data DOES reach Gemini/Groq/
// DeepSeek, but only in their role as an EDITOR'S-NOTE fallback tier if
// Anthropic is briefly down, never when any of them writes a topic
// section. The fix corrects the copy to match which ROLE a provider is
// playing, not just which provider it is.
//
// This checks the real data-flow claims directly against the actual
// generation code (the same way the fix was verified before it was
// written), then checks the corrected copy against those same facts, so a
// future change to either the code OR the copy that reintroduces the
// mismatch fails this check.
// Run: npx tsx scripts/verify-privacy-ai-provider-scope.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) the real code: generateTopicBlurb (topic sections) never receives a user/profile parameter, from ANY provider tier");
{
  const src = readFileSync(new URL("../lib/engine/topic-blurb.ts", import.meta.url), "utf8");
  const sigMatch = src.match(/export async function generateTopicBlurb\(([\s\S]*?)\): Promise<TopicBlurb>/);
  check("(1a) generateTopicBlurb's signature was found", !!sigMatch);
  check("(1b) the signature has no user/profile parameter of any name", !!sigMatch && !/user|profile/i.test(sigMatch[1]));
  check("(1c) the userPrompt template only interpolates topic label, date, and signal.context -- no name/city/gender/blurb fields", !/user\.(firstName|city|gender|jobBlurb|projectBlurb|funBlurb|birthday)/.test(src));
}

console.log("(2) the real code: generateEditorNote is a structurally SEPARATE pipeline, and it's the only one that ever sees profile fields");
{
  const src = readFileSync(new URL("../lib/engine/editor-note.ts", import.meta.url), "utf8");
  check("(2a) generateEditorNote takes a real UserProfile-shaped `user` parameter", /export async function generateEditorNote\(\s*\n\s*user: UserProfile,/.test(src));
  check("(2b) it builds profileLines from name/city/job/project/fun", /profileLines = \[/.test(src) && /Name: \$\{clamp\(user\.firstName/.test(src));
  check("(2c) it derives a tone from gender + generation (from birthday)", /toneGuidance\(user\.gender, generationOf\(user\.birthday\)\)/.test(src));
  check("(2d) the SAME userPrompt (carrying profileLines + tone) is reused verbatim for the Gemini/Groq/DeepSeek fallback tiers -- profile data DOES reach them, but only in this editor's-note role", (src.match(/\buserPrompt\b/g) ?? []).length >= 4);
}

console.log("(3) the corrected privacy policy copy accurately reflects both of the above");
{
  const src = readFileSync(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");
  // alpha-drift-r59-09 (2026-08-20, duplicate-code-audit-r9): round 36
  // (alpha-drift-r36-05) broke both bullets' marathon sentences into short
  // declaratives -- same facts, no meaning changed, but exact wording/
  // punctuation shifted (a semicolon splice became "down. In that", "of
  // the letter built from" became "built from", lowercase mid-sentence
  // "in that role" became a new sentence's capitalized "In that role").
  // These regexes went stale the moment that copy-only rewrite landed,
  // permanently red-failing on wording that was intentionally, correctly
  // changed for readability. Updated to match the current, real sentence
  // boundaries.
  check("(3a) Anthropic bullet: profile data is scoped to the editor's note specifically, not topic sections generally", /writes the short editor&apos;s note at\s+the top of your letter\.\s+That note is the one part built from your\s+profile: your name, city/.test(src));
  check("(3b) Anthropic bullet: explicitly states it does NOT see the profile when writing a topic section", /In that role it never sees your\s+profile, only the topic and that day&apos;s research/.test(src));
  check("(3c) Gemini/Groq/DeepSeek bullet: explicitly states none of the four see profile data for a topic section", /None of the four ever see your[\s\S]{0,20}profile when writing a topic section/.test(src));
  check("(3d) Gemini/Groq/DeepSeek bullet: correctly scopes profile-data exposure to their editor's-note fallback role specifically", /also\s+back up the\s+editor&apos;s note if Anthropic is briefly down\.\s+In that\s+specific role, whichever one steps in sees the same profile\s+fields/.test(src));
  // Regression guard: the OLD false claims must be gone, not just the new
  // true ones added alongside them.
  check("(3e) the old false claim ('also writes each topic section... included in the generation request') is gone", !/also writes each topic section when our[\s\S]{0,20}free-tier writers below can&apos;t\. Your name, city/.test(src));
  check("(3f) the old false claim ('whichever one writes a section sees the same fields') is gone", !/Whichever one writes a section sees the same fields Anthropic[\s\S]{0,20}does\./.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("PRIVACY-AI-PROVIDER-SCOPE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL PRIVACY-AI-PROVIDER-SCOPE ASSERTIONS PASS");
