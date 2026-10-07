// Pure clock rules shared by the Actions gate and authenticated send route.
// A schedule's nominal date is unavailable. Only actual execution time is used.
export const DAILY_SEND_CRONS = Object.freeze(["17 14 * * *", "37 15 * * *", "47 18 * * *"]);
export const DAILY_SEND_START_MINUTE = 14 * 60 + 17;
export const DELIVERY_RUN_MAX_AGE_MS = 90 * 60 * 1000;

/** @param {unknown} now @returns {now is Date} */
function validClock(now) {
  return now instanceof Date && Number.isFinite(now.getTime()) &&
    now.getUTCFullYear() >= 2000 && now.getUTCFullYear() <= 9999;
}

/**
 * @param {{eventName: unknown, schedule?: unknown, now: unknown}} input
 * @returns {{state: 'ready', issueDate: string, startedAt: string} | {state: 'defer' | 'rejected', reason: string}}
 */
export function decideDeliveryIssueWindow({ eventName, schedule, now }) {
  if (!validClock(now)) return { state: "rejected", reason: "clock_invalid" };
  if (eventName !== "schedule" && eventName !== "workflow_dispatch")
    return { state: "rejected", reason: "event_unrecognized" };
  if (eventName === "schedule") {
    if (typeof schedule !== "string" || !DAILY_SEND_CRONS.includes(schedule))
      return { state: "rejected", reason: "schedule_unrecognized" };
    if (now.getUTCHours() * 60 + now.getUTCMinutes() < DAILY_SEND_START_MINUTE)
      return { state: "defer", reason: "before_primary_window" };
  }
  return { state: "ready", issueDate: now.toISOString().slice(0, 10), startedAt: now.toISOString() };
}

/**
 * Validate a server's immutable run pin again before each delivery page.
 * Midnight can finish the pinned issue but cannot open a fresh issue.
 * Paid-call accounting still follows the actual request's UTC date.
 * @param {{eventName: unknown, schedule?: unknown, issueDate: unknown, startedAt: unknown, now: unknown}} input
 * @returns {{state: 'ready', issueDate: string} | {state: 'rejected', reason: string}}
 */
export function validateDeliveryIssueWindow({ eventName, schedule, issueDate, startedAt, now }) {
  if (!validClock(now)) return { state: "rejected", reason: "clock_invalid" };
  if (typeof startedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startedAt))
    return { state: "rejected", reason: "run_pin_invalid" };
  const start = new Date(startedAt);
  if (!validClock(start) || start.toISOString() !== startedAt)
    return { state: "rejected", reason: "run_pin_invalid" };
  const decision = decideDeliveryIssueWindow({ eventName, schedule, now: start });
  if (decision.state !== "ready" || issueDate !== decision.issueDate)
    return { state: "rejected", reason: "run_pin_invalid" };
  const age = now.getTime() - start.getTime();
  if (age < 0 || age >= DELIVERY_RUN_MAX_AGE_MS)
    return { state: "rejected", reason: "run_pin_expired" };
  return { state: "ready", issueDate: decision.issueDate };
}
