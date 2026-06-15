// Multi-send cadence helpers. The newsletter sends on Sunday, Tuesday, and
// Thursday. Each send is its own "period" (its own issues row + blurb cache +
// idempotency key), keyed by the SEND DATE rather than a week. The live search
// for a send only looks at what's new SINCE the previous send, so a topic with
// nothing new reads as empty and the ranked-pool selector backfills it.

// Cadence days as UTC weekday numbers: Sunday(0), Tuesday(2), Thursday(4).
export const CADENCE_UTC_DAYS = [0, 2, 4];

// Today's UTC date as YYYY-MM-DD = this send's period key (stored in week_of).
export function currentPeriodIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Is this YYYY-MM-DD a scheduled send day? (Sun/Tue/Thu in UTC.)
export function isSendDay(periodIso: string): boolean {
  return CADENCE_UTC_DAYS.includes(new Date(`${periodIso}T12:00:00Z`).getUTCDay());
}

// The most recent cadence day STRICTLY before `periodIso`. Walks back a day at
// a time, so it's correct for any send day and for off-schedule manual triggers
// (it just finds the previous Sun/Tue/Thu). The noon-UTC anchor dodges DST and
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

// The next scheduled send STRICTLY after `now` (the upcoming Sun/Tue/Thu), as
// YYYY-MM-DD. Drives the reader-facing "next one ships ..." label.
export function nextSendIso(now: Date = new Date()): string {
  const d = new Date(`${now.toISOString().slice(0, 10)}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (CADENCE_UTC_DAYS.includes(d.getUTCDay())) break;
  }
  return d.toISOString().slice(0, 10);
}
