import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const policy = read("lib/subscriber-delivery-policy.ts");
const generate = read("app/api/generate/route.ts");
const weekly = read("app/api/cron/weekly-send/route.ts");
const email = read("lib/email.ts");
const writing = read("app/writing/page.tsx");
const workflow = read(".github/workflows/daily-send.yml");
const health = read("app/api/health/route.ts");

assert.match(policy, /SUBSCRIBER_LETTERS_ENABLED:\s*boolean\s*=\s*true/);
assert.match(policy, /INTERACTIVE_LETTERS_ENABLED:\s*boolean\s*=\s*false/);
assert.doesNotMatch(policy, /process\.env/);
const subscriberLettersEnabled = false; // Simulate the literal emergency-pause source state.

const parse = (name: string, source: string) =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(source: string, name: string): ts.FunctionDeclaration {
  const found = parse(`${name}.ts`, source).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assert.ok(found?.body, `production function ${name} must exist`);
  return found;
}
const transpile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function prefixThrough(source: string, name: string, marker: string): string {
  const statements = declaration(source, name).body!.statements;
  const end = statements.findIndex((statement) => statement.getText().includes(marker));
  assert.ok(end >= 0, `${name} must contain ${marker}`);
  return statements.slice(0, end + 1).map((statement) => statement.getText()).join("\n");
}
const responseJson = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  ({ status: init.status ?? 200, headers: init.headers ?? {}, body });

// Execute the exact direct-generation prefix. Later request, provider, and
// persistence dependencies are tripwires.
const generatePrefix = prefixThrough(generate, "POST", "!SUBSCRIBER_LETTERS_ENABLED");
const generateSandbox: Record<string, unknown> = {
  SUBSCRIBER_LETTERS_ENABLED: subscriberLettersEnabled,
  NextResponse: { json: responseJson },
  clientKeyFromRequest() { throw new Error("generation reached request access"); },
  rateLimit() { throw new Error("generation reached rate limiting"); },
  generateIssue() { throw new Error("generation reached provider work"); },
  persistIssueIfPossible() { throw new Error("generation reached persistence"); },
};
vm.runInNewContext(
  transpile(`async function guardedGenerate(req) { ${generatePrefix} }\nthis.guardedGenerate = guardedGenerate;`),
  generateSandbox
);
const guardedGenerate = generateSandbox.guardedGenerate as (req: unknown) => Promise<{ status: number; headers: Record<string, string>; body: { error: string } }>;
const requestTripwire = new Proxy({}, { get() { throw new Error("generation read request before pause"); } });
const generateResult = await guardedGenerate(requestTripwire);
assert.equal(generateResult.status, 503);
assert.equal(generateResult.body.error, "subscriber_delivery_paused");
assert.equal(generateResult.headers["Cache-Control"], "no-store");

// Execute the exact constant-time bearer helper and cron prefix. URL parsing
// and database access remain tripwires after the pause.
const bearerSource = declaration(weekly, "bearerMatches").getText();
const cronPrefix = prefixThrough(weekly, "GET", "!SUBSCRIBER_LETTERS_ENABLED");
const cronSandbox: Record<string, unknown> = {
  crypto,
  process: { env: { CRON_SECRET: "cron-secret" } },
  SUBSCRIBER_LETTERS_ENABLED: subscriberLettersEnabled,
  NextResponse: { json: responseJson },
  console: { warn() {} },
  supabaseServiceClient() { throw new Error("cron reached database work"); },
  URL: class { constructor() { throw new Error("cron parsed work parameters"); } },
};
vm.runInNewContext(
  transpile(`${bearerSource}\nasync function guardedCron(req) { ${cronPrefix} }\nthis.guardedCron = guardedCron;`),
  cronSandbox
);
const guardedCron = cronSandbox.guardedCron as (req: unknown) => Promise<{ status: number; body: { paused?: boolean; error?: string; reason?: string } }>;
const cronRequest = (authorization: string | null, url: string) => ({
  url,
  headers: { get: (name: string) => name === "authorization" ? authorization : null },
});
for (const authorization of [null, "Bearer wrong"]) {
  const result = await guardedCron(cronRequest(authorization, "https://local.invalid/?force=1&weekOf=2099-01-01"));
  assert.equal(result.status, 401);
  assert.equal(result.body.error, "Unauthorized");
}
for (const url of [
  "https://local.invalid/",
  "https://local.invalid/?weekOf=2026-09-04",
  "https://local.invalid/?force=1&userId=00000000-0000-0000-0000-000000000000",
]) {
  const result = await guardedCron(cronRequest("Bearer cron-secret", url));
  assert.equal(result.status, 200);
  assert.equal(result.body.paused, true);
  assert.equal(result.body.reason, "subscriber_delivery_paused");
}

