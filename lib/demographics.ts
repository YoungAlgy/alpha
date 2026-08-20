// Demographic helpers: generation + zodiac sign + tone guidance, all derived
// from a birthday (full date) and an optional gender. Pure + dependency-free so
// they're cheap to call at generation time and easy to unit-test. We collect a
// FULL birthday (not just a year) because it unlocks the zodiac sign; the year
// alone gives the generation.

import type { Gender } from "./types";
export type { Gender };

// Narrow an untrusted value to a stored Gender, or null. The single home for
// the male/female allow-check (mirrors coerceThemeId for themes) so the same
// two-string guard isn't hand-written at every read/write boundary.
export function coerceGender(raw: unknown): Gender | null {
  return raw === "male" || raw === "female" ? raw : null;
}
export type Generation = "gen-z" | "millennial" | "gen-x" | "boomer" | "silent";
export type ZodiacSign =
  | "aries" | "taurus" | "gemini" | "cancer" | "leo" | "virgo"
  | "libra" | "scorpio" | "sagittarius" | "capricorn" | "aquarius" | "pisces";

// alpha-drift-r20-01 (found+fixed 2026-08-13): app/privacy/page.tsx promises
// "we do not knowingly collect data from anyone under 13," but the old upper
// bound here was a FIXED year (2014) -- not a real, live-computed minimum
// age. A fixed year cutoff doesn't stay accurate: it was already wrong the
// day it was written (2026 - 2014 = as young as 11-12 today), and would only
// get MORE wrong (allowing older and older ages relative to "13") the longer
// the code went untouched, since real time keeps moving but the hardcoded
// year doesn't. Computed live against the actual current date instead, so
// this stays correct indefinitely rather than needing a periodic manual bump.
const MIN_AGE_YEARS = 13;

// alpha-drift-r26-06 (2026-08-14): extracted from parseBirthday's own
// round-trip check so OTHER "YYYY-MM-DD" fields with no birthday-specific
// year-range constraint (weekOf in app/api/generate/route.ts and app/api/
// cron/weekly-send/route.ts's ?weekOf= override) can reuse the same real
// fix instead of each hand-rolling a weaker version. JS's Date parser
// SILENTLY ROLLS OVER an impossible day-of-month instead of throwing or
// producing NaN -- `new Date('2026-04-31T00:00:00Z')` parses fine and
// normalizes to May 1 (April only has 30 days) -- so a check that only
// tests `Number.isNaN(new Date(...))` can never catch this class of input;
// it has to compare the parsed fields back against what was actually asked
// for, which is what this round-trip does.
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// String-shaped convenience wrapper for isValidCalendarDate -- the common
// case at most call sites, which start from a raw "YYYY-MM-DD" string, not
// already-parsed numbers.
export function isValidCalendarDateString(raw: string): boolean {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!m && isValidCalendarDate(+m[1], +m[2], +m[3]);
}

// alpha-drift-r53-07 (2026-08-20, timezone-date-edge-case-audit): both the
// cutoff below and maxBirthdayForMinAge used to subtract MIN_AGE_YEARS from
// "now" and feed the raw month/day straight into Date.UTC / string
// interpolation. On Feb 29 in a year where (currentYear - MIN_AGE_YEARS)
// isn't itself a leap year -- true on essentially every real leap day,
// since 13 (an odd number) mod 4 = 1 -- that silently rolled over to March
// 1 (Date.UTC's own well-known JS behavior for an out-of-range day),
// loosening the under-13 cutoff by one real day, and separately made
// maxBirthdayForMinAge() emit the literal nonexistent string "…-02-29" as
// an HTML date input's max attribute (an invalid value browsers treat as
// absent per spec, silently removing the client-side upper bound for that
// one day). Shared helper: subtract N years from `now`, clamped to the
// last real day of the target month if the naive result would roll over.
function subtractYearsClamped(now: Date, years: number): Date {
  const y = now.getUTCFullYear() - years;
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const candidate = new Date(Date.UTC(y, m, d));
  // Date.UTC(y, m+1, 0) is JS's own idiom for "the last day of month m" --
  // rolling the day to 0 walks back one day from the 1st of the NEXT month.
  return candidate.getUTCMonth() !== m ? new Date(Date.UTC(y, m + 1, 0)) : candidate;
}

// A birthday is stored as an ISO date string "YYYY-MM-DD". Parse leniently and
// return null for anything that isn't a real, sane date (year 1900..a real
// minimum age from today).
export function parseBirthday(raw: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!raw || typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (!isValidCalendarDate(year, month, day)) return null;
  if (year < 1900) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date-based (not year-only) comparison: correctly handles a reader whose
  // birthday hasn't happened yet this calendar year (e.g. checked in August
  // for someone born in September -- they're still under MIN_AGE_YEARS until
  // that September date arrives, even though the plain year difference would
  // already read as MIN_AGE_YEARS).
  const now = new Date();
  const cutoff = subtractYearsClamped(now, MIN_AGE_YEARS);
  if (d.getTime() > cutoff.getTime()) return null;
  return { year, month, day };
}

