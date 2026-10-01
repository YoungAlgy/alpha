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
      // A prior day's cron may have arrived after midnight. The existing RPC
      // has no upper bound, so yesterday's cutoff could hide a missed day
      // behind a newer delivery. Flag timing uncertainty without reading it.
      return { state: "unknown", reason: "scheduled_window_not_due" };
    }
  }
  return {
    state: "check",
    cutoff: now.toISOString().slice(0, 10) + "T00:00:00Z",
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
    process.stdout.write(decision.cutoff);
  }
}
