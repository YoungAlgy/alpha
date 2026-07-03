// Verify the DAILY cadence date math: the period key, the "previous send"
// lookup, and the "since the last send" Brave window. These drive both the
// per-send idempotency key and whether a stale topic backfills, so the date
// arithmetic has to be exactly right. (Cadence went daily 2026-07-03;
// previously Sun/Tue/Thu — the generic invariants below hold for ANY cadence
// array, the gap checks assert the daily-specific shape.)
// Run: npx tsx scripts/verify-cadence-window.mts
const { CADENCE_UTC_DAYS, isSendDay, previousSendIso, sinceLastSendWindow } =
  await import("../lib/cadence.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const wd = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

// Walk a full year of dates and check the invariants on every one.
const start = Date.parse("2026-01-01T12:00:00Z");
let invariantOk = true;
let windowShapeOk = true;
let mostRecentOk = true;
let gapOnSendDaysOk = true;
const re = /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/;

for (let i = 0; i < 400; i++) {
  const iso = new Date(start + i * 86400000).toISOString().slice(0, 10);
  const prev = previousSendIso(iso);

  // (a) the previous send is always a real cadence day, strictly earlier
  if (!CADENCE_UTC_DAYS.includes(wd(prev))) invariantOk = false;
  if (!(daysBetween(prev, iso) >= 1)) invariantOk = false;

  // (b) it's the MOST RECENT one: no cadence day strictly between prev and iso
  for (let d = 1; d < daysBetween(prev, iso); d++) {
    const between = new Date(Date.parse(`${prev}T12:00:00Z`) + d * 86400000)
      .toISOString()
      .slice(0, 10);
    if (CADENCE_UTC_DAYS.includes(wd(between))) mostRecentOk = false;
  }

  // (c) the window string is well-formed and bounded by prev..iso
  const w = sinceLastSendWindow(iso);
  if (!re.test(w) || w !== `${prev}to${iso}`) windowShapeOk = false;

  // (d) daily cadence: every day is a send day and looks back exactly 1 day
  if (!isSendDay(iso)) gapOnSendDaysOk = false;
  if (daysBetween(prev, iso) !== 1) gapOnSendDaysOk = false;
}

check("(a) previous send is always a cadence day strictly before the date", invariantOk);
check("(b) previous send is the MOST RECENT cadence day (none in between)", mostRecentOk);
check("(c) window is 'YYYY-MM-DDtoYYYY-MM-DD' bounded by prev..date", windowShapeOk);
check("(d) daily cadence: every day sends and looks back exactly 1 day", gapOnSendDaysOk);

// Concrete spot-checks (weekday computed, not hardcoded).
{
  const find = (targetWd: number) => {
    for (let i = 0; i < 14; i++) {
      const iso = new Date(start + i * 86400000).toISOString().slice(0, 10);
      if (wd(iso) === targetWd) return iso;
    }
    return "";
  };
  const sun = find(0), mon = find(1), thu = find(4);
  check(`(e) a Sunday (${sun}) looks back to a Saturday`, wd(previousSendIso(sun)) === 6);
  check(`(e) a Monday (${mon}) looks back to a Sunday`, wd(previousSendIso(mon)) === 0);
  check(`(e) a Thursday (${thu}) looks back to a Wednesday`, wd(previousSendIso(thu)) === 3);
  check("(e) isSendDay true for every weekday 0-6", CADENCE_UTC_DAYS.length === 7);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CADENCE WINDOW VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CADENCE-WINDOW ASSERTIONS PASS");
