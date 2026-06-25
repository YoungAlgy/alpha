// Deterministic enforcement of the no-AI-tells writing voice on generated prose.
// The generation prompts already ASK the model to avoid em/en dashes, semicolons,
// and curly quotes, but Haiku (and any model) follows that imperfectly — and these
// are a HARD reader-facing rule. So we also strip the mechanical violations in
// code, the same way url-guard enforces the citable-URL rule instead of trusting
// the prompt alone. Structural tells ("X, not Y", rule-of-three) can't be safely
// regex-fixed and stay prompt-only; this handles the punctuation/glyph ones, which
// are clear-cut and the most visible.
export function sanitizeVoice(s: string): string {
  if (!s) return s;
  return s
    .replace(/\s*—\s*/g, ", ") // em dash → comma (never long dashes)
    .replace(/–/g, "-") // en dash → hyphen
    .replace(/[‘’]/g, "'") // curly single quotes → straight
    .replace(/[“”]/g, '"') // curly double quotes → straight
    .replace(/…/g, "...") // ellipsis glyph → three dots people type
    .replace(/\s*;\s*/g, ", ") // semicolon → comma (no semicolons)
    .replace(/,\s*,/g, ",") // tidy any doubled comma the swaps created
    .replace(/ {2,}/g, " ") // collapse doubled spaces
    .trim();
}

// META-LEAK GUARD. The single worst tell a reader can hit is the letter narrating
// its OWN sourcing: "this week's signal is thin", "without seeing the full essay",
// a note listing the raw junk inputs. It instantly proves a machine assembled the
// letter with no human in the loop. The prompt now forbids it, but Haiku slips, so
// (like url-guard) we ENFORCE it in code: any reader-facing string that matches one
// of these is dropped (an item) or replaced (the section intro) before it ships.
//
// Patterns target the META use only, and are deliberately PRECISION-biased: a
// false positive silently DROPS a good item a subscriber paid for, so we only
// match phrasings with no innocent reading across the topic catalog (finance,
// markets, sports-betting, music, tech...). The bare word "signal" is allowed
// (a "market signal" / "buy signal" / "the signal suggests a reversal" is legit
// trading language). We only flag "signal" when it is described as SCARCE ("the
// signal is thin/quiet") or scoped to the letter's own period ("this week's
// signal"), plus the process-confession phrases. We do NOT match "source
// material" (legit in a documentary/research item), "in the signal" (EEG/signal
// processing), or a generic "the signal suggests" (trading) — those over-matched.
// The prompt is the primary defense; this guard catches only the unambiguous,
// fatal leaks, and accepts a small recall loss on ambiguous wording.
const META_LEAK_PATTERNS: RegExp[] = [
  /\bthis week'?s signal\b/i, // also covers "what this week's signal actually contains"
  /\bthe signal (is thin|is quiet|is sparse|is mostly|for this week|for this topic)\b/i,
  /\bsignal (is|was|seems|reads as|looks) (thin|quiet|sparse|light|weak|limited|mostly)\b/i,
  /\bthe (week|signal) produced (no|little|nothing)\b/i,
  /\bno substantive (new )?(essay|reporting|writing|piece|coverage)\b/i,
  /\bwithout (seeing|reading|having seen|having read) the full\b/i,
  /\bbased on (the|a) headline (alone|snippet)\b/i,
  /\bthe premise alone is worth\b/i,
  /\bheadline snippet\b/i,
  /\bnavigation pages?\b/i,
  /\barchive listings?\b/i,
  /\bwhat (is|'?s) missing this week\b/i,
];

// True if a reader-facing string narrates the letter's own sourcing/process.
export function containsMetaLeak(s: string | undefined | null): boolean {
  if (!s) return false;
  return META_LEAK_PATTERNS.some((re) => re.test(s));
}

// Lexical tells the PROMPT already bans but the model still slips. We do NOT
// auto-rewrite these (a clumsy swap reads worse than the word, which defeats the
// goal), but findLexicalTells surfaces them so the rate is observable in logs and
// we can tighten the prompt or escalate if it climbs. Detection only.
const BANNED_LEXICAL: RegExp[] = [
  /\b(leverage|leverages|leveraging|utilize|utilizes|utilizing|navigate|navigating|elevate|foster|fostering|tailored|tailoring|robust|seamless|seamlessly|delve|delving|comprehensive|landscape|realm|testament|optimize|optimizes|optimizing|optimization|calibrate|calibrating|synergy)\b/gi,
  /\bthis matters because\b/gi,
  /\bmatters because\b/gi,
  /\bthe insight here\b/gi,
  /\bwhat makes this (critical|matter)\b/gi,
  /\bunderstanding (this|these|the why)\b/gi,
  /\bthe practical move\b/gi,
  /\bthe takeaway is\b/gi,
  /\bthis reframes\b/gi,
];

// Returns the distinct banned words/phrases present (lowercased), for logging.
export function findLexicalTells(s: string | undefined | null): string[] {
  if (!s) return [];
  const hits = new Set<string>();
  for (const re of BANNED_LEXICAL) {
    const m = s.match(re);
    if (m) for (const h of m) hits.add(h.toLowerCase());
  }
  return [...hits];
}
