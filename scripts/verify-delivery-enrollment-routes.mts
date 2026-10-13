// Offline execution of production gate statements. No env or providers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { hasReaderAccess } from "../lib/access.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const cron = read("../app/api/cron/weekly-send/route.ts");
const generate = read("../app/api/generate/route.ts");
const parse = (source: string) => ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
function findIf(source: string, condition: string) {
  let found: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText().includes(condition)) found ??= node;
    ts.forEachChild(node, visit);
  }
  visit(parse(source));
  assert.ok(found, condition);
  return found.getText();
}
function findVariableStatement(source: string, variableName: string) {
  const parsedSource = parse(source);
  let found: ts.VariableStatement | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === variableName,
      )
    ) {
      found ??= node;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsedSource);
  assert.ok(found, variableName);
  return found.getText(parsedSource);
}
const json = (body: unknown, init: { status?: number } = {}) => ({ body, status: init.status ?? 200 });
function run(statement: string, context: Record<string, unknown> = {}) {
  const output = ts.transpileModule(`(function() { ${statement}\n return "allowed"; })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(output, { NextResponse: { json }, ...context });
}

// Cloudflare interactive generation stays paused even when the daily sender opens.
for (const global of [false, true]) {
  const result = run(findIf(generate, "!SUBSCRIBER_LETTERS_ENABLED"), {
    SUBSCRIBER_LETTERS_ENABLED: global, INTERACTIVE_LETTERS_ENABLED: false,
  });
  assert.equal(result.status, 503);
}
const override = findIf(cron, 'url.searchParams.has("weekOf")');
for (const query of ["weekOf=2026-09-24", "weekOf=", "force=1"]) {
  assert.equal(run(override, { url: new URL(`https://fixture.invalid/?${query}`) }).status, 403);
}
assert.equal(run(override, { url: new URL("https://fixture.invalid/") }), "allowed");

// Execute the actual fresh-row branch with no provider dependency in the sandbox.
const freshGate = findIf(cron, "freshUserErr || !freshUser");
const markDeliverySettled = findVariableStatement(cron, "markDeliverySettled");
const eligible = {
  email: "reader@fixture.invalid", delivery_enrolled: true,
  subscribed_at: "2026-01-01T00:00:00Z", access_granted_at: "2026-01-01T00:00:00Z",
  cancelled_at: null, unsubscribed_at: null, bounced_at: null, complained_at: null,
  suppression_cleanup_pending_at: null, brevo_unsubscribed_at: null,
};
function checkFresh(row: unknown, error: unknown = null, brevoSchemaEnabled = true) {
  const deliveryRow = { id: "245fb183-0d73-4a57-bf17-38bd57e37fb6" };
  const deliverySettledUserIds = new Set<string>();
  const deliveryRetryRequiredUserIds = new Set<string>([deliveryRow.id]);
  const outcome = run(`${markDeliverySettled}\n${freshGate}`, {
    freshUser: row, freshUserErr: error, hasReaderAccess,
    BREVO_DELIVERY_SCHEMA_ENABLED: brevoSchemaEnabled,
    eligibilityRecheckFailures: 0, unenrolledMidRunSkips: 0,
    unsubscribedMidRunSkips: 0, cancelledMidRunSkips: 0, suppressedMidRunSkips: 0,
    row: deliveryRow, deliverySettledUserIds, deliveryRetryRequiredUserIds,
    console: { warn() {}, log() {} },
  });
  return {
    outcome,
    settled: deliverySettledUserIds.has(deliveryRow.id),
    retryRequired: deliveryRetryRequiredUserIds.has(deliveryRow.id),
  };
}
function assertFresh(
  row: unknown,
  expectedOutcome: "allowed" | "settled" | "retry-required",
  error: unknown = null,
  brevoSchemaEnabled = true,
) {
  const result = checkFresh(row, error, brevoSchemaEnabled);
  assert.equal(result.outcome, expectedOutcome);
  assert.equal(result.settled, expectedOutcome === "settled");
  assert.equal(result.retryRequired, expectedOutcome !== "settled");
}
assertFresh(eligible, "allowed");
for (const flag of [false, undefined, null, "true", 1]) {
  assertFresh({ ...eligible, delivery_enrolled: flag }, "settled");
}
assertFresh(null, "retry-required");
assertFresh(eligible, "retry-required", { message: "fixture unavailable" });
for (const key of ["unsubscribed_at", "brevo_unsubscribed_at", "bounced_at", "complained_at", "suppression_cleanup_pending_at"]) {
  assertFresh({ ...eligible, [key]: "2026-01-02T00:00:00Z" }, "settled");
}
assertFresh({ ...eligible, brevo_unsubscribed_at: "2026-01-02T00:00:00Z" }, "allowed", null, false);
assertFresh({ ...eligible, subscribed_at: null }, "settled");
assertFresh({ ...eligible, email: null }, "retry-required");

// The first population query filters before provider/generation work. The fresh
// row read must include the flag, and the DB locked claim is the final backstop.
const pageStart = cron.indexOf("const fetchSubscriberPage =");
const pageEnd = cron.indexOf("const rows:", pageStart);
assert.match(cron.slice(pageStart, pageEnd), /\.eq\("delivery_enrolled", true\)/);
assert.match(cron, /"email, delivery_enrolled, subscribed_at/);
assert.match(generate, /enrollment\?\.delivery_enrolled !== true/);
assert.ok(generate.indexOf('error: "delivery_not_enabled"') < generate.indexOf("let activeCheckoutClaim:"));
assert.match(generate, /deliveryUser\.delivery_enrolled === true/);
const migration = read("../supabase/migrations/20260924000000_delivery_enrollment.sql");
assert.ok(migration.indexOf("or not v_user.delivery_enrolled") < migration.indexOf("insert into public.resend_delivery_attempts"));
assert.doesNotMatch(migration, /create policy|drop policy/);
console.log("PASS delivery enrollment route gates, interactive hold and current-issue-only rollout");
