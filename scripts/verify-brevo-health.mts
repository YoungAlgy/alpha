import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardProductFailures, type HardProductChecks } from "../lib/health-status";

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(path.join(repo, relative), "utf8");
let checks = 0;
function same(actual: unknown, expected: unknown): void { assert.deepEqual(actual, expected); checks++; }
function includes(source: string, needle: string): void { assert.ok(source.includes(needle), needle); checks++; }

const ready: HardProductChecks = {
  resend: true, stripe: true, stripeWebhook: true, checkoutBinding: true,
  unsubscribe: true, legacyCheckoutCutoff: true, supabase: true,
};
same(hardProductFailures(ready, "invite"), []);
same(hardProductFailures({ ...ready, resend: false }, "invite"), ["resend"]);
same(hardProductFailures({ ...ready, resend: false }, "paid"), ["resend"]);
same(hardProductFailures({ ...ready, stripe: false, stripeWebhook: false,
  checkoutBinding: false, legacyCheckoutCutoff: false }, "invite"), []);
same(hardProductFailures({ ...ready, stripe: false, stripeWebhook: false,
  checkoutBinding: false, legacyCheckoutCutoff: false }, "paid"),
  ["stripe", "stripeWebhook", "checkoutBinding", "legacyCheckoutCutoff"]);
same(hardProductFailures({ ...ready, resend: false, subscriberEmail: true }, "invite"), []);
same(hardProductFailures({ ...ready, resend: true, subscriberEmail: false }, "invite"), ["subscriberEmail"]);
same(hardProductFailures({ ...ready, resend: false, subscriberEmail: false }, "paid"), ["subscriberEmail"]);
same(hardProductFailures({ ...ready, resend: false, subscriberEmail: true,
  supabase: false, unsubscribe: false }, "invite"), ["unsubscribe", "supabase"]);
same(hardProductFailures({ ...ready, resend: false, subscriberEmail: true,
  stripe: false }, "paid"), ["stripe"]);

const route = read("app/api/health/route.ts");
const runtime = read("lib/subscriber-email-delivery.ts");
includes(route, "resend: !!process.env.RESEND_API_KEY");
includes(route, "const subscriberEmail = BREVO_DELIVERY_SCHEMA_ENABLED ? subscriberEmailStatus() : null");
includes(route, "emailProvider: subscriberEmail?.provider ?? (process.env.RESEND_API_KEY ? \"resend\" : \"none\")");
includes(route, "...(subscriberEmail ? { subscriberEmail: subscriberEmail.configured } : {})");
includes(route, "hardProductFailures(checks, accessMode)");
includes(runtime, "export function subscriberEmailStatus()");
includes(runtime, "const configured = subscriberDeliveryConfigured(config)");
includes(runtime, 'const preferred = config.schemaEnabled ? config.preferredProvider : "resend"');
same(route.indexOf("const subscriberEmail = BREVO_DELIVERY_SCHEMA_ENABLED ?") <
  route.indexOf("const checks = {"), true);
same(!route.includes("resend: subscriberEmail"), true);

console.log(`Brevo health offline checks passed (${checks} assertions).`);
