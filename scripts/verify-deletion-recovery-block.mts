// Runs both deletion routes in memory with an injected, typed unresolved
// suppression-recovery block. No environment, Stripe, database, Auth, or
// provider action is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as suppressionPolicy from "../lib/suppression-recovery-policy";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "reader@fixture.invalid";
const RECOVERY_MESSAGE = "account deletion blocked by unresolved suppression recovery";

type RouteKind = "self" | "admin";
type FailureKind = "recovery_block" | "unknown";
type RunResult = {
  response: Response;
  billingCalls: number;
  privacyCalls: number;
  authDeleteCalls: number;
  sagaCalls: number;
  providerCalls: number;
};

function compile(relativePath: string): string {
  return ts.transpileModule(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
}

async function run(kind: RouteKind, failureKind: FailureKind): Promise<RunResult> {
  let billingCalls = 0;
  let privacyCalls = 0;
  let authDeleteCalls = 0;
  let sagaCalls = 0;
  let providerCalls = 0;
  const recoveryError = Object.assign(new Error(
    failureKind === "recovery_block" ? RECOVERY_MESSAGE : "fixture preparation failure"
  ), {
    name: "AccountDeletionBlockedError",
    code: failureKind === "recovery_block" ? "unresolved_suppression_recovery" : undefined,
  });
  const serviceClient = {
    from(table: string) {
      assert.equal(table, "users");
      return {
        select(columns: string) {
          assert.equal(columns, "email");
          return this;
        },
        eq(column: string, value: string) {
          assert.equal(column, "id");
          assert.equal(value, USER_ID);
          return this;
        },
        async maybeSingle() {
          return { data: { email: EMAIL }, error: null };
        },
      };
    },
    auth: {
      admin: {
        async getUserById(id: string) {
          assert.equal(id, USER_ID);
          return { data: { user: { email: EMAIL } }, error: null };
        },
        async deleteUser() {
          authDeleteCalls += 1;
          return { error: null };
        },
      },
    },
  };
  const serverClient = {
    auth: {
      async getUser() {
        return {
          data: {
            user: {
              id: USER_ID,
              email: kind === "admin" ? "youngalgy@gmail.com" : EMAIL,
            },
          },
          error: null,
        };
      },
      async signOut() {
        authDeleteCalls += 1;
        return { error: null };
      },
    },
  };
  const exportsObject: { POST?: (request?: Request) => Promise<Response> } = {};
  const source = compile(
    kind === "self"
      ? "../app/api/account/delete/route.ts"
      : "../app/api/admin/users/route.ts"
  );
  const context = vm.createContext({
    exports: exportsObject,
    Request,
    Response,
    console: { warn: () => undefined, error: () => undefined, log: () => undefined },
    require(name: string) {
      if (name === "next/server") {
        return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      }
      if (name === "zod") return { z };
      if (name === "@/lib/supabase/server") {
        return {
          supabaseServerClient: async () => serverClient,
          supabaseServiceClient: async () => serviceClient,
        };
      }
      if (name === "@/lib/rate-limit") return { rateLimit: () => ({ ok: true }) };
      if (name === "@/lib/gotrue-errors") return { isUserNotFoundError: () => false };
      if (name === "@/lib/account-privacy") return { normalizeAccountEmails: () => [EMAIL] };
      if (name === "@/lib/account-deletion") {
        return {
          isAccountDeletionBlockedBySuppressionRecovery: (error: unknown) =>
            failureKind === "recovery_block" &&
            error === recoveryError &&
            (error as { code?: unknown }).code === "unresolved_suppression_recovery",
          settleAccountDeletionBilling: async () => {
            billingCalls += 1;
            throw recoveryError;
          },
          settleAccountDeletionPrivacy: async () => {
            privacyCalls += 1;
          },
          removeAccountAuthAndCompleteSaga: async () => {
            sagaCalls += 1;
          },
        };
      }
      if (name === "@/lib/access") {
        return {
          ADMIN_EMAIL: "youngalgy@gmail.com",
          hasActiveAccess: () => true,
          hasReaderAccess: () => false,
        };
      }
      if (name === "@/lib/admin-users-guards") return { isFreeGrantEligible: () => false };
      if (name === "@/lib/email") return { resendConfigured: () => false, removeResendSuppression: async () => { providerCalls += 1; return false; } };
      if (name === "@/lib/demographics") return { isValidCalendarDate: () => true };
      if (name === "@/lib/suppression-recovery-policy") return suppressionPolicy;
      if (name === "@/lib/reader-profile-state") return { hasUsableReaderProfile: () => true };
      if (name === "@/lib/cadence") return { currentPeriodIso: () => "2026-09-24" };
      if (name === "@/lib/suppression-recovery") return { recoverResendSuppression: async () => ({ status: "already_clear" }) };
      throw new Error(`unexpected route import: ${name}`);
    },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  const response = kind === "self"
    ? await exportsObject.POST!()
    : await exportsObject.POST!(new Request("http://fixture.invalid/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", userId: USER_ID }),
    }));
  return { response, billingCalls, privacyCalls, authDeleteCalls, sagaCalls, providerCalls };
}

let assertions = 0;
for (const kind of ["self", "admin"] as const) {
  const result = await run(kind, "recovery_block");
  const body = await result.response.json() as { error?: string };
  assert.equal(result.response.status, 409, `${kind}: recovery block status`);
  assert.match(body.error ?? "", /reviewed delivery recovery/i, `${kind}: recovery review wording`);
  assert.match(body.error ?? "", /still intact/i, `${kind}: account intact wording`);
  assert.equal(result.billingCalls, 1, `${kind}: billing preparation attempt`);
  assert.equal(result.providerCalls, 0, `${kind}: zero delivery-provider calls`);
  assert.equal(result.privacyCalls, 0, `${kind}: zero privacy calls`);
  assert.equal(result.authDeleteCalls, 0, `${kind}: zero Auth deletion/sign-out calls`);
  assert.equal(result.sagaCalls, 0, `${kind}: zero Auth saga calls`);
  assertions += 8;
}

for (const kind of ["self", "admin"] as const) {
  const result = await run(kind, "unknown");
  const body = await result.response.json() as { error?: string };
  assert.equal(result.response.status, 503, `${kind}: unknown preparation status`);
  assert.match(body.error ?? "", /billing cleanup/i, `${kind}: unknown keeps generic billing wording`);
  assert.equal(result.privacyCalls, 0, `${kind}: unknown zero privacy calls`);
  assert.equal(result.authDeleteCalls, 0, `${kind}: unknown zero Auth deletion/sign-out calls`);
  assert.equal(result.sagaCalls, 0, `${kind}: unknown zero Auth saga calls`);
  assertions += 5;
}

console.log(`PASS verify-deletion-recovery-block (${assertions} assertions, actual routes with injected recovery block only)`);
