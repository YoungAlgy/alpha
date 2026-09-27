#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { checkResendSendReadiness } from "./resend-send-readiness.mjs";

const SENDER = '"alpha." <alpha@everyday.report>';
const PATHS = ["https://api.resend.com/domains", "https://api.resend.com/usage"];
const REASONS = new Set([
  "ready", "capacity_unavailable", "provider_unavailable", "authentication_denied",
  "invalid_response", "unexpected_status", "sender_domain_unverified",
  "usage_unverified", "invalid_settings", "capacity_count_unavailable",
]);

function validDispatch(env) {
  return Number(process.versions.node.split(".")[0]) >= 20 &&
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === "YoungAlgy/alpha" &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/master" &&
    env.RESEND_FROM === SENDER &&
    /^[0-9a-fA-F]{40}$/.test(env.GITHUB_SHA ?? "");
}

/** One-reader contract probe. This is not a full-audience capacity check. */
export async function checkQuotaAccess(env, fetchImpl = fetch) {
  if (!validDispatch(env)) {
    return { status: "blocked", reason: "invalid_context", quotaContractVerified: false };
  }
  let calls = 0;
  const requests = [];
  const boundedFetch = async (url, init) => {
    if (calls >= PATHS.length || url !== PATHS[calls] || init?.method !== "GET" ||
        init?.redirect !== "error" || !(init?.signal instanceof AbortSignal)) {
      throw new Error("unexpected_request");
    }
    calls += 1;
    const response = await fetchImpl(url, init);
    requests.push({
      endpoint: calls === 1 ? "domains" : "usage",
      httpStatus: response instanceof Response ? response.status : null,
    });
    return response;
  };
  const result = await checkResendSendReadiness({
    apiKey: env.RESEND_API_KEY, sender: env.RESEND_FROM, requiredCount: 1,
  }, boundedFetch);
  const reason = result.kind === "ready" ? "ready" : result.reason;
  if (!REASONS.has(reason)) {
    return { status: "blocked", reason: "invalid_response", quotaContractVerified: false };
  }
  const quotaContractVerified = reason === "ready" || reason === "capacity_unavailable";
  return {
    status: quotaContractVerified ? "contract_verified" : result.kind,
    reason,
    quotaContractVerified,
    requests,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkQuotaAccess(process.env);
    console.log(JSON.stringify(result));
    if (!result.quotaContractVerified) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: "blocked", reason: "invalid_response", quotaContractVerified: false }));
    process.exitCode = 1;
  }
}
