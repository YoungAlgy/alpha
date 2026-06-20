// Verify the demographic helpers (birthday parse, generation, zodiac, tone).
// Pure, fast, no network. Run: npx tsx scripts/verify-demographics.mts
const {
  parseBirthday, generationFromYear, zodiacFromDate, zodiacSign, generationOf,
  toneGuidance, zodiacLabel, generationLabel,
} = await import("../lib/demographics.ts");

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "OK " : "XX "} ${label}`); cond ? pass++ : fail++; };

// parseBirthday
console.log("(1) parseBirthday");
check("valid date parses", JSON.stringify(parseBirthday("1994-07-30")) === JSON.stringify({ year: 1994, month: 7, day: 30 }));
check("rejects Feb 30", parseBirthday("1994-02-30") === null);
check("accepts Feb 29 on a leap year", parseBirthday("2000-02-29") !== null);
check("rejects Feb 29 on a non-leap year", parseBirthday("2001-02-29") === null);
check("rejects garbage", parseBirthday("not-a-date") === null);
check("rejects empty / null", parseBirthday("") === null && parseBirthday(null) === null);
check("rejects month 13", parseBirthday("1994-13-01") === null);
check("rejects absurd year", parseBirthday("1850-01-01") === null);
check("rejects a too-young birthday (post-2014, matches the date input max)", parseBirthday("2018-06-01") === null);

// generation (Pew boundaries)
console.log("(2) generation");
check("1996 = millennial (boundary)", generationFromYear(1996) === "millennial");
check("1997 = gen-z (boundary)", generationFromYear(1997) === "gen-z");
check("1980 = gen-x (boundary)", generationFromYear(1980) === "gen-x");
check("1981 = millennial (boundary)", generationFromYear(1981) === "millennial");
check("1964 = boomer / 1965 = gen-x", generationFromYear(1964) === "boomer" && generationFromYear(1965) === "gen-x");
check("1945 = silent", generationFromYear(1945) === "silent");
check("generationOf from full birthday", generationOf("1994-07-30") === "millennial");

// zodiac (cusp boundaries are the classic gotcha)
console.log("(3) zodiac");
check("Jul 30 = leo", zodiacFromDate(7, 30) === "leo");
check("Mar 21 = aries (cusp start)", zodiacFromDate(3, 21) === "aries");
check("Mar 20 = pisces (cusp end)", zodiacFromDate(3, 20) === "pisces");
check("Dec 25 = capricorn (year wrap)", zodiacFromDate(12, 25) === "capricorn");
check("Jan 1 = capricorn (year wrap)", zodiacFromDate(1, 1) === "capricorn");
check("Jan 20 = aquarius (boundary)", zodiacFromDate(1, 20) === "aquarius");
check("Jan 19 = capricorn (boundary)", zodiacFromDate(1, 19) === "capricorn");
check("Oct 23 = scorpio", zodiacFromDate(10, 23) === "scorpio");
check("zodiacSign from full birthday", zodiacSign("1994-07-30") === "leo");
check("zodiacSign null on bad date", zodiacSign("garbage") === null);
// Every day of the year must map to exactly one sign (no gaps, no overlaps).
let everyDayCovered = true;
for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) {
  if (parseBirthday(`2001-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`) && zodiacFromDate(m, d) === null) everyDayCovered = false;
}
check("every real calendar day maps to a sign", everyDayCovered);

// labels
console.log("(4) labels");
check("zodiacLabel capitalizes", zodiacLabel("leo") === "Leo");
check("generationLabel", generationLabel("gen-z") === "Gen Z" && generationLabel("millennial") === "Millennial");

// toneGuidance — subtle, gendered, generational, and SAFE on unknowns
console.log("(5) toneGuidance");
check("empty when nothing known", toneGuidance(null, null) === "");
check("male tone mentions man + avoids women framing", /man/i.test(toneGuidance("male", null)) && /women/i.test(toneGuidance("male", null)));
check("female tone mentions woman", /woman/i.test(toneGuidance("female", null)));
check("generation tone names the generation", /Millennial/.test(toneGuidance(null, "millennial")));
check("combined includes both + the subtle guardrail", /man/i.test(toneGuidance("male", "gen-z")) && /Gen Z/.test(toneGuidance("male", "gen-z")) && /subtle/i.test(toneGuidance("male", "gen-z")));
check("never name-drops the generation to the reader", /Do not name-drop/.test(toneGuidance(null, "boomer")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.error("DEMOGRAPHICS VERIFICATION FAILED"); process.exit(1); }
console.log("ALL DEMOGRAPHICS ASSERTIONS PASS");
