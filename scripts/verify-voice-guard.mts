// One-off verification of the deterministic writing-voice guard.
// 1) Unit-checks sanitizeVoice on a crafted string with every banned glyph.
// 2) Runs a REAL generation (Brave signal + Haiku) for one topic blurb AND the
//    editor note, then scans every reader-facing string for the banned glyphs.
//    The generation prompts already ask the model to avoid these, but Haiku
//    slips. The code guard must make the OUTPUT clean regardless.
//
// Run: npx tsx scripts/verify-voice-guard.mts
import { readFileSync } from "node:fs";

// Load .env.local into process.env (standalone scripts don't get Next's env).
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { sanitizeVoice, containsMetaLeak, findLexicalTells } = await import("../lib/engine/voice-guard.ts");
const { resolveTopicSignal } = await import("../lib/engine/source-resolver.ts");
const { generateTopicBlurb } = await import("../lib/engine/topic-blurb.ts");
const { generateEditorNote } = await import("../lib/engine/editor-note.ts");

function weekOfNow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// The banned glyphs, with the codepoint so a failure is unambiguous in a terminal.
const BANNED: Array<[string, RegExp]> = [
  ["em dash (U+2014)", /—/],
  ["en dash (U+2013)", /–/],
  ["curly single quote (U+2018/2019)", /[‘’]/],
  ["curly double quote (U+201C/201D)", /[“”]/],
  ["ellipsis glyph (U+2026)", /…/],
  ["semicolon", /;/],
];

function scan(label: string, text: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of BANNED) {
    if (re.test(text)) hits.push(`${label}: ${name}`);
  }
  return hits;
}

let failures = 0;

// --- 1) Unit check -----------------------------------------------------------
const dirty =
  "Real wealth—your background—matters; the 2018–2020 window said “so”. Wait… it’s fine.";
const cleaned = sanitizeVoice(dirty);
const unitHits = scan("unit", cleaned);
if (unitHits.length) {
  console.error("UNIT FAIL: sanitizeVoice left banned glyphs:");
  for (const h of unitHits) console.error("  - " + h);
  failures++;
} else {
  console.log("UNIT PASS: sanitizeVoice stripped every banned glyph.");
  console.log("  in :", JSON.stringify(dirty));
  console.log("  out:", JSON.stringify(cleaned));
}

// --- 1b) Meta-leak guard unit check -----------------------------------------
// containsMetaLeak DROPS items, so a false positive deletes a good item a reader
// paid for. These probes lock in: legit content (a "market signal", "source
// material" in a documentary, "a spike in the signal") must NOT be flagged, and
// the real sourcing/process confessions MUST be flagged.
const LEGIT_NOT_LEAK = [
  "The bond market signal suggests a reversal is coming.",
  "A strong buy signal appeared on the weekly chart.",
  "Traders watch the yield curve as a recession signal.",
  "The documentary draws on rare archival source material.",
  "Her book uses primary source material from the 1840s.",
  "There was a spike in the signal during the EEG study.",
  "The app sends a clear signal when your heart rate climbs.",
  "Congress held hearings on job postings that discriminate by age.",
  "The museum digitized its archive of listings from the 1920s.",
  "A navigation app that maps trail conditions in real time.",
  "He provides a clear framework for thinking about risk.",
];
const REAL_META_LEAK = [
  "This week's signal on Christianity is thin and mostly institutional.",
  "What this week's signal actually contains is mostly navigation pages.",
  "Without seeing the full essay text, the premise alone is worth clicking.",
  "The week produced no substantive new essay or reporting.",
  "The signal for this topic is mostly archive listings and homepages.",
  "Based on the headline snippet alone, this looks promising.",
];
const fp = LEGIT_NOT_LEAK.filter((s) => containsMetaLeak(s));
const fn = REAL_META_LEAK.filter((s) => !containsMetaLeak(s));
if (fp.length || fn.length) {
  console.error("META-LEAK GUARD FAIL:");
  for (const s of fp) console.error("  FALSE POSITIVE (legit dropped): " + JSON.stringify(s));
  for (const s of fn) console.error("  MISSED LEAK: " + JSON.stringify(s));
  failures++;
} else {
  console.log(`META-LEAK GUARD PASS: ${LEGIT_NOT_LEAK.length} legit kept, ${REAL_META_LEAK.length} leaks caught.`);
}
// findLexicalTells is detection-only; confirm it surfaces a known tell and stays quiet on clean prose.
const tellsHit = findLexicalTells("This matters because it optimizes the tailored plan.");
const tellsClean = findLexicalTells("Homes are sitting longer and sellers are offering concessions.");
if (tellsHit.length === 0 || tellsClean.length > 0) {
  console.error(`LEXICAL-TELL FAIL: hit=${JSON.stringify(tellsHit)} clean=${JSON.stringify(tellsClean)}`);
  failures++;
} else {
  console.log(`LEXICAL-TELL PASS: flagged ${JSON.stringify(tellsHit)} and stayed quiet on clean prose.`);
}

// --- 2) Live generation ------------------------------------------------------
const weekOf = weekOfNow();
const topicId = "personal-finance"; // one of Gigi's topics; concrete, news-rich

console.log(`\nResolving signal for ${topicId} (${weekOf})...`);
const signal = await resolveTopicSignal(topicId as never, weekOf);

console.log("Generating topic blurb on Haiku...");
const blurb = await generateTopicBlurb(topicId as never, weekOf, signal);

const blurbStrings: string[] = [blurb.intro];
for (const it of blurb.items) {
  blurbStrings.push(it.headline, it.body);
  if (it.primaryRef?.label) blurbStrings.push(it.primaryRef.label);
  for (const r of it.supplementaryRefs ?? []) {
    blurbStrings.push(r.label);
    if (r.note) blurbStrings.push(r.note);
  }
}

console.log("Generating editor note on Haiku...");
const note = await generateEditorNote(
  {
    id: "verify",
    email: "verify@example.com",
    firstName: "Gigi",
    city: "Tampa, FL",
    topics: [topicId as never],
    jobBlurb: undefined,
    projectBlurb: undefined,
    funBlurb: "real estate, women's health, nutrition, faith",
    gender: "female",
    birthday: undefined,
  } as never,
  [blurb]
);

const allStrings = [...blurbStrings, note];
const liveHits: string[] = [];
for (let i = 0; i < allStrings.length; i++) {
  liveHits.push(...scan(`live[${i}]`, allStrings[i]));
}

console.log(`\nScanned ${allStrings.length} generated strings.`);
if (liveHits.length) {
  console.error("LIVE FAIL: banned glyphs survived in real Haiku output:");
  for (const h of liveHits) console.error("  - " + h);
  // Show the offending strings so the regex can be tightened if needed.
  for (let i = 0; i < allStrings.length; i++) {
    if (scan(`x`, allStrings[i]).length) console.error("    >>> " + JSON.stringify(allStrings[i]));
  }
  failures++;
} else {
  console.log("LIVE PASS: zero banned glyphs in editor note + topic blurb.");
  console.log("\n--- editor note sample ---\n" + note + "\n");
}

if (failures) {
  console.error(`\nVOICE GUARD: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nVOICE GUARD: all checks passed.");
