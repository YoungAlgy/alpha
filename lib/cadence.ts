// Multi-send cadence helpers. The newsletter sends DAILY (since 2026-07-03;
// previously Sun/Tue/Thu). Each send is its own "period" (its own issues row +
// blurb cache + idempotency key), keyed by the SEND DATE rather than a week.
// The live search for a send only looks at what's new SINCE the previous send,
// so a topic with nothing new reads as empty and the ranked-pool selector
// backfills it.

// Cadence days as UTC weekday numbers. Every day = daily sends. The walking
// helpers below (previousSendIso, nextSendIso) still derive from this array,
// so at daily cadence they resolve to yesterday/tomorrow.
export const CADENCE_UTC_DAYS = [0, 1, 2, 3, 4, 5, 6];

// alpha-drift-r33-02 (2026-08-14): the real daily-send hour, UTC (matches
// the GitHub Actions cron trigger, "0 14 * * *"). Anything that converts a
// send's precise UTC instant to a READER's own local calendar day
// (components/Digest.tsx's formatDateline, app/inbox/page.tsx's
// nextSendLabel) must anchor to THIS -- not the T12:00:00Z used elsewhere
// in this file, which is a deliberately-different, arbitrary safe-midday
// value for pure DATE arithmetic (previousSendIso/nextSendIso/isSendDay,
// where only the calendar date matters, never the wall-clock hour). Digest
// used T12:00:00Z where it should have used this, leaving a real 2-hour gap
// that silently reintroduced the "reader sees yesterday's date" bug for
// UTC+10/UTC+11 readers even after the localTimezone fix.
export const SEND_HOUR_UTC = 14;

// Today's UTC date as YYYY-MM-DD = this send's period key (stored in week_of).
export function currentPeriodIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Is this YYYY-MM-DD a scheduled send day? (Every day, at daily cadence.)
export function isSendDay(periodIso: string): boolean {
  return CADENCE_UTC_DAYS.includes(new Date(`${periodIso}T12:00:00Z`).getUTCDay());
}

// The most recent cadence day STRICTLY before `periodIso`. Walks back a day at
// a time, so it's correct for any send day and for off-schedule manual triggers
// (at daily cadence: yesterday). The noon-UTC anchor dodges DST and
// offset edges in the date arithmetic.
export function previousSendIso(periodIso: string): string {
  const d = new Date(`${periodIso}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (CADENCE_UTC_DAYS.includes(d.getUTCDay())) break;
  }
  return d.toISOString().slice(0, 10);
}

// Brave discovery date-range "since the last send": previousSend..thisSend.
// Lets a topic with nothing new in the last few days read as empty so the
// ranked-pool selector backfills it instead of repeating stale news.
export function sinceLastSendWindow(periodIso: string): `${string}to${string}` {
  return `${previousSendIso(periodIso)}to${periodIso}`;
}

// The next scheduled send STRICTLY after `now` (at daily cadence: tomorrow,
// unless today's own send hasn't fired yet -- see r41-02 below), as
// YYYY-MM-DD. Drives the reader-facing "next one ships ..." label.
//
// alpha-drift-r41-02 (2026-08-19, self-audit): this used to unconditionally
// walk forward at least one day before checking CADENCE_UTC_DAYS, so it
// could never return today's date no matter what time `now` was. At daily
// cadence that loop always breaks on its first iteration, so this always
// said "tomorrow" -- even at, say, 08:00 UTC, six hours BEFORE today's real
// 14:00 UTC (SEND_HOUR_UTC) send has fired, when today genuinely is the
// next send. app/inbox/page.tsx's nextSendLabel() renders this
// unconditionally in the sticky header ("NEXT ONE SHIPS ..."), so every
// reader who opened /inbox between 00:00 and 14:00 UTC -- the entire US
// morning/overnight and a large slice of the day for Europe/Asia -- saw a
// date one full day later than the truth. The exact same root cause
// r35-07/r36-02 worked around on the settings page's resume copy (by
// dropping the specific-day claim entirely) rather than fixing here, on the
// mistaken assumption this function was already correct. Now checks
// whether today is still ahead of its own send instant first.
export function nextSendIso(now: Date = new Date()): string {
  const todayIso = now.toISOString().slice(0, 10);
  const todaysSendInstant = new Date(`${todayIso}T${String(SEND_HOUR_UTC).padStart(2, "0")}:00:00Z`);
  if (isSendDay(todayIso) && now.getTime() < todaysSendInstant.getTime()) {
    return todayIso;
  }
  const d = new Date(`${todayIso}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (CADENCE_UTC_DAYS.includes(d.getUTCDay())) break;
  }
  return d.toISOString().slice(0, 10);
}
