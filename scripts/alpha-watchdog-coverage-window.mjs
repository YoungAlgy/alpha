// Classify the current execution window, never infer a delayed cron's issue date.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WATCHDOG_COVERAGE_CRON = "37 20 * * *";

export function decideWatchdogCoverageWindow({ eventName, schedule, now }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now.getUTCFullYear() < 2000 || now.getUTCFullYear() > 9999) {
    return { state: "unknown", reason: "clock_invalid" };
  }
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    return { state: "unknown", reason: "event_unrecognized" };
  }
  if (eventName === "schedule") {
    if (schedule !== WATCHDOG_COVERAGE_CRON) {
      return { state: "unknown", reason: "schedule_unrecognized" };
    }
    if (now.getUTCHours() * 60 + now.getUTCMinutes() < 20 * 60 + 37) {
      // Choose a closed day to inspect, without guessing the cron's original
      // date. Only the new exact-issue RPC is safe for this target. Scheduler
      // timing stays unverified even if that closed day's coverage is healthy.
      const previous = new Date(now.getTime());
      previous.setUTCDate(previous.getUTCDate() - 1);
      return { state: "check", issueDate: previous.toISOString().slice(0, 10), basis: "closed_day" };
    }
  }
  return {
    state: "check",
    issueDate: now.toISOString().slice(0, 10),
    basis: eventName === "schedule" ? "scheduled" : "manual",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const decision = decideWatchdogCoverageWindow({
    eventName: process.env.GITHUB_EVENT_NAME,
    schedule: process.env.WATCHDOG_CRON,
    now: new Date(),
  });
  if (decision.state === "unknown") {
    console.error("Watchdog timing unverified: " + decision.reason);
    process.exitCode = 2;
  } else {
    if (decision.basis === "closed_day") console.error("Watchdog timing unverified: scheduled_window_not_due");
    process.stdout.write(`${decision.issueDate} ${decision.basis}`);
  }
}
