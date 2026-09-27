// Exact-reader manual workflow adapter. No environment loader or provider API.
// Responses and request identifiers stay private. Only fixed outcomes are logged.
import { pathToFileURL } from "node:url";
import { readBoundedJson } from "./alpha-preflight-response.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENDPOINT = "http://localhost:3100/api/cron/weekly-send";

export function validateSendScope(env) {
  const operation = env.ALPHA_SEND_OPERATION;
  const target = env.ALPHA_CANARY_USER_ID || "";
  if (operation === "daily" && target === "" &&
      ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)) {
    return { ok: true, canary: false };
  }
  if (operation !== "brevo_canary" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      !UUID.test(target)) return { ok: false, reason: "invalid_send_scope" };
  return { ok: true, canary: true, userId: target.toLowerCase() };
}

export function acceptedCanarySummary(value) {
  if (!value || value.canary !== true || value.canaryProvider !== "brevo" ||
      value.canarySent !== true || value.subscribers !== 1 || value.sent !== 1 ||
      value.backupSharedSent !== 0 || value.backupFreshSent !== 0 || value.backupStaleSent !== 0 ||
      value.deliveryRetryRequired !== false || value.deliveryRetryRequiredTotal !== 0 ||
      value.deliveryHasMore !== false || value.deliveryCursorAdvanceFailed !== false ||
      value.checkoutRetentionErrors !== 0) return false;
  return true;
}

export async function runBrevoCanary(env, fetchImpl = fetch) {
  const scope = validateSendScope(env);
  if (!scope.ok || !scope.canary || env.ALPHA_BREVO_CANARY_MODE !== "1" ||
      env.GITHUB_ACTIONS !== "true" ||
      env.ALPHA_SUBSCRIBER_EMAIL_PROVIDER !== "resend" ||
      env.ALPHA_NO_MODEL_MODE !== "1" || env.ALPHA_ALLOW_PAID_AI !== "0" ||
      typeof env.CRON_SECRET !== "string" || !env.CRON_SECRET.trim()) {
    return { ok: false, reason: "invalid_canary_configuration" };
  }
  const url = new URL(ENDPOINT);
  url.searchParams.set("canaryUserId", scope.userId);
  url.searchParams.set("canaryProvider", "brevo");
  try {
    // Never retry an uncertain response. The durable ledger is authoritative.
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.CRON_SECRET}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(1_500_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "canary_not_accepted" };
    }
    const summary = await readBoundedJson(response, 65_536);
    if (!acceptedCanarySummary(summary)) return { ok: false, reason: "canary_result_unverified" };
    return { ok: true, reason: "one_brevo_acceptance_confirmed" };
  } catch {
    return { ok: false, reason: "canary_result_unverified" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--validate") {
    const scope = validateSendScope(process.env);
    console.log(scope.ok ? "Send scope validated." : "::error::Invalid send scope. Values withheld.");
    process.exitCode = scope.ok ? 0 : 1;
  } else if (args.length === 0) {
    const result = await runBrevoCanary(process.env);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } else {
    console.error("::error::Unsupported canary arguments.");
    process.exitCode = 1;
  }
}
