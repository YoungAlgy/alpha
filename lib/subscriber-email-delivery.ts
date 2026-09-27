import { resendConfigured, sendPreparedSubscriberEmail } from "./email";
import { SUBSCRIBER_LETTERS_ENABLED } from "./subscriber-delivery-policy";
import { BREVO_CANARY_DELIVERY_ENABLED, BREVO_DELIVERY_SCHEMA_ENABLED, BREVO_SUBSCRIBER_DELIVERY_ENABLED } from "./brevo-delivery-policy";
import {
  routeSubscriberLetter, subscriberDeliveryConfigured,
  type SubscriberDeliveryConfig, type SubscriberLetterDeliveryParams,
} from "./subscriber-email-router";

function deliveryConfig(canary = false): SubscriberDeliveryConfig {
  return {
    lettersEnabled: SUBSCRIBER_LETTERS_ENABLED,
    schemaEnabled: BREVO_DELIVERY_SCHEMA_ENABLED,
    brevoEnabled: canary ? BREVO_CANARY_DELIVERY_ENABLED : BREVO_SUBSCRIBER_DELIVERY_ENABLED,
    preferredProvider: process.env.ALPHA_SUBSCRIBER_EMAIL_PROVIDER?.trim() || "resend",
    resendReady: resendConfigured(),
    brevoApiKey: process.env.BREVO_API_KEY?.trim() || "",
    brevoSender: process.env.BREVO_FROM_EMAIL?.trim() || "",
    brevoWebhookReady: /^[A-Za-z0-9_-]{32,256}$/.test(process.env.BREVO_WEBHOOK_TOKEN || ""),
  };
}

export function subscriberEmailConfigured(canary?: "brevo_canary"): boolean {
  const config = deliveryConfig(canary === "brevo_canary");
  return subscriberDeliveryConfigured(canary ? { ...config, preferredProvider: "brevo" } : config);
}

export function subscriberEmailStatus(): {
  configured: boolean;
  provider: "resend" | "brevo" | "none";
} {
  // Health describes transport configuration. The public delivery-mode field
  // separately reports an intentional subscriber pause.
  const config = { ...deliveryConfig(), lettersEnabled: true };
  const configured = subscriberDeliveryConfigured(config);
  const preferred = config.schemaEnabled ? config.preferredProvider : "resend";
  return {
    configured,
    provider: configured && (preferred === "resend" || preferred === "brevo") ? preferred : "none",
  };
}

export async function sendPreparedSubscriberLetter(
  params: SubscriberLetterDeliveryParams,
  canary?: "brevo_canary",
) {
  const config = deliveryConfig(canary === "brevo_canary");
  return routeSubscriberLetter(canary ? { ...params, requireProvider: "brevo" } : params, {
    config: canary ? { ...config, preferredProvider: "brevo" } : config,
    sendResend: sendPreparedSubscriberEmail,
    brevoTransport: (url, init) => fetch(url, init),
  });
}
