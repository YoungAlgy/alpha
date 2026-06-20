// Demographic helpers: generation + zodiac sign + tone guidance, all derived
// from a birthday (full date) and an optional gender. Pure + dependency-free so
// they're cheap to call at generation time and easy to unit-test. We collect a
// FULL birthday (not just a year) because it unlocks the zodiac sign; the year
// alone gives the generation.

import type { Gender } from "./types";
export type { Gender };
export type Generation = "gen-z" | "millennial" | "gen-x" | "boomer" | "silent";
export type ZodiacSign =
  | "aries" | "taurus" | "gemini" | "cancer" | "leo" | "virgo"
  | "libra" | "scorpio" | "sagittarius" | "capricorn" | "aquarius" | "pisces";

// A birthday is stored as an ISO date string "YYYY-MM-DD". Parse leniently and
// return null for anything that isn't a real, sane date (year 1900..now).
export function parseBirthday(raw: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!raw || typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible day-of-month (e.g. Feb 30) by round-tripping through Date.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  // Sane range: a real subscriber, not a typo. (Upper bound is generous; the
  // caller decides any minimum-age policy.)
  if (year < 1900 || year > 2014) return null;
  return { year, month, day };
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
