// Read-only, bounded checks for the optional daily-send Brevo provider.
// Responses can contain account identity. Only fixed reason codes leave here.
// Contracts: https://developers.brevo.com/reference/get-account
// https://developers.brevo.com/reference/get-senders
// https://developers.brevo.com/reference/get-domain-configuration
import { readBoundedJson } from "./alpha-preflight-response.mjs";

const API = "https://api.brevo.com";
const DOMAIN = "backup.alpha.everyday.report";
const RESPONSE_LIMIT = 65_536;

export function validateBrevoSendSettings({ apiKey, sender, webhookToken, expectedAccountEmail }) {
  if (typeof apiKey !== "string" || !/^xkeysib-[A-Za-z0-9_-]{20,256}$/.test(apiKey)) {
    return "invalid_api_key";
  }
  if (typeof sender !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@backup\.alpha\.everyday\.report$/.test(sender) ||
      sender.includes("..")) {
    return "invalid_sender";
  }
  if (typeof webhookToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookToken)) {
    return "invalid_webhook_token";
  }
  if (typeof expectedAccountEmail !== "string" ||
      expectedAccountEmail.length > 254 ||
      expectedAccountEmail !== expectedAccountEmail.trim().toLowerCase() ||
      !/^[^\s@]{1,64}@[a-z0-9.-]{3,189}$/.test(expectedAccountEmail) ||
      expectedAccountEmail.includes("..")) {
    return "invalid_account_identity";
  }
  return null;
}

async function getReadinessJson(path, apiKey, fetchImpl) {
  const response = await fetchImpl(`${API}${path}`, {
    method: "GET",
    headers: { "api-key": apiKey, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.status !== 200) return null;
  return readBoundedJson(response, RESPONSE_LIMIT);
}

export async function checkBrevoSendReadiness(settings, fetchImpl = fetch, requiredCredits = 1) {
  if (!Number.isSafeInteger(requiredCredits) || requiredCredits < 1) {
    return { ready: false, reason: "capacity_count_unavailable" };
  }
  const configurationError = validateBrevoSendSettings(settings);
  if (configurationError) return { ready: false, reason: configurationError };
  if (typeof fetchImpl !== "function") return { ready: false, reason: "transport_missing" };
  try {
    const account = await getReadinessJson("/v3/account", settings.apiKey, fetchImpl);
    if (!account || account.companyName !== "Alpha" ||
        account.email !== settings.expectedAccountEmail ||
        account.relay?.enabled !== true) {
      return { ready: false, reason: "account_relay_unavailable" };
    }
    // This backup is authorized only on the displayed free email allowance.
    // credits means remaining credits, not a fixed daily limit. The account
    // API is a point-in-time check, not a capacity reservation.
    // https://github.com/getbrevo/brevo-java/blob/master/docs/GetAccountPlan.md
    const plans = account.plan;
    const freeEmail = Array.isArray(plans)
      ? plans.filter((plan) => plan?.type === "free" && plan?.creditsType === "sendLimit")
      : [];
    if (freeEmail.length !== 1 ||
        !Number.isSafeInteger(freeEmail[0].credits) || freeEmail[0].credits < requiredCredits ||
        !plans.every((plan) => plan?.type === "sms" ||
          (plan?.type === "free" && plan?.creditsType === "sendLimit"))) {
      return { ready: false, reason: "free_capacity_unavailable" };
    }
    const senderList = await getReadinessJson(
      `/v3/senders?domain=${encodeURIComponent(DOMAIN)}`,
      settings.apiKey,
      fetchImpl
    );
    if (!senderList || !Array.isArray(senderList.senders) ||
        !senderList.senders.some((item) => item?.email === settings.sender && item?.active === true)) {
      return { ready: false, reason: "sender_unavailable" };
    }
    const domain = await getReadinessJson(
      `/v3/senders/domains/${encodeURIComponent(DOMAIN)}`,
      settings.apiKey,
      fetchImpl
    );
    if (!domain || domain.domain !== DOMAIN || domain.verified !== true || domain.authenticated !== true) {
      return { ready: false, reason: "domain_unverified" };
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: "readiness_unavailable" };
  }
}
