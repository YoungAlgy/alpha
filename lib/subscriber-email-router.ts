import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PreparedSubscriberEmail } from "./email";
import { prepareBrevoCandidateEmail, type BrevoHttpTransport } from "./brevo-transport";
import { sendWithBrevoDeliveryAttempt } from "./brevo-delivery-attempt";
import { sendWithResendDeliveryAttempt } from "./resend-delivery-attempt";

export type SubscriberDeliveryProvider = "resend" | "brevo";
export type SubscriberDeliveryConfig = {
  lettersEnabled: boolean;
  schemaEnabled: boolean;
  brevoEnabled: boolean;
  preferredProvider: string;
  resendReady: boolean;
  brevoApiKey: string;
  brevoSender: string;
  brevoWebhookReady: boolean;
};

export function brevoDeliveryConfigured(config: SubscriberDeliveryConfig): boolean {
  return config.schemaEnabled && config.brevoEnabled && config.brevoWebhookReady &&
    /^[\x21-\x7e]{1,2048}$/.test(config.brevoApiKey) &&
    /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@backup\.alpha\.everyday\.report$/.test(config.brevoSender) &&
    !config.brevoSender.includes("..");
}

export function subscriberDeliveryConfigured(config: SubscriberDeliveryConfig): boolean {
  if (!config.lettersEnabled) return false;
  // The default remains compatible with the released Resend-only schema.
  if (!config.schemaEnabled) return config.resendReady;
  if (config.preferredProvider === "resend") return config.resendReady;
  if (config.preferredProvider === "brevo") return brevoDeliveryConfigured(config);
  return false;
}

export type SubscriberLetterDeliveryParams = {
  sb: Pick<SupabaseClient, "rpc">;
  userId: string;
  weekOf: string;
  deliveryLane: string;
  expectedClaimedAt: string | null;
  prepared: PreparedSubscriberEmail;
  requireProvider?: SubscriberDeliveryProvider;
};

function snapshotPrepared(input: PreparedSubscriberEmail): PreparedSubscriberEmail {
  const payload = Object.freeze({ ...input.payload, headers: Object.freeze({ ...input.payload.headers }) });
  const snapshot = Object.freeze({
    recipient: input.recipient,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    payload,
  });
  const actual = createHash("sha256").update(JSON.stringify({
    payload, idempotencyKey: snapshot.idempotencyKey ?? null,
  })).digest("hex");
  if (snapshot.requestFingerprint !== actual || snapshot.recipient !== payload.to) {
    throw new Error("Subscriber email preparation changed before delivery.");
  }
  return snapshot;
}

/** Injected transport boundary. Provider choice happens before any send, and
 * existing attempts always retain their provider. A timeout or rejected call
 * never causes a second provider to receive this issue. */
export async function routeSubscriberLetter(
  params: SubscriberLetterDeliveryParams,
  dependencies: {
    config: SubscriberDeliveryConfig;
    sendResend: (prepared: PreparedSubscriberEmail) => Promise<{ id: string }>;
    brevoTransport: BrevoHttpTransport;
  },
) {
  const config = { ...dependencies.config };
  if (!config.lettersEnabled) throw new Error("Subscriber letters are paused.");
  const prepared = snapshotPrepared(params.prepared);
  if (prepared.idempotencyKey !== `alpha-letter-${params.userId}-${params.weekOf}-${params.deliveryLane}`) {
    throw new Error("Subscriber delivery identity does not match the prepared email.");
  }
  // The new provider-aware path keeps Alpha's signed body link for either
  // provider. Brevo's own opt-out event is an additional delivery block.
  if (config.schemaEnabled) {
    const unsubscribeHeader = prepared.payload.headers["List-Unsubscribe"];
    const unsubscribeLink = unsubscribeHeader?.startsWith("<") && unsubscribeHeader.endsWith(">")
      ? unsubscribeHeader.slice(1, -1) : "";
    if (!unsubscribeLink.startsWith("https://alpha.everyday.report/api/unsubscribe?token=") ||
        !prepared.payload.html.includes(unsubscribeLink) || !prepared.payload.text.includes(unsubscribeLink)) {
      throw new Error("Subscriber delivery requires Alpha's unsubscribe link in both email bodies.");
    }
  }
  let provider: SubscriberDeliveryProvider = "resend";
  if (config.schemaEnabled) {
    let existing: unknown;
    try {
      const result = await params.sb.rpc("resolve_subscriber_delivery_provider", {
        p_user_id: params.userId, p_week_of: params.weekOf, p_delivery_lane: params.deliveryLane,
      });
      if (result.error) throw new Error("lookup_failed");
      existing = result.data;
    } catch {
      throw new Error("Subscriber delivery provider could not be verified.");
    }
    if (existing !== "none" && existing !== "resend" && existing !== "brevo") {
      throw new Error("Subscriber delivery provider could not be verified.");
    }
    const choice = existing === "none" ? config.preferredProvider : existing;
    if (choice !== "resend" && choice !== "brevo") throw new Error("Subscriber email provider is invalid.");
    provider = choice;
  }
  if (params.requireProvider && provider !== params.requireProvider) {
    throw new Error("Subscriber delivery provider differs from the required canary provider.");
  }
  if (provider === "resend") {
    if (!config.resendReady) throw new Error("Resend is not configured for this delivery.");
    const result = await sendWithResendDeliveryAttempt({
      sb: params.sb, userId: params.userId, weekOf: params.weekOf,
      recipient: prepared.recipient, deliveryLane: params.deliveryLane,
      payloadFingerprint: prepared.requestFingerprint, expectedClaimedAt: params.expectedClaimedAt,
      send: async (recipient) => {
        if (recipient !== prepared.recipient) throw new Error("Delivery recipient changed.");
        return dependencies.sendResend(prepared);
      },
    });
    return { ...result, provider };
  }
  if (!brevoDeliveryConfigured(config) || params.deliveryLane !== "live" || !params.expectedClaimedAt) {
    throw new Error("Brevo is not enabled for this delivery.");
  }
  const result = prepareBrevoCandidateEmail({
    attemptId: randomUUID(), sender: { email: config.brevoSender, name: "alpha." },
    recipient: prepared.recipient, replyTo: prepared.payload.replyTo,
    subject: prepared.payload.subject, html: prepared.payload.html, text: prepared.payload.text,
    issueHeader: prepared.payload.headers["X-Alpha-Issue-Id"],
  });
  if (result.status !== "prepared") throw new Error("Brevo email preparation failed.");
  const sent = await sendWithBrevoDeliveryAttempt({
    sb: params.sb, userId: params.userId, weekOf: params.weekOf,
    expectedClaimedAt: params.expectedClaimedAt, prepared: result.prepared,
    options: { apiKey: config.brevoApiKey }, transport: dependencies.brevoTransport,
  });
  return { ...sent, provider };
}
