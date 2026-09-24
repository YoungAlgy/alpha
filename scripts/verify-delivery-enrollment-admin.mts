// Local source contract for owner-controlled letter enrollment. This verifier
// reads only checked-in source; it does not touch the database or providers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { hasReaderAccess } from "../lib/access.ts";
import { blocksCsrf } from "../lib/csrf-guard.ts";
import { hasUsableReaderProfile } from "../lib/reader-profile-state.ts";

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const route = source("../app/api/admin/users/route.ts");
const page = source("../app/settings/accounts/page.tsx");
const migration = source("../supabase/migrations/20260924000000_delivery_enrollment.sql");

assert.match(migration, /delivery_enrolled boolean not null default false/);
assert.match(migration, /new\.delivery_enrolled := old\.delivery_enrolled/);
assert.match(migration, /new\.delivery_enrolled := false/);
assert.match(migration, /or not v_user\.delivery_enrolled/);
assert.equal((migration.match(/where u\.delivery_enrolled/g) ?? []).length, 2);

assert.match(route, /"enable_delivery"/);
assert.match(route, /"pause_delivery"/);
assert.match(route, /expectedEmail: z\.string\(\)\.email\(\)\.optional\(\)/);
assert.match(route, /existing\.email !== body\.expectedEmail/);
assert.match(route, /hasReaderAccess\(existing\.subscribed_at, existing\.cancelled_at, existing\.access_granted_at\)/);
assert.match(route, /authUser\.email_confirmed_at/);
assert.match(route, /authUser\.email\.toLowerCase\(\)\.trim\(\) !== existing\.email/);
assert.match(route, /authUser\.banned_until/);
assert.match(route, /code: "email_unconfirmed"/);
assert.match(route, /code: "email_mismatch"/);
assert.match(route, /code: "email_change_pending"/);
assert.match(route, /code: "account_banned"/);
assert.match(route, /code: "account_deleted"/);
assert.match(route, /code: "anonymous_account"/);
assert.match(route, /code: "signup_incomplete"/);
assert.match(route, /existing\.unsubscribed_at \|\| existing\.bounced_at \|\| existing\.complained_at/);
assert.match(route, /existing\.suppression_cleanup_pending_at \|\| existing\.suppression_recovery_token/);
assert.match(route, /\.update\(\{ delivery_enrolled: enable \}\)/);
assert.match(route, /\.eq\("delivery_enrolled", !enable\)/);
assert.match(route, /if \(enable\) \{\s*update = existing\.updated_at === null\s*\? update\.is\("updated_at", null\)\s*: update\.eq\("updated_at", existing\.updated_at\);/);
// postgrest-js joins array filters with bare commas, which splits a custom
// topic that contains a comma. The row fence must not use array filters.
assert.doesNotMatch(route, /\.(contains|containedBy)\("topics"/);
assert.match(route, /delivery state change blocked by active provider lease/);
assert.match(route, /status: 409/);

assert.match(page, /delivery_enrolled: boolean/);
assert.match(page, /expectedEmail: email/);
assert.match(page, /Enable letters/);
assert.match(page, /Pause letters/);

// Run the actual new POST branch after extracting it from the TypeScript AST.
// Only its DB/Auth/response boundaries are mocked. No server is started.
const parsed = ts.createSourceFile("route.ts", route, ts.ScriptTarget.Latest, true);
const post = parsed.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "POST"
);
assert.ok(post?.body, "POST handler must exist");
const deliveryBranch = post.body.statements.find(
  (node): node is ts.IfStatement =>
    ts.isIfStatement(node) && node.getText(parsed).startsWith('if (body.action === "enable_delivery"')
);
assert.ok(deliveryBranch, "separate delivery action branch must exist");
const runnable = ts.transpileModule(
  `async function run(body, sb, NextResponse, hasReaderAccess, hasUsableReaderProfile, console) { ${deliveryBranch.getText(parsed)} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

type Row = {
  email: string;
  first_name: string | null;
  topics: string[];
  birthday: string | null;
  updated_at: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  access_granted_at: string | null;
  delivery_enrolled: boolean;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  suppression_cleanup_pending_at: string | null;
  suppression_recovery_token: string | null;
  suppression_recovery_started_at: string | null;
  delivery_suppression_cleared_at: string | null;
};

const userId = "245fb183-0d73-4a57-bf17-38bd57e37fb6";
const expectedEmail = "reader@example.test";
const defaultRow = (): Row => ({
  email: expectedEmail,
  first_name: "Reader",
  topics: ["mental-health"],
  birthday: null,
  updated_at: "2026-09-02T00:00:00.123456+00:00",
  subscribed_at: "2026-09-01T00:00:00Z",
  cancelled_at: null,
  access_granted_at: "2026-09-01T00:00:00Z",
  delivery_enrolled: false,
  unsubscribed_at: null,
  bounced_at: null,
  complained_at: null,
  suppression_cleanup_pending_at: null,
  suppression_recovery_token: null,
  suppression_recovery_started_at: null,
  delivery_suppression_cleared_at: null,
});
const defaultAuth = () => ({
  email: expectedEmail,
  email_confirmed_at: "2026-09-01T00:00:00Z",
  banned_until: null as string | null,
  new_email: null as string | null,
  deleted_at: null as string | null,
  is_anonymous: false,
});

async function exercise(options: {
  action?: "enable_delivery" | "pause_delivery";
  row?: Partial<Row>;
  auth?: Partial<ReturnType<typeof defaultAuth>>;
  expectedEmail?: string | null;
  race?: boolean;
  updateError?: string;
  authError?: boolean;
} = {}) {
  const row = { ...defaultRow(), ...options.row };
  const auth = { ...defaultAuth(), ...options.auth };
  const action = options.action ?? "enable_delivery";
  const calls: { payload?: Record<string, unknown>; filters: Array<[string, string, unknown]>; authReads: number } = {
    filters: [], authReads: 0,
  };
  const accessBefore = [row.subscribed_at, row.cancelled_at, row.access_granted_at];
  const sb = {
    auth: { admin: { getUserById: async () => {
      calls.authReads++;
      return options.authError
        ? { data: null, error: { message: "private provider detail" } }
        : { data: { user: auth }, error: null };
    } } },
    from: (table: string) => {
      assert.equal(table, "users");
      let writing = false;
      const query = {
        select: (_columns: string) => {
          if (!writing) return query;
          if (options.updateError) return Promise.resolve({ data: null, error: { message: options.updateError } });
          if (options.race) return Promise.resolve({ data: [], error: null });
          assert.deepEqual(Object.keys(calls.payload ?? {}), ["delivery_enrolled"]);
          row.delivery_enrolled = calls.payload?.delivery_enrolled as boolean;
          return Promise.resolve({ data: [{ id: userId }], error: null });
        },
        update: (payload: Record<string, unknown>) => {
          writing = true;
          calls.payload = payload;
          return query;
        },
        eq: (field: string, value: unknown) => {
          calls.filters.push(["eq", field, value]);
          return query;
        },
        is: (field: string, value: unknown) => {
          calls.filters.push(["is", field, value]);
          return query;
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return query;
    },
  };
  const body = {
    action,
    userId,
    expectedEmail: options.expectedEmail === null ? undefined : (options.expectedEmail ?? expectedEmail),
  };
  const NextResponse = {
    json: (value: Record<string, unknown>, opts?: { status?: number }) =>
      ({ body: value, status: opts?.status ?? 200 }),
  };
  const result = await runInNewContext(
    `${runnable}\nrun(body, sb, NextResponse, hasReaderAccess, hasUsableReaderProfile, console)`,
    { body, sb, NextResponse, hasReaderAccess, hasUsableReaderProfile, console: { error() {} } },
  ) as { body: Record<string, unknown>; status: number };
  assert.deepEqual(
    [row.subscribed_at, row.cancelled_at, row.access_granted_at],
    accessBefore,
    "an enrollment action must leave reading access unchanged",
  );
  return { result, calls, row };
}

const enabled = await exercise();
assert.equal(enabled.result.status, 200);
assert.equal(enabled.row.delivery_enrolled, true);
assert.equal(enabled.calls.authReads, 1);
for (const field of [
  "email", "updated_at", "delivery_enrolled", "subscribed_at", "cancelled_at", "access_granted_at",
  "unsubscribed_at", "bounced_at", "complained_at", "suppression_cleanup_pending_at",
  "suppression_recovery_token", "suppression_recovery_started_at", "delivery_suppression_cleared_at",
]) {
  assert.ok(enabled.calls.filters.some(([, key]) => key === field), `missing CAS filter: ${field}`);
}
assert.ok(
  enabled.calls.filters.some(([op, field, value]) => op === "eq" && field === "updated_at" && value === "2026-09-02T00:00:00.123456+00:00"),
  "the row fence compares the exact updated_at read above",
);
assert.ok(!enabled.calls.filters.some(([, field]) => field === "topics"), "topics must not be sent as an array filter");

const paused = await exercise({ action: "pause_delivery", row: { delivery_enrolled: true } });
assert.equal(paused.result.status, 200);
assert.equal(paused.row.delivery_enrolled, false);
assert.equal(paused.calls.authReads, 0);
assert.deepEqual(Object.keys(paused.calls.payload ?? {}), ["delivery_enrolled"]);
// Pausing only stops mail. A reader's own concurrent profile edit bumps
// updated_at and must not make the owner's stop action fail.
assert.ok(!paused.calls.filters.some(([, field]) => field === "updated_at"), "pause is not fenced on profile edits");

// A custom topic may contain commas (a live reader has one). Both actions must
// still reach the single-row update without any topics filter.
const commaTopics = ["mental-health", "custom:ai tools launching- especially around sales, marketing, recruiting, productivity"];
for (const action of ["enable_delivery", "pause_delivery"] as const) {
  const comma = await exercise({ action, row: { topics: commaTopics, delivery_enrolled: action === "pause_delivery" } });
  assert.equal(comma.result.status, 200, `${action} must work for a comma topic`);
  assert.ok(!comma.calls.filters.some(([, field]) => field === "topics"));
}

for (const action of ["enable_delivery", "pause_delivery"] as const) {
  const repeated = await exercise({ action, row: { delivery_enrolled: action === "enable_delivery" } });
  assert.equal(repeated.result.status, 200);
  assert.equal(repeated.result.body.alreadySet, true);
  assert.equal(repeated.calls.payload, undefined);
}
assert.equal((await exercise({ expectedEmail: null })).result.status, 400);
assert.equal((await exercise({ expectedEmail: "other@example.test" })).result.status, 409);
assert.equal((await exercise({ row: { subscribed_at: null } })).result.status, 409);

for (const blockedField of [
  "unsubscribed_at", "bounced_at", "complained_at", "suppression_cleanup_pending_at",
  "suppression_recovery_token", "suppression_recovery_started_at",
] as const) {
  const blocked = await exercise({ row: { [blockedField]: "2026-09-01T00:00:00Z" } });
  assert.equal(blocked.result.status, 409, `${blockedField} must block enrollment`);
  assert.equal(blocked.calls.payload, undefined);
}
for (const [auth, code] of [
  [{ email_confirmed_at: null }, "email_unconfirmed"],
  [{ email: "other@example.test" }, "email_mismatch"],
  [{ banned_until: "2099-01-01T00:00:00Z" }, "account_banned"],
  [{ new_email: "other@example.test" }, "email_change_pending"],
  [{ deleted_at: "2026-09-01T00:00:00Z" }, "account_deleted"],
  [{ is_anonymous: true }, "anonymous_account"],
] as const) {
  const blocked = await exercise({ auth });
  assert.equal(blocked.result.status, 409);
  assert.equal(blocked.result.body.code, code);
  assert.equal(blocked.calls.payload, undefined);
}
for (const row of [
  { first_name: null },
  { topics: [] },
  { topics: ["constructor"] },
  { topics: ["zodiac"], birthday: null },
]) {
  const blocked = await exercise({ row });
  assert.equal(blocked.result.status, 409);
  assert.equal(blocked.result.body.code, "signup_incomplete");
  assert.equal(blocked.calls.authReads, 1, "profile checks follow Auth verification");
  assert.equal(blocked.calls.payload, undefined);
}
assert.equal((await exercise({ authError: true })).result.status, 503);
assert.equal((await exercise({ race: true })).result.status, 409);
const leased = await exercise({ updateError: "delivery state change blocked by active provider lease" });
assert.equal(leased.result.status, 409);
assert.match(String(leased.result.body.error), /send is still in progress/);
assert.doesNotMatch(JSON.stringify(leased.result.body), /private provider detail|reader@example.test/);

assert.match(route, /const gate = await requireAdmin\(\)/);
assert.match(route, /rateLimit\(`admin-users-action:\$\{gate\.userId\}`/);
assert.match(route, /await req\.json\(\)/);
assert.match(page, /fetch\("\/api\/admin\/users", \{/);
assert.equal(blocksCsrf("POST", "cross-site", "/api/admin/users"), true);
assert.equal(blocksCsrf("POST", "same-origin", "/api/admin/users"), false);
assert.match(source("../src/worker-entry.ts"), /blocksCsrf\(request\.method, request\.headers\.get\('sec-fetch-site'\), url\.pathname\)/);

console.log("Delivery enrollment admin source contract passed.");
