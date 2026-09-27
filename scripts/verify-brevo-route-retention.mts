import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pruneUnownedBrevoEvents } from "../lib/brevo-event-retention";

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(repo, relative), "utf8");
let checks = 0;
function same(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
  checks++;
}

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
for (const [data, error, expected] of [
  [0, null, { pruned: 0, remaining: false, errors: 0 }],
  [9, null, { pruned: 9, remaining: false, errors: 0 }],
  [100, null, { pruned: 100, remaining: true, errors: 0 }],
  [-1, null, { pruned: 0, remaining: true, errors: 1 }],
  [101, null, { pruned: 0, remaining: true, errors: 1 }],
  [1.5, null, { pruned: 0, remaining: true, errors: 1 }],
  ["1", null, { pruned: 0, remaining: true, errors: 1 }],
  [1, { message: "sensitive@example.com" }, { pruned: 0, remaining: true, errors: 1 }],
] as const) {
  const result = await pruneUnownedBrevoEvents({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data, error };
    },
  });
  same(result, expected);
}
same(calls.every((call) => call.name === "prune_unowned_brevo_suppression_events" &&
  call.args.p_limit === 100), true);
same(await pruneUnownedBrevoEvents({ rpc: async () => { throw new Error("private data"); } }),
  { pruned: 0, remaining: true, errors: 1 });

const route = read("app/api/webhooks/brevo/route.ts");
const webhook = read("lib/brevo-webhook.ts");
const maintenance = read("app/api/cron/account-deletion-maintenance/route.ts");
same(route.includes("schemaEnabled: BREVO_DELIVERY_SCHEMA_ENABLED"), true);
const authGate = webhook.indexOf("if (!authenticateBrevoWebhook(");
const schemaGate = webhook.indexOf("if (options.schemaEnabled !== true)");
const bodyRead = webhook.indexOf("await boundedBody(req,");
same(authGate >= 0 && schemaGate > authGate && bodyRead > schemaGate, true);
same(route.includes("secret: process.env.BREVO_WEBHOOK_TOKEN"), true);
same(route.indexOf("handleBrevoSuppressionWebhook(req") < route.indexOf("const sb = await supabaseServiceClient()"), true);
same(route.includes('sb.rpc("record_brevo_suppression_event"') &&
  route.includes("p_message_id: event.messageId") &&
  route.includes("p_recipient: event.recipient"), true);
same(!route.includes("fetch(") && !route.includes("BREVO_API_KEY"), true);
same(maintenance.includes("const brevoEventRetention = BREVO_DELIVERY_SCHEMA_ENABLED") &&
  maintenance.includes("? await pruneUnownedBrevoEvents(sb)"), true);
same(maintenance.includes("const resendEventRetention = await pruneUnownedResendEvents(sb)"), true);

console.log(`Brevo route/retention offline checks passed (${checks} assertions).`);