// Same MIN_AGE_YEARS boundary as parseBirthday above, exposed as a ready-to-
// use HTML date-input `max` value so the client-side native date picker's
// own constraint stays in sync with the server-side validator instead of
// drifting the way the old hardcoded "2014-12-31" did (see parseBirthday's
// comment for why a fixed year doesn't stay accurate). UTC-based so a
// server render and a client hydration compute the identical calendar date
// regardless of the machine's local timezone -- a naive local-time
// `new Date()` could otherwise differ by up to a day between a UTC server
// and a client in another timezone, right at the day boundary.
export function maxBirthdayForMinAge(): string {
  const clamped = subtractYearsClamped(new Date(), MIN_AGE_YEARS);
  const y = clamped.getUTCFullYear();
  const mo = String(clamped.getUTCMonth() + 1).padStart(2, "0");
  const da = String(clamped.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Pew generation boundaries. Anyone born 1997+ is treated as Gen Z (folds in the
// handful of even-younger readers, who'd want the same register).
export function generationFromYear(year: number): Generation | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2014) return null;
  if (year >= 1997) return "gen-z";
  if (year >= 1981) return "millennial";
  if (year >= 1965) return "gen-x";
  if (year >= 1946) return "boomer";
  return "silent";
}

// Tropical sun-sign date ranges (the standard western zodiac).
export function zodiacFromDate(month: number, day: number): ZodiacSign | null {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  const md = month * 100 + day; // e.g. Mar 21 -> 321
  if (md >= 321 && md <= 419) return "aries";
  if (md >= 420 && md <= 520) return "taurus";
  if (md >= 521 && md <= 620) return "gemini";
  if (md >= 621 && md <= 722) return "cancer";
  if (md >= 723 && md <= 822) return "leo";
  if (md >= 823 && md <= 922) return "virgo";
  if (md >= 923 && md <= 1022) return "libra";
  if (md >= 1023 && md <= 1121) return "scorpio";
  if (md >= 1122 && md <= 1221) return "sagittarius";
  if ((md >= 1222 && md <= 1231) || (md >= 101 && md <= 119)) return "capricorn";
  if (md >= 120 && md <= 218) return "aquarius";
  if (md >= 219 && md <= 320) return "pisces";
  return null;
}

export function zodiacSign(raw: string | null | undefined): ZodiacSign | null {
  const b = parseBirthday(raw);
  return b ? zodiacFromDate(b.month, b.day) : null;
}

export function generationOf(raw: string | null | undefined): Generation | null {
  const b = parseBirthday(raw);
  return b ? generationFromYear(b.year) : null;
}

const GENERATION_LABEL: Record<Generation, string> = {
  "gen-z": "Gen Z",
  millennial: "Millennial",
  "gen-x": "Gen X",
  boomer: "Boomer",
  silent: "Silent Generation",
};
export function generationLabel(g: Generation): string {
  return GENERATION_LABEL[g];
}

export function zodiacLabel(s: ZodiacSign): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "Millennial, Leo" from a birthday — the generation and zodiac sign joined.
// Empty string when the birthday is missing or invalid. The single source for
// this read; callers wrap their own surrounding copy (or a raw-date fallback)
// around it. A valid birthday always yields BOTH a generation and a sign, so a
// non-empty return means a full "Gen, Sign".
export function demographicSummary(raw: string | null | undefined): string {
  const g = generationOf(raw);
  const s = zodiacSign(raw);
  return [g ? generationLabel(g) : null, s ? zodiacLabel(s) : null].filter(Boolean).join(", ");
}

// A short, plain-English steer the letter writer folds into its voice. Kept
// SUBTLE on purpose: it nudges register, examples, and references — it never
// stereotypes, panders, or changes the facts. Returns "" when we know nothing,
// in which case the default voice (intentionally neutral, not feminine-leaning)
// stands. The default-voice fix is what addresses "it felt too themed for women."
export function toneGuidance(gender: Gender | null | undefined, generation: Generation | null): string {
  const parts: string[] = [];
  if (gender === "male") {
    parts.push(
      "The reader is a man. Write to him directly and plainly. Pick examples and references that land for a male reader. Avoid a tone or framing that reads as written for women."
    );
  } else if (gender === "female") {
    parts.push(
      "The reader is a woman. Write to her directly. Pick examples and references that land for a female reader."
    );
  }
  if (generation) {
    parts.push(
      `The reader is in the ${generationLabel(generation)} generation. Match that generation's register and cultural references. Do not name-drop the generation or comment on their age.`
    );
  }
  if (parts.length === 0) return "";
  return (
    "READER VOICE: " +
    parts.join(" ") +
    " Keep this subtle. Same facts, tuned voice. Never stereotype or pander."
  );
}
