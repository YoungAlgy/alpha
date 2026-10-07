// Offline GitHub Issue channel contract. All gh calls are local Bash stubs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(root, ".github/workflows/letter-watchdog.yml");
const workflow = load(readFileSync(workflowPath, "utf8"));
const step = workflow.jobs["check-delivery"].steps.find(step => step.run?.includes("COUNTS=$(RESPONSE="));
assert.ok(step?.run, "watchdog delivery script exists");
const script = step.run;
const secretStep = workflow.jobs["check-resilience-secrets"].steps.find(step => step.run?.includes('HARD_MISSING=""'));
assert.ok(secretStep?.run, "watchdog secret-health script exists");
const secretScript = secretStep.run;

for (const [name, jobScript] of [["delivery", script], ["secret health", secretScript]]) {
  assert.match(jobScript, /lookup_open_issue\(\) \{/, name);
  assert.match(jobScript, /gh issue list[\s\S]*?--limit 100[\s\S]*?--json number,title/, name);
  assert.ok(!jobScript.includes("--jq"), `${name}: lookup cannot select an unverified first result`);
  assert.match(jobScript, /if \[ "\$\{ISSUE_CHANNEL_FAILED\}" -ne 0 \]; then[\s\S]*?exit 1/, name);
}
assert.match(script, /node scripts\/alpha-watchdog-issue-selection\.mjs/);
assert.ok(!secretScript.includes("actions/checkout") && !secretScript.includes("alpha-watchdog-issue-selection.mjs"),
  "secret-health Issue lookup remains checkout-independent");

const helper = resolve(root, "scripts/alpha-watchdog-issue-selection.mjs");
const title = "⚠️ Daily letter watchdog timing unverified";
function select(input, expectedTitle = title) {
  return spawnSync(process.execPath, [helper, expectedTitle], {
    cwd: root, input, encoding: "utf8", timeout: 3000, maxBuffer: 131072,
  });
}
for (const [name, input, expected] of [
  ["empty", "[]", ""],
  ["wrong title", JSON.stringify([{ number: 7, title: title + " old" }]), ""],
  ["one exact", JSON.stringify([{ number: 7, title }]), "7"],
  ["exact among other", JSON.stringify([{ number: 6, title: "unrelated" }, { number: 7, title }]), "7"],
]) {
  const result = select(input);
  assert.equal(result.error, undefined, name);
  assert.equal(result.status, 0, name);
  assert.equal(result.stdout, expected, name);
  assert.equal(result.stderr, "", name);
}
for (const [name, input] of [
  ["malformed", "{"],
  ["object", "{}"],
  ["extra field", JSON.stringify([{ number: 7, title, body: "private" }])],
  ["bad number", JSON.stringify([{ number: 0, title }])],
  ["control title", JSON.stringify([{ number: 7, title: "bad\nvalue" }])],
  ["multiple exact", JSON.stringify([{ number: 7, title }, { number: 8, title }])],
  ["capped no exact", JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: "other" })))],
  ["capped exact", JSON.stringify(Array.from({ length: 100 }, (_, index) =>
    ({ number: index + 1, title: index === 99 ? title : "other" })))],
  ["too many", JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ number: index + 1, title: "other" })))],
  ["too large", " ".repeat(65537)],
]) {
  const result = select(input);
  assert.equal(result.error, undefined, name);
  assert.equal(result.status, 2, name);
  assert.equal(result.stdout, "", name);
  assert.equal(result.stderr.trim(), "Watchdog issue lookup response rejected.", name);
}

function extractIssueFunctions(jobScript, name) {
  const functionsStart = jobScript.indexOf("lookup_open_issue() {");
  const functionsEnd = jobScript.indexOf("send_resend_alert() {", functionsStart);
  assert.ok(functionsStart >= 0 && functionsEnd > functionsStart, `${name}: actual Issue helper functions found`);
  return jobScript.slice(functionsStart, functionsEnd);
}
const issueFunctions = extractIssueFunctions(script, "delivery");
const secretIssueFunctions = extractIssueFunctions(secretScript, "secret health");
const baseEnv = Object.fromEntries(["PATH", "SystemRoot", "HOME", "USER", "LANG", "TMPDIR"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]]] : []));
const fixtureDir = mkdtempSync(join(tmpdir(), "alpha-watchdog-issue-channel-"));