// Execute the exact common subscriber sender with every provider dependency
// replaced by a throwing tripwire.
const senderSource = declaration(email, "sendPreparedSubscriberEmail").getText();
const senderSandbox: Record<string, unknown> = {
  exports: {},
  SUBSCRIBER_LETTERS_ENABLED: subscriberLettersEnabled,
  resendConfiguredInternal() { throw new Error("sender checked provider configuration"); },
  retryResendCall() { throw new Error("sender entered provider retry"); },
  resendClient() { throw new Error("sender reached provider client"); },
  resendSendOptions() { throw new Error("sender prepared provider options"); },
  requireResendMessageId() { throw new Error("sender inspected provider result"); },
};
vm.runInNewContext(transpile(`${senderSource}\nthis.sender = sendPreparedSubscriberEmail;`), senderSandbox);
const sendPrepared = senderSandbox.sender as (prepared: unknown) => Promise<unknown>;
await assert.rejects(() => sendPrepared({}), /Subscriber letters are paused/);

// Ops alerts remain a separate function and do not consult or call subscriber
// delivery code.
const opsStart = email.indexOf("export async function sendOpsAlert(");
const opsEnd = email.indexOf("async function sendOpsAlertViaResend", opsStart);
assert.ok(opsStart >= 0 && opsEnd > opsStart);
const opsSource = email.slice(opsStart, opsEnd);
assert.doesNotMatch(opsSource, /SUBSCRIBER_LETTERS_ENABLED|sendPreparedSubscriberEmail/);

// Execute the exact writing pause branch. It clears existing animation timers,
// sets the paused UI, and returns. Retry, new timers, and navigation are tripwires.
const writingFile = parse("writing.tsx", writing);
let pauseBranch: ts.IfStatement | undefined;
function findPause(node: ts.Node): void {
  if (ts.isIfStatement(node) && node.expression.getText().includes('failure?.error === "subscriber_delivery_paused"')) pauseBranch = node;
  ts.forEachChild(node, findPause);
}
findPause(writingFile);
assert.ok(pauseBranch, "writing pause branch must exist");
const writingCalls: string[] = [];
const writingSandbox: Record<string, unknown> = {
  clearInterval() { writingCalls.push("clearInterval"); },
  clearTimeout() { writingCalls.push("clearTimeout"); },
  setDeliveryPaused(value: boolean) { writingCalls.push(`setDeliveryPaused:${value}`); },
  setError(value: string) { writingCalls.push(`setError:${value}`); },
  setTimeout() { throw new Error("writing scheduled retry while paused"); },
  attemptGenerate() { throw new Error("writing retried while paused"); },
  router: { push() { throw new Error("writing navigated while paused"); } },
  stepTimer: 1,
  escapeTimer: 2,
};
vm.runInNewContext(
  transpile(`function handlePaused(r, failure) { ${pauseBranch!.getText()} throw new Error("pause branch fell through"); }\nthis.handlePaused = handlePaused;`),
  writingSandbox
);
const handlePaused = writingSandbox.handlePaused as (r: unknown, failure: unknown) => void;
handlePaused({ status: 503 }, { error: "subscriber_delivery_paused", message: "paused" });
assert.deepEqual(writingCalls, ["clearInterval", "clearTimeout", "setDeliveryPaused:true", "setError:paused"]);

assert.match(health, /subscriberDeliveryMode:\s*SUBSCRIBER_LETTERS_ENABLED \? "open" : "paused"/);
assert.match(workflow, /jobs:\s+send:[\s\S]{0,300}if:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\s*\}\}/);
console.log("PASS verify-subscriber-delivery-pause (executed production route prefixes, bearer guard, sender backstop, and writing pause branch)");
