import assertBase from "node:assert/strict";
import {
  approvedWorkflowFailureWebhook,
  notifyAlphaWorkflowFailure,
  workflowFailurePayload,
  WORKFLOW_FAILURE_ALERT_TIMEOUT_MS,
  WORKFLOW_FAILURE_STAGES,
} from "./alpha-workflow-failure-alert.mjs";

const endpoint = "https://discord.com/api/webhooks/123456789012345678/FakeToken_abc-123";
let assertionCount = 0;
const assert = new Proxy(assertBase, {
  get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    return (...args) => {
      assertionCount += 1;
      return Reflect.apply(value, target, args);
    };
  },
});

function validEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    ALPHA_WORKFLOW_EVENT: "schedule",
    ALPHA_WORKFLOW_REPOSITORY: "YoungAlgy/alpha",
    ALPHA_SEND_OPERATION: "daily",
    ALPHA_WORKFLOW_RUN_ID: "1234567890",
    ALPHA_WORKFLOW_RUN_ATTEMPT: "2",
    ALPHA_WORKFLOW_ISSUE_DATE: "2026-10-18",
    ALPHA_STEP_BUILD: "failure",
    ALPHA_OPS_ALERT_WEBHOOK_URL: endpoint,
    ...overrides,
  };
}

function responseWithStatus(status) {
  return { status };
}