function shellCase(name, command, {
  response = "[]", listExit = "0", commentExit = "0", closeExit = "0", createExit = "0",
  cwd = root, functions = issueFunctions, extraEnv = {},
} = {}) {
  const log = join(fixtureDir, `${name}.log`);
  writeFileSync(log, "", "utf8");
  const shell = `set -uo pipefail
set +e
gh() {
  printf '%s\\n' "$*" >> "${log.replaceAll("\\", "/")}"
  case "$1 $2" in
    "issue list") printf '%s' "\${GH_RESPONSE}"; return "\${GH_LIST_EXIT}" ;;
    "issue comment") return "\${GH_COMMENT_EXIT}" ;;
    "issue close") return "\${GH_CLOSE_EXIT}" ;;
    "issue create") return "\${GH_CREATE_EXIT}" ;;
    *) return 97 ;;
  esac
}
curl() { printf 'unexpected curl\\n' >> "${log.replaceAll("\\", "/")}"; return 98; }
send_resend_alert() { printf 'unexpected alert\\n' >> "${log.replaceAll("\\", "/")}"; return 98; }
${functions}
${command}
`;
  const result = spawnSync("bash", ["-c", shell], {
    cwd,
    env: { ...baseEnv, GITHUB_REPOSITORY: "YoungAlgy/alpha", GH_RESPONSE: response,
      GH_LIST_EXIT: listExit, GH_COMMENT_EXIT: commentExit, GH_CLOSE_EXIT: closeExit,
      GH_CREATE_EXIT: createExit, ...extraEnv },
    encoding: "utf8", timeout: 5000, maxBuffer: 16384,
  });
  return { ...result, calls: readFileSync(log, "utf8") };
}

