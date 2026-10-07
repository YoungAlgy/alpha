// Runs after checkout but before any database, provider, install or build step.
import { decideDeliveryIssueWindow } from "../lib/delivery-issue-window.mjs";

const decision = decideDeliveryIssueWindow({
  eventName: process.env.GITHUB_EVENT_NAME,
  schedule: process.env.ALPHA_DELIVERY_CRON,
  now: new Date(),
});
if (decision.state === "ready") {
  process.stdout.write(`ready=true\nissue_date=${decision.issueDate}\nstarted_at=${decision.startedAt}\n`);
} else {
  process.stdout.write("ready=false\n");
  console.error("Delivery window: " + decision.reason);
  if (decision.state === "rejected") process.exitCode = 1;
}
