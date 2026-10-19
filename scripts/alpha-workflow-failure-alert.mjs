// Dependency-free source for the workflow's checked inline mirror. No I/O on
// import. Kept inline at runtime so even a checkout failure can be reported.
// This reports pre-request workflow failure, never recipient delivery failure.
export const WORKFLOW_FAILURE_ALERT_TIMEOUT_MS = 5_000;

export const WORKFLOW_FAILURE_STAGES = Object.freeze([
  ["CHECKOUT", "checkout"],
  ["WINDOW", "issue-window"],
  ["PRECHECK", "coverage-precheck"],
  ["SETUP", "node-setup"],
  ["SCOPE", "scope-validation"],
  ["PREFLIGHT", "provider-readiness"],
  ["INSTALL", "dependency-install"],
  ["BUILD_ENV", "build-configuration"],
  ["CACHE", "build-cache"],
  ["BUILD", "production-build"],
  ["DELIVERY", "server-startup"],
].map((stage) => Object.freeze(stage)));

export function approvedWorkflowFailureWebhook(value) {
  if (typeof value !== "string" || value.length > 512 || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "discord.com" &&
      url.port === "" && url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "" &&
      /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname) &&
      // Reject URL normalization tricks, including escaped path delimiters.
      value === url.href;
  } catch {
    return false;
  }
}

function pinnedIssueDate(value) {
  if (value === "" || value === undefined) return "unavailable";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value
    ? value : null;
}

export function workflowFailurePayload(env) {
  try {
    if (!env || env.GITHUB_ACTIONS !== "true" ||
      env.ALPHA_WORKFLOW_EVENT !== "schedule" ||
      env.ALPHA_WORKFLOW_REPOSITORY !== "YoungAlgy/alpha" ||
      env.ALPHA_SEND_OPERATION !== "daily" ||
      !["", undefined].includes(env.ALPHA_ROUTE_ATTEMPTED)) return null;
    const runId = env.ALPHA_WORKFLOW_RUN_ID;
    const attempt = env.ALPHA_WORKFLOW_RUN_ATTEMPT;
    if (typeof runId !== "string" || !/^[1-9]\d{0,19}$/.test(runId) ||
      typeof attempt !== "string" || !/^[1-9]\d{0,5}$/.test(attempt)) return null;
    const issueDate = pinnedIssueDate(env.ALPHA_WORKFLOW_ISSUE_DATE);
    if (issueDate === null) return null;
    let failedStage;
    for (const [key, label] of WORKFLOW_FAILURE_STAGES) {
      const outcome = env[`ALPHA_STEP_${key}`];
      if (![undefined, "", "success", "failure", "cancelled", "skipped"].includes(outcome)) return null;
      if (!failedStage && outcome === "failure") failedStage = label;
    }
    // No observed failed step means there is no pre-request failure to report.
    if (!failedStage) return null;
    return {
      content: "[Alpha scheduled workflow stopped before delivery request]\n" +
        `Issue date: ${issueDate}\nStage: ${failedStage}\nAttempt: ${attempt}\n` +
        `https://github.com/YoungAlgy/alpha/actions/runs/${runId}\n` +
        "Other runs may already cover this issue. Do not resend from this notice.",
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    };
  } catch {
    return null;
  }
}

export async function notifyAlphaWorkflowFailure(env, fetchFn = globalThis.fetch) {
  // Every result is fixed text. Never expose a caught error, URL or body.
  try {
    const payload = workflowFailurePayload(env);
    if (!payload) return "skipped-invalid-or-post-request-context";
    const endpoint = env.ALPHA_OPS_ALERT_WEBHOOK_URL;
    if (endpoint === "" || endpoint === undefined) return "skipped-not-configured";
    if (!approvedWorkflowFailureWebhook(endpoint)) return "blocked-endpoint";
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(WORKFLOW_FAILURE_ALERT_TIMEOUT_MS),
    });
    // Headers alone classify HTTP acceptance. Never inspect the body. The
    // same five-second abort signal also bounds an unread response stream.
    return Number.isInteger(response.status) && response.status >= 200 && response.status < 300
      ? "accepted" : "not-accepted";
  } catch {
    // A failed/uncertain POST is never retried, including a timeout.
    return "unavailable-no-retry";
  }
}
