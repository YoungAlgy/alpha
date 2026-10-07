import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { parseBrevoCanaryRequest } from "../lib/brevo-canary-policy";
import { validateDeliveryIssueWindow } from "../lib/delivery-issue-window.mjs";

// Execute the real GET handler with module imports replaced at its boundary.
// This fixture never imports Next, opens an env file, or reaches a provider.
const source = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const nativeRequire = createRequire(import.meta.url);
const id = "a1111111-1111-4111-8111-111111111111";
const url = `https://alpha.everyday.report/api/cron/weekly-send?canaryUserId=${id}&canaryProvider=brevo`;
const fixtureEpoch = Date.parse("2026-09-26T14:17:00.000Z");
class FixtureDate extends Date {
  constructor(value: string | number = fixtureEpoch) { super(value); }
  static now() { return fixtureEpoch; }
}
let checks = 0;
function same(actual: unknown, expected: unknown) { assert.deepEqual(actual, expected); checks++; }

async function invoke(options: {
  workflow?: boolean;
  schema?: boolean;
  canaryGate?: boolean;
  noModel?: boolean;
  noPaid?: boolean;
  canaryMode?: boolean;
  runPin?: { ALPHA_DELIVERY_ISSUE_DATE: string; ALPHA_DELIVERY_RUN_STARTED_AT: string };
  issue?: boolean;
  path?: string;
}) {
  const calls: string[] = [];
  const query = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "not", "or", "is", "order", "gt"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push(`${table}.${method}:${args.join(",")}`);
        return builder;
      };
    }
    builder.maybeSingle = async () => {
      calls.push(`${table}.maybeSingle`);
      return { data: options.issue ? { id: "existing" } : null, error: null };
    };
    builder.limit = async (count: number) => {
      calls.push(`${table}.limit:${count}`);
      return { data: [], error: null };
    };
    return builder;
  };
  const sb = { from: (table: string) => { calls.push(`from:${table}`); return query(table); } };
  const quiet = { log() {}, warn() {}, error() {} };
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) }, after() {} },
    "@/lib/subscriber-delivery-policy": { SUBSCRIBER_LETTERS_ENABLED: true },
    "@/lib/brevo-delivery-policy": {
      BREVO_DELIVERY_SCHEMA_ENABLED: options.schema ?? true,
      BREVO_CANARY_DELIVERY_ENABLED: options.canaryGate ?? true,
    },
    "@/lib/brevo-canary-policy": { parseBrevoCanaryRequest },
    "@/lib/delivery-issue-window.mjs": { validateDeliveryIssueWindow: (input: Parameters<typeof validateDeliveryIssueWindow>[0]) => {
      calls.push("validateDeliveryIssueWindow");
      return validateDeliveryIssueWindow(input);
    } },
    "@/lib/supabase/server": { supabaseServiceClient: async () => { calls.push("supabaseServiceClient"); return sb; } },
    "@/lib/cadence": { currentPeriodIso: () => "2026-09-26", isSendDay: () => true, sinceLastSendWindow: () => ({}) },
    "@/lib/checkout-profile-retention": { scrubExpiredCheckoutProfiles: async () => { calls.push("retention-write"); return []; } },
    "@/lib/paid-call-reservation": { createDailyPaidCallGuard: () => ({}) },
  };
  const exports: Record<string, unknown> = {};
  const process = { env: {
    CRON_SECRET: "fixture-secret",
    ALPHA_BREVO_CANARY_MODE: options.canaryMode === false ? "0" : "1",
    GITHUB_ACTIONS: options.workflow === false ? "false" : "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    ALPHA_NO_MODEL_MODE: options.noModel === false ? "0" : "1",
    ALPHA_ALLOW_PAID_AI: options.noPaid === false ? "1" : "0",
    ...options.runPin,
  } };
  vm.runInNewContext(compiled, {
    exports, process, URL, Date: FixtureDate, console: quiet,
    require: (name: string) => name === "crypto" ? nativeRequire(name) : mocks[name] ?? {},
  }, { timeout: 1000 });
  const request = { url: options.path ?? url, headers: {
    get: (name: string) => name === "authorization" ? "Bearer fixture-secret" : null,
  } };
  const response = await (exports.GET as (req: unknown) => Promise<{ status: number; body: unknown }>)(request);
  return { response, calls };
}

const publicRuntime = await invoke({ workflow: false });
same(publicRuntime.response.status, 403);
same(publicRuntime.calls, []);

const conflictingInput = await invoke({ path: `${url}&force=1` });
same(conflictingInput.response.status, 400);
same(conflictingInput.calls, []);

for (const flags of [{ schema: false }, { canaryGate: false }, { noModel: false }, { noPaid: false }]) {
  const denied = await invoke(flags);
  same(denied.response.status, 503);
  same(denied.calls, []);
}

const duplicate = await invoke({ issue: true });
same(duplicate.response.status, 409);
same(duplicate.calls.some((call) => call.includes(`issues.eq:user_id,${id}`)), true);
same(duplicate.calls.some((call) => call.startsWith("from:users")), false);
same(duplicate.calls.some((call) => call.includes("write") || call.includes("cursor")), false);

const ineligible = await invoke({});
same(ineligible.response.status, 409);
same(ineligible.calls.some((call) => call.includes(`users.eq:id,${id}`)), true);
same(ineligible.calls.includes("users.limit:2"), true);
same(ineligible.calls.some((call) => call.includes("write") || call.includes("cursor")), false);

// The real canary policy retains its exact-reader path when the workflow also
// supplies unusable normal daily pins. This harness stops at target eligibility,
// before any generation or acceptance, and makes no actual provider attempt.
for (const [runPin, reason] of [
  [{ ALPHA_DELIVERY_ISSUE_DATE: "2026-09-26", ALPHA_DELIVERY_RUN_STARTED_AT: "2026-09-26T12:47:00.000Z" }, "run_pin_expired"],
  [{ ALPHA_DELIVERY_ISSUE_DATE: "2026-09-25", ALPHA_DELIVERY_RUN_STARTED_AT: "2026-09-26T14:17:00.000Z" }, "run_pin_invalid"],
] as const) {
  const pinnedCanary = await invoke({ runPin });
  same(pinnedCanary.response.status, 409);
  same(JSON.parse(JSON.stringify(pinnedCanary.response.body)), { error: "Canary target is not one eligible enrolled reader." });
  same(pinnedCanary.calls, ineligible.calls);
  same(pinnedCanary.calls.includes("validateDeliveryIssueWindow"), false);

  // The bypass belongs only to an accepted canary scope. A normal manual
  // daily request still rejects the same pin before any database work.
  const pinnedDaily = await invoke({ runPin, canaryMode: false, path: "https://example.invalid/api/cron/weekly-send" });
  same(pinnedDaily.response.status, 503);
  same(JSON.parse(JSON.stringify(pinnedDaily.response.body)), { error: "Delivery run window is invalid or expired.", reason });
  same(pinnedDaily.calls, ["validateDeliveryIssueWindow"]);

  const missingCanaryScope = await invoke({ runPin, path: "https://example.invalid/api/cron/weekly-send" });
  same(missingCanaryScope.response.status, 400);
  same(missingCanaryScope.calls, []);
}

console.log(`Brevo canary route early-path checks passed (${checks} assertions).`);