async function main() {
  assert.equal(WORKFLOW_FAILURE_ALERT_TIMEOUT_MS, 5_000);
  assert.deepEqual(WORKFLOW_FAILURE_STAGES[0], ["CHECKOUT", "checkout"]);

  let calls = [];
  const accepted = await notifyAlphaWorkflowFailure(validEnv(), async (...args) => {
    calls.push(args);
    return responseWithStatus(204);
  });
  assert.equal(accepted, "accepted");
  assert.equal(calls.length, 1, "a successful notification sends exactly one POST");
  const [url, options] = calls[0];
  assert.equal(url, endpoint);
  assert.equal(options.method, "POST");
  assert.deepEqual(options.headers, { "Content-Type": "application/json" });
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  assert.equal(options.signal.aborted, false);
  assert.equal(options.signal.reason?.name, undefined);
  assert.equal(options.signal.constructor.name, "AbortSignal");
  assert.deepEqual(JSON.parse(options.body).allowed_mentions, {
    parse: [], users: [], roles: [], replied_user: false,
  });
  assert.equal(JSON.parse(options.body).content.includes("Stage: production-build"), true);

  let statusReads = 0;
  const unexpectedResponseReads = [];
  const unreadableResponse = new Proxy({
    then: undefined,
    get body() { throw new Error("body must not be read"); },
    get text() { throw new Error("text must not be read"); },
    get json() { throw new Error("json must not be read"); },
  }, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      if (property === "status") {
        statusReads += 1;
        return 204;
      }
      unexpectedResponseReads.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  calls = [];
  const unreadableResult = await notifyAlphaWorkflowFailure(validEnv(), async (...args) => {
    calls.push(args);
    return unreadableResponse;
  });
  assert.equal(unreadableResult, "accepted", unexpectedResponseReads.join(","));
  assert.equal(calls.length, 1);
  assert.equal(statusReads, 3);

  for (const badUrl of [
    "http://discord.com/api/webhooks/123/Token",
    "https://notdiscord.com/api/webhooks/123/Token",
    "https://discord.com.evil.test/api/webhooks/123/Token",
    "https://user@discord.com/api/webhooks/123/Token",
    "https://user:pass@discord.com/api/webhooks/123/Token",
    "https://discord.com/api/webhooks/123/Token?x=1",
    "https://discord.com/api/webhooks/123/Token#frag",
    "https://discord.com:443/api/webhooks/123/Token",
    "https://discord.com:444/api/webhooks/123/Token",
    "https://discord.com/other/123/Token",
    "https://discord.com/api/webhooks/123/Token%2Fextra",
    "https://discord.com/api/webhooks/123/%54oken",
    "https://discord.com/api//webhooks/123/Token",
    " https://discord.com/api/webhooks/123/Token",
  ]) {
    assert.equal(approvedWorkflowFailureWebhook(badUrl), false, `reject ${badUrl}`);
  }
  assert.equal(approvedWorkflowFailureWebhook(endpoint), true);
  assert.equal(approvedWorkflowFailureWebhook("x".repeat(513)), false);

  const noDatePayload = workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_ISSUE_DATE: "" }));
  assert.match(noDatePayload.content, /Issue date: unavailable/);
  assert.match(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_ISSUE_DATE: undefined })).content,
    /Issue date: unavailable/);

  const priority = workflowFailurePayload(validEnv({
    ALPHA_STEP_CHECKOUT: "failure",
    ALPHA_STEP_WINDOW: "failure",
    ALPHA_STEP_BUILD: "failure",
  }));
  assert.match(priority.content, /Stage: checkout/);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_ISSUE_DATE: "2026-02-30" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_ISSUE_DATE: "10/18/2026" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_RUN_ID: "0" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_RUN_ID: "1/other" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_RUN_ATTEMPT: "0" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_WORKFLOW_RUN_ATTEMPT: "1.5" })), null);

  for (const invalidContext of [
    { GITHUB_ACTIONS: "false" },
    { ALPHA_WORKFLOW_EVENT: "workflow_dispatch" },
    { ALPHA_WORKFLOW_REPOSITORY: "other/repo" },
    { ALPHA_SEND_OPERATION: "weekly" },
    { ALPHA_ROUTE_ATTEMPTED: "true" },
    { ALPHA_STEP_BUILD: "unknown" },
  ]) {
    assert.equal(workflowFailurePayload(validEnv(invalidContext)), null);
  }
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_STEP_BUILD: "success" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_STEP_BUILD: "cancelled" })), null);
  assert.equal(workflowFailurePayload(validEnv({ ALPHA_STEP_BUILD: "skipped" })), null);

  calls = [];
  const invalidsNoAttempt = [
    validEnv({ ALPHA_WORKFLOW_RUN_ID: "bad" }),
    validEnv({ ALPHA_WORKFLOW_ISSUE_DATE: "2026-02-30" }),
    validEnv({ ALPHA_STEP_BUILD: "success" }),
    validEnv({ ALPHA_ROUTE_ATTEMPTED: "yes" }),
    validEnv({ ALPHA_WORKFLOW_EVENT: "workflow_dispatch" }),
    validEnv({ ALPHA_OPS_ALERT_WEBHOOK_URL: "javascript:alert(1)" }),
  ];
  for (const env of invalidsNoAttempt) {
    const result = await notifyAlphaWorkflowFailure(env, async (...args) => {
      calls.push(args);
      return responseWithStatus(204);
    });
    assert.notEqual(result, "accepted");
  }
  assert.equal(calls.length, 0, "invalid context, no failed step, or bad webhook makes zero requests");
  assert.equal(await notifyAlphaWorkflowFailure(validEnv({ ALPHA_OPS_ALERT_WEBHOOK_URL: "" }), async () => {
    throw new Error("must not call fetch");
  }), "skipped-not-configured");

  const secretLookingValues = ["EXTRA_API_KEY", "EXTRA_LOG_LINE", "EXTRA_CREDENTIALS"];
  const secretEnv = validEnv({
    EXTRA_API_KEY: "secret-key-marker",
    EXTRA_LOG_LINE: "private-log-marker",
    EXTRA_CREDENTIALS: "credential-marker",
  });
  const secretPayload = workflowFailurePayload(secretEnv);
  for (const key of secretLookingValues) assert.equal(key in secretPayload, false);
  for (const marker of ["secret-key-marker", "private-log-marker", "credential-marker"])
    assert.equal(JSON.stringify(secretPayload).includes(marker), false);
  let receivedBody;
  await notifyAlphaWorkflowFailure(secretEnv, async (_url, opts) => {
    receivedBody = opts.body;
    return responseWithStatus(204);
  });
  for (const marker of ["secret-key-marker", "private-log-marker", "credential-marker"])
    assert.equal(receivedBody.includes(marker), false);

  for (const status of [302, 429, 500]) {
    calls = [];
    const result = await notifyAlphaWorkflowFailure(validEnv(), async (...args) => {
      calls.push(args);
      return responseWithStatus(status);
    });
    assert.equal(result, "not-accepted");
    assert.equal(calls.length, 1, `HTTP ${status} gets one attempt and no retry`);
  }
  calls = [];
  assert.equal(await notifyAlphaWorkflowFailure(validEnv(), async (...args) => {
    calls.push(args);
    throw new Error("secret endpoint/error must stay hidden");
  }), "unavailable-no-retry");
  assert.equal(calls.length, 1, "thrown fetch gets one attempt and no retry");

  console.log(`workflow failure alert verifier: ${assertionCount} assertions passed`);
}

await main();