try {
const open = `open_or_update_issue "Daily letter watchdog timing unverified" "${title}" "fixed body"`;
const close = `close_issue_if_open "Daily letter watchdog timing unverified" "${title}" "fixed resolution"`;
let result = shellCase("create", open);
assert.equal(result.status, 0);
assert.match(result.calls, /issue create[\s\S]*--title ⚠️ Daily letter watchdog timing unverified/);

result = shellCase("wrong-title-close", close, { response: JSON.stringify([{ number: 9, title: title + " old" }]) });
assert.equal(result.status, 0);
assert.ok(!result.calls.includes("issue comment") && !result.calls.includes("issue close"));

result = shellCase("wrong-title-open", open, { response: JSON.stringify([{ number: 9, title: title + " old" }]) });
assert.equal(result.status, 0);
assert.match(result.calls, /issue create[\s\S]*--title ⚠️ Daily letter watchdog timing unverified/);
assert.ok(!result.calls.includes("issue comment 9 "));

result = shellCase("exact-update", open, { response: JSON.stringify([{ number: 9, title }]) });
assert.equal(result.status, 0);
assert.match(result.calls, /issue comment 9 /);
assert.ok(!result.calls.includes("issue create"));

result = shellCase("exact-close", close, { response: JSON.stringify([{ number: 9, title }]) });
assert.equal(result.status, 0);
assert.match(result.calls, /issue comment 9 /);
assert.match(result.calls, /issue close 9 /);

for (const [name, options, action = open] of [
  ["list-failure", { listExit: "42" }],
  ["malformed-list", { response: "{" }],
  ["multiple-exact", { response: JSON.stringify([{ number: 9, title }, { number: 10, title }]) }],
  ["capped-no-exact", { response: JSON.stringify(Array.from({ length: 100 }, (_, index) =>
    ({ number: index + 1, title: "other" }))) }],
  ["capped-exact", { response: JSON.stringify(Array.from({ length: 100 }, (_, index) =>
    ({ number: index + 1, title: index === 99 ? title : "other" }))) }],
  ["create-failure", { createExit: "43" }],
  ["comment-failure", { response: JSON.stringify([{ number: 9, title }]), commentExit: "44" }],
  ["close-comment-failure", { response: JSON.stringify([{ number: 9, title }]), commentExit: "45" }, close],
  ["close-failure", { response: JSON.stringify([{ number: 9, title }]), closeExit: "46" }, close],
]) {
  result = shellCase(name, action, options);
  assert.notEqual(result.status, 0, name);
  if (["list-failure", "malformed-list", "multiple-exact", "capped-no-exact", "capped-exact"].includes(name)) {
    assert.ok(!result.calls.includes("issue create") && !result.calls.includes("issue comment") &&
      !result.calls.includes("issue close"), `${name}: no mutation after unsafe lookup`);
  }
}

result = shellCase("helper-missing", open, { cwd: fixtureDir });
assert.notEqual(result.status, 0);
assert.ok(!result.calls.includes("issue create") && !result.calls.includes("issue comment") &&
  !result.calls.includes("issue close"), "missing checkout helper cannot mutate Issues");

const pausedMatch = script.match(/if \[ "\$\{MODE\}" = "paused" \]; then[\s\S]*?exit 0\nfi/);
assert.ok(pausedMatch, "paused success path found");
result = shellCase("paused-close-failure", `MODE=paused
ISSUE_CHANNEL_FAILED=0
SEARCH_PHRASE="Daily letter send may be broken"
ISSUE_TITLE="🚨 Daily letter send may be broken"
PARTIAL_SEARCH_PHRASE="Daily letter send may be incomplete"
PARTIAL_ISSUE_TITLE="⚠️ Daily letter send may be incomplete"
${pausedMatch[0]}`, {
  response: JSON.stringify([{ number: 11, title: "🚨 Daily letter send may be broken" }]), closeExit: "47",
});
assert.notEqual(result.status, 0, "paused success cannot go green after Issue close failure");
assert.match(result.calls, /issue close 11 /, "paused success reached the failing close command");
assert.ok(!result.calls.includes("unexpected curl") && !result.calls.includes("unexpected alert"));

const coveredMatch = script.match(/if \[ "\$\{UNCOVERED_COUNT\}" -eq 0 \]; then[\s\S]*?exit "\$\{TIMING_UNVERIFIED\}"\nfi/);
assert.ok(coveredMatch, "covered success path found");
result = shellCase("covered-close-failure", `UNCOVERED_COUNT=0
ACTIVE_COUNT=1
DELIVERED_COUNT=1
ISSUE_DATE="2026-10-01"
COVERAGE_BASIS="scheduled"
TIMING_UNVERIFIED=0
ISSUE_CHANNEL_FAILED=0
SEARCH_PHRASE="Daily letter issue coverage unverified (2026-10-01)"
ISSUE_TITLE="Daily letter issue coverage unverified (2026-10-01)"
PARTIAL_SEARCH_PHRASE="Daily letter issue coverage incomplete (2026-10-01)"
PARTIAL_ISSUE_TITLE="Daily letter issue coverage incomplete (2026-10-01)"
${coveredMatch[0]}`, {
  response: JSON.stringify([{ number: 12, title: "Daily letter issue coverage unverified (2026-10-01)" }]), closeExit: "48",
});
assert.notEqual(result.status, 0, "covered success cannot go green after Issue close failure");
assert.match(result.calls, /issue close 12 /, "covered success reached the failing close command");
assert.ok(!result.calls.includes("unexpected curl") && !result.calls.includes("unexpected alert"));

const secretTitle = "⚠️ SEND_* secret may be missing in GitHub";
const secretOpen = `open_or_update_issue "SEND_* secret may be missing in GitHub" "${secretTitle}" "fixed body"`;
const secretClose = `close_issue_if_open "SEND_* secret may be missing in GitHub" "${secretTitle}" "fixed resolution"`;

result = shellCase("secret-exact-update", secretOpen, {
  functions: secretIssueFunctions, response: JSON.stringify([{ number: 21, title: secretTitle }]),
});
assert.equal(result.status, 0);
assert.match(result.calls, /issue comment 21 /);
assert.ok(!result.calls.includes("issue create"));

result = shellCase("secret-exact-close", secretClose, {
  functions: secretIssueFunctions, response: JSON.stringify([{ number: 21, title: secretTitle }]),
});
assert.equal(result.status, 0);
assert.match(result.calls, /issue comment 21 /);
assert.match(result.calls, /issue close 21 /);

result = shellCase("secret-wrong-title-open", secretOpen, {
  functions: secretIssueFunctions,
  response: JSON.stringify([{ number: 21, title: secretTitle + " old" }]),
});
assert.equal(result.status, 0);
assert.match(result.calls, /issue create[\s\S]*--title ⚠️ SEND_\* secret may be missing in GitHub/);
assert.ok(!result.calls.includes("issue comment 21 "));

result = shellCase("secret-wrong-title-close", secretClose, {
  functions: secretIssueFunctions,
  response: JSON.stringify([{ number: 21, title: secretTitle + " old" }]),
});
assert.equal(result.status, 0);
assert.ok(!result.calls.includes("issue comment") && !result.calls.includes("issue close"));

for (const [name, options] of [
  ["secret-list-failure", { listExit: "51" }],
  ["secret-malformed", { response: "{" }],
  ["secret-multiple-exact", { response: JSON.stringify([
    { number: 21, title: secretTitle }, { number: 22, title: secretTitle },
  ]) }],
  ["secret-capped-no-exact", { response: JSON.stringify(Array.from({ length: 100 }, (_, index) =>
    ({ number: index + 1, title: "other" }))) }],
  ["secret-capped-exact", { response: JSON.stringify(Array.from({ length: 100 }, (_, index) =>
    ({ number: index + 1, title: index === 99 ? secretTitle : "other" }))) }],
]) {
  result = shellCase(name, secretOpen, { ...options, functions: secretIssueFunctions });
  assert.notEqual(result.status, 0, name);
  assert.ok(!result.calls.includes("issue create") && !result.calls.includes("issue comment") &&
    !result.calls.includes("issue close"), `${name}: no mutation after unsafe lookup`);
}

const secretHealthyMatch = secretScript.match(/SEARCH_PHRASE="SEND_\* secret may be missing in GitHub"[\s\S]*?if \[ -z "\$\{HARD_MISSING\}" \] && \[ -z "\$\{SOFT_MISSING\}" \]; then[\s\S]*?exit 0\nfi/);
assert.ok(secretHealthyMatch, "secret-health success path found");
const healthySecretEnv = Object.fromEntries([
  "SEND_CRON_SECRET", "SEND_RESEND_API_KEY", "SEND_RESEND_FROM", "SEND_UNSUBSCRIBE_SECRET",
  "SEND_SUPABASE_URL", "SEND_SUPABASE_PUBLISHABLE_KEY", "SEND_SUPABASE_SECRET_KEY",
  "SEND_ANTHROPIC_API_KEY", "SEND_GEMINI_API_KEY", "SEND_GROQ_API_KEY", "SEND_DEEPSEEK_API_KEY",
  "SEND_BRAVE_SEARCH_API_KEY", "SEND_YOU_API_KEY", "SEND_ALPHA_OPS_ALERT_WEBHOOK_URL",
].map(name => [name, "fixture"]));
result = shellCase("secret-healthy-close-failure", secretHealthyMatch[0], {
  functions: secretIssueFunctions,
  response: JSON.stringify([{ number: 23, title: secretTitle }]),
  closeExit: "52", extraEnv: healthySecretEnv,
});
assert.notEqual(result.status, 0, "healthy secret check cannot go green after Issue close failure");
assert.match(result.calls, /issue close 23 /, "healthy secret check reached the failing close command");
assert.ok(!result.calls.includes("unexpected curl") && !result.calls.includes("unexpected alert"));
} finally {
  const resolvedFixture = resolve(fixtureDir);
  assert.equal(resolve(dirname(resolvedFixture)), resolve(tmpdir()), "fixture cleanup stays in the temp directory");
  assert.ok(basename(resolvedFixture).startsWith("alpha-watchdog-issue-channel-"),
    "fixture cleanup requires the generated prefix");
  rmSync(resolvedFixture, { recursive: true, force: true });
}
console.log("PASS verify-watchdog-issue-channel (bounded exact selection and fail-closed Issue mutations)");
