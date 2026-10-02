#!/usr/bin/env node
// Offline pure-function fixtures. No service, account, environment or network access.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAX_SEND_SUMMARY_BYTES,
  REDACTED_SEND_SUMMARY,
  projectSendSummary,
  renderSendSummary,
} from "./print-send-summary.mjs";

const privateValues = [
  "reader@example.invalid",
  "11111111-1111-4111-8111-111111111111",
  "PRIVATE_ERROR_DETAIL",
  "PRIVATE_UNKNOWN_VALUE",
];

const input = {
  issueDate: "2026-10-02",
  weekOf: "2026-10-02",
  paidCallBudgetDate: "2026-10-02",
  subscribers: 7,
  sent: 4,
  failed: 1,
  skippedAlreadyDelivered: 2,
  deliveryPageComplete: false,
  deliveryRetryRequired: true,
  deliveryCursorState: "advanced_with_retry",
  backupSharedSentEmails: [privateValues[0]],
  backupFreshSentEmails: [],
  backupStaleSentEmails: [privateValues[0], "second@example.invalid"],
  skippedBlankSubscribers: [privateValues[0]],
  deferred: [privateValues[0]],
  failures: [{ email: privateValues[0], error: privateValues[2] }],
  deliveryCursor: privateValues[1],
  deliveryCursorNext: privateValues[1],
  deliveryPageLastUserId: privateValues[1],
  readerId: privateValues[1],
  paidCallReservationError: privateValues[2],
  suppressionReconciliation: {
    deferredToPostSendMaintenance: true,
    address: privateValues[0],
  },
  privateField: privateValues[3],
  nested: {
    data: privateValues,
    cursor: privateValues[1],
    address: privateValues[0],
    errors: [privateValues[2]],
  },
};

const projected = projectSendSummary(input);
assert.deepEqual(projected, {
  subscribers: 7,
  sent: 4,
  skippedAlreadyDelivered: 2,
  failed: 1,
  deliveryPageComplete: false,
  deliveryRetryRequired: true,
  issueDate: "2026-10-02",
  weekOf: "2026-10-02",
  paidCallBudgetDate: "2026-10-02",
  deliveryCursorState: "advanced_with_retry",
  backupSharedSentEmails: 1,
  backupFreshSentEmails: 0,
  backupStaleSentEmails: 2,
  skippedBlankSubscribers: 1,
  deferred: 1,
  failures: 1,
});

const rendered = renderSendSummary(JSON.stringify(input));
for (const privateValue of privateValues) {
  assert.ok(!rendered.includes(privateValue));
}
assert.ok(!rendered.includes("privateField"));
assert.ok(!rendered.includes('"deliveryCursor":'));
assert.ok(!rendered.includes('"deliveryCursorNext":'));
assert.ok(!rendered.includes('"deliveryPageLastUserId":'));
assert.ok(!rendered.includes('"readerId":'));
assert.ok(!rendered.includes("paidCallReservationError"));
assert.ok(!rendered.includes("suppressionReconciliation"));

const wrongTypes = projectSendSummary({
  sent: "reader@example.invalid",
  failed: -1,
  subscribers: Number.MAX_SAFE_INTEGER + 1,
  deliveryPageComplete: "false",
  deliveryCursorState: "PRIVATE_CURSOR_STATE",
  deferred: { address: "reader@example.invalid" },
  failures: "PRIVATE_ERROR_DETAIL",
  issueDate: "2026-10-02\nPRIVATE_UNKNOWN_VALUE",
  weekOf: "2026-10-02\nreader@example.invalid",
  paidCallBudgetDate: "2026-02-30",
});
assert.deepEqual(wrongTypes, {});

assert.equal(projectSendSummary(null), null);
assert.equal(projectSendSummary([]), null);
assert.equal(renderSendSummary("[]"), REDACTED_SEND_SUMMARY);
assert.equal(renderSendSummary("null"), REDACTED_SEND_SUMMARY);
assert.equal(renderSendSummary("{malformed"), REDACTED_SEND_SUMMARY);

// Missing keys remain missing. The public projection never turns absent
// delivery evidence into a reported zero.
assert.deepEqual(projectSendSummary({ sent: 1 }), { sent: 1 });
assert.ok(!renderSendSummary('{"sent":1}').includes("failed"));

assert.equal(renderSendSummary("{}", 2), "{}");
assert.equal(renderSendSummary("{}", 1), REDACTED_SEND_SUMMARY);
assert.equal(renderSendSummary('"é"', 3), REDACTED_SEND_SUMMARY);
assert.equal(
  renderSendSummary("{}", MAX_SEND_SUMMARY_BYTES),
  "{}"
);

// Exercise the real stdin CLI with generic fixtures. Preserve any parent
// verification flags such as its offline fence, with no application config.
for (const [fixture, expected] of [
  [JSON.stringify(input), rendered],
  ["{malformed", REDACTED_SEND_SUMMARY],
  ["{}" + " ".repeat(MAX_SEND_SUMMARY_BYTES - 2), "{}"],
  ["{}" + " ".repeat(MAX_SEND_SUMMARY_BYTES - 1), REDACTED_SEND_SUMMARY],
]) {
  const cli = spawnSync(process.execPath, [...process.execArgv,
    fileURLToPath(new URL("./print-send-summary.mjs", import.meta.url))], {
    input: fixture, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
    env: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
  });
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, "");
  assert.equal(cli.stdout.trim(), expected);
}

console.log("PASS public send-summary projection keeps only fixed aggregate fields");
