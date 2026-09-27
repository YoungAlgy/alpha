import { readBoundedJson } from "./alpha-preflight-response.mjs";

const API = "https://api.resend.com";
const LIMIT = 65_536;

// Official usage contract: daily/monthly used includes sent and received mail.
// A null daily limit denotes a monthly subscription, outside this free-only gate.
// https://github.com/resend/resend-openapi/blob/main/resend.yaml
// Only read-only checks may select the backup. Nothing here sends a message.
async function get(path, key, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: "GET", headers: { Authorization: `Bearer ${key}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { kind: "unavailable", reason: "provider_unavailable" };
  }
  if (!(response instanceof Response)) return { kind: "blocked", reason: "invalid_response" };
  if (response.status !== 200 || response.redirected) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return { kind: "blocked", reason: "authentication_denied" };
    if (response.status === 429 || response.status >= 500) return { kind: "unavailable", reason: "provider_unavailable" };
    return { kind: "blocked", reason: "unexpected_status" };
  }
  try {
    return { kind: "json", value: await readBoundedJson(response, LIMIT) };
  } catch {
    // A malformed successful response is a contract failure, not an outage.
    return { kind: "blocked", reason: "invalid_response" };
  }
}

export async function checkResendSendReadiness({ apiKey, sender, requiredCount }, fetchImpl = fetch) {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(apiKey) ||
      typeof sender !== "string" || !/^"alpha\." <alpha@everyday\.report>$/.test(sender)) {
    return { kind: "blocked", reason: "invalid_settings" };
  }
  if (!Number.isSafeInteger(requiredCount) || requiredCount < 1) {
    return { kind: "blocked", reason: "capacity_count_unavailable" };
  }
  const domains = await get("/domains", apiKey, fetchImpl);
  if (domains.kind !== "json") return domains;
  if (!Array.isArray(domains.value?.data) ||
      !domains.value.data.some((domain) => domain?.name === "everyday.report" && domain?.status === "verified")) {
    return { kind: "blocked", reason: "sender_domain_unverified" };
  }
  const usage = await get("/usage", apiKey, fetchImpl);
  if (usage.kind !== "json") return usage;
  const windows = [usage.value?.emails?.daily, usage.value?.emails?.monthly];
  if (usage.value?.object !== "usage" || windows.some((window) =>
    !Number.isSafeInteger(window?.used) || window.used < 0 ||
    !Number.isSafeInteger(window?.limit) || window.limit < 0)) {
    // A null daily limit indicates a monthly subscription. This backup is
    // authorized only for a known free-capacity arrangement.
    return { kind: "blocked", reason: "usage_unverified" };
  }
  if (windows.some((window) => window.limit - window.used < requiredCount)) {
    return { kind: "unavailable", reason: "capacity_unavailable" };
  }
  return { kind: "ready" };
}
