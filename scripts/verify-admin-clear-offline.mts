// Execute the actual admin POST handler in a memory-only VM. The release
// policy deliberately disables new manual suppression removal. This harness
// proves the validated request stops before service-client creation, helper
// calls, provider calls, or any other mutation path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

const ROUTE_URL = new URL("../app/api/admin/users/route.ts", import.meta.url);
const POLICY_URL = new URL("../lib/suppression-recovery-policy.ts", import.meta.url);
const routeSource = readFileSync(ROUTE_URL, "utf8");
const policySource = readFileSync(POLICY_URL, "utf8");
const compiled = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const policyCompiled = ts.transpileModule(policySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const USER_ID = "11111111-1111-4111-8111-111111111111";

let assertions = 0;
assert.match(routeSource, /clear_suppression/);
assertions += 1;
assert.match(routeSource, /manual_recovery_disabled/);
assertions += 1;
assert.match(routeSource, /suppression-recovery-policy/);
assertions += 1;
assert.doesNotMatch(routeSource, /from ["']@\/lib\/(?:email|suppression-recovery)["']/);
assertions += 1;
const postStart = routeSource.indexOf("export async function POST");
const postSource = postStart > -1 ? routeSource.slice(postStart) : "";
const clearDisabledAt = postSource.indexOf("manual_recovery_disabled");
const serviceClientAt = postSource.indexOf("supabaseServiceClient()");
assert.ok(clearDisabledAt > 0 && serviceClientAt > clearDisabledAt, "disabled clear must precede service-client creation");
assertions += 1;

const policyExports: Record<string, unknown> = {};
const policyContext = vm.createContext({
  exports: policyExports,
  module: { exports: policyExports },
  require(name: string) {
    throw new Error(`unexpected policy import: ${name}`);
  },
});
vm.runInContext(policyCompiled, policyContext, { timeout: 1000 });
const disabledPolicyValues = Object.entries(policyExports).filter(
  ([name, value]) => /suppression|recovery/i.test(name) && typeof value === "boolean"
);
assert.ok(disabledPolicyValues.length > 0, "policy must export a suppression/recovery boolean");
assertions += 1;
assert.ok(disabledPolicyValues.every(([, value]) => value === false), "manual recovery policy must be false");
assertions += 1;
const holdMessage = policyExports.MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE;
assert.equal(typeof holdMessage, "string", "policy must export the manual recovery hold message");
assertions += 1;

type AuthMode = "admin" | "signed_out" | "non_admin";
type Scenario = {
  name: string;
  auth: AuthMode;
  rateLimited?: boolean;
  body?: unknown;
  rawBody?: string;
  expectedStatus: number;
  expectedRetryAfter?: string;
  expectedCode?: string;
};

async function run(scenario: Scenario) {
  let serverClientCreates = 0;
  let serviceClientCreates = 0;
  let networkAttempts = 0;
  const exportsObject: { POST?: (request: Request) => Promise<Response> } = {};

  const serverClient = {
    auth: {
      getUser: async () => {
        if (scenario.auth === "signed_out") return { data: { user: null }, error: null };
        return {
          data: {
            user: {
              id: scenario.auth === "admin" ? "admin-fixture" : "reader-fixture",
              email: scenario.auth === "admin" ? "youngalgy@gmail.com" : "reader@example.com",
            },
          },
          error: null,
        };
      },
    },
  };

  const context = vm.createContext({
    exports: exportsObject,
    module: { exports: exportsObject },
    Request,
    Response,
    fetch: () => {
      networkAttempts += 1;
      throw new Error("unexpected network attempt in offline admin-clear harness");
    },
    console: { warn: () => undefined, error: () => undefined, log: () => undefined },
    require(name: string) {
      if (name === "next/server") {
        return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      }
      if (name === "zod") return { z };
      if (name === "@/lib/supabase/server") {
        return {
          supabaseServerClient: async () => {
            serverClientCreates += 1;
            return serverClient;
          },
          supabaseServiceClient: async () => {
            serviceClientCreates += 1;
            throw new Error("manual recovery disabled test must not create a service client");
          },
        };
      }
      if (name === "@/lib/access") {
        return { ADMIN_EMAIL: "youngalgy@gmail.com", hasActiveAccess: () => true };
      }
      if (name === "@/lib/rate-limit") {
        return { rateLimit: () => scenario.rateLimited ? { ok: false, retryAfterSec: 120 } : { ok: true } };
      }
      if (name === "@/lib/admin-users-guards") {
        return { isFreeGrantEligible: () => false };
      }
      if (name === "@/lib/gotrue-errors") {
        return { isUserNotFoundError: () => false };
      }
      if (name === "@/lib/demographics") {
        return { isValidCalendarDate: () => true };
      }
      if (name === "@/lib/account-privacy") {
        return { normalizeAccountEmails: (...emails: unknown[]) => emails.filter(Boolean) };
      }
      if (name === "@/lib/account-deletion") {
        return {
          isAccountDeletionBlockedBySuppressionRecovery: () => false,
          removeAccountAuthAndCompleteSaga: () => { throw new Error("unexpected account deletion call"); },
          settleAccountDeletionBilling: () => { throw new Error("unexpected account billing call"); },
          settleAccountDeletionPrivacy: () => { throw new Error("unexpected account privacy call"); },
        };
      }
      if (name === "@/lib/suppression-recovery-policy") return policyExports;
      if (name === "@/lib/reader-profile-state") return { hasUsableReaderProfile: () => true };
      throw new Error(`unexpected route import: ${name}`);
    },
  });
  vm.runInContext(compiled, context, { timeout: 1000 });
  const response = await exportsObject.POST!(new Request("http://fixture.invalid/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: scenario.rawBody ?? JSON.stringify(scenario.body ?? { action: "clear_suppression", userId: USER_ID }),
  }));
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
    retryAfter: response.headers.get("Retry-After"),
    serverClientCreates,
    serviceClientCreates,
    networkAttempts,
  };
}

const scenarios: Scenario[] = [
  { name: "authenticated validated clear is held", auth: "admin", expectedStatus: 409, expectedCode: "manual_recovery_disabled" },
  { name: "unauthenticated request is denied", auth: "signed_out", expectedStatus: 401 },
  { name: "non-admin request is denied", auth: "non_admin", expectedStatus: 403 },
  { name: "invalid body remains a 400", auth: "admin", body: { action: "clear_suppression", userId: "not-a-uuid" }, expectedStatus: 400 },
  { name: "invalid JSON remains a 400", auth: "admin", rawBody: "{", expectedStatus: 400 },
  { name: "rate limit remains a 429", auth: "admin", rateLimited: true, expectedStatus: 429, expectedRetryAfter: "120" },
];

for (const scenario of scenarios) {
  const result = await run(scenario);
  assert.equal(result.status, scenario.expectedStatus, `${scenario.name}: status`);
  assert.equal(result.serviceClientCreates, 0, `${scenario.name}: no service client`);
  assert.equal(result.networkAttempts, 0, `${scenario.name}: no network attempt`);
  assert.equal(result.serverClientCreates, 1, `${scenario.name}: auth client`);
  assertions += 4;
  if (scenario.expectedCode !== undefined) {
    assert.equal(result.body.code, scenario.expectedCode, `${scenario.name}: stable hold code`);
    assert.equal(result.body.error, holdMessage, `${scenario.name}: exact policy hold message`);
    assert.equal(result.body.ok, undefined, `${scenario.name}: no success flag`);
    assertions += 3;
  }
  if (scenario.expectedRetryAfter !== undefined) {
    assert.equal(result.retryAfter, scenario.expectedRetryAfter, `${scenario.name}: Retry-After`);
    assertions += 1;
  }
}

console.log(`PASS verify-admin-clear-offline (${assertions} assertions, actual route with fake collaborators only)`);
