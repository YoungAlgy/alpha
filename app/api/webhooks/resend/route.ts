import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { sendOpsWebhookAlert } from "@/lib/email";
import { isHardBounce, normalizeRecipients } from "@/lib/resend-webhook-guards";
import { parseResendEventCreatedAt } from "@/lib/resend-suppression-causality";

export const runtime = "nodejs";

// alpha-deliverability-01: react to a hard bounce or a spam complaint by
// suppressing that address from future sends. Without this, a dead address
// or a subscriber who hits "report spam" instead of unsubscribing keeps
// getting sent to forever, dragging down everyday.report's sender
// reputation for every OTHER subscriber too. See the accompanying migration
// (20260806030000_resend_webhook_deliverability) for the bounced_at/
// complained_at columns and why they're locked to service-role writes.
//
// Resend webhooks are Svix-signed, same verification shape as (but a
// separate secret/mechanism from) Stripe's -- raw body + 3 svix-* headers,
// verified via the `svix` package. Docs: resend.com/docs/dashboard/webhooks.

interface ResendBounceData {
  email_id?: string;
  to?: string[];
  bounce?: {
    type?: "Permanent" | "Transient" | "Undetermined" | string;
    subType?: string;
    message?: string;
  };
}
interface ResendWebhookEvent {
  type: string;
  created_at?: string;
  data: ResendBounceData;
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "Resend webhook not configured (RESEND_WEBHOOK_SECRET missing)" },
      { status: 503 }
    );
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  // Svix verification is sensitive to the exact raw bytes -- do NOT parse
  // JSON before verifying (same discipline as the Stripe webhook's req.text()).
  const rawBody = await req.text();
  let event: ResendWebhookEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ResendWebhookEvent;
  } catch {
    console.warn("[resend-webhook] signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (!event || typeof event.type !== "string") {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }
  if (event.type !== "email.bounced" && event.type !== "email.complained") {
    // We only subscribed to these two events in the Resend dashboard, but
    // ignore anything else defensively rather than erroring -- a dashboard
    // misconfiguration adding more event types shouldn't turn into 400s.
    return NextResponse.json({ received: true });
  }

  const emailId = event.data?.email_id;

  // Only a HARD (Permanent) bounce suppresses. Transient (mailbox full,
  // greylisting, a temporary receiving-server hiccup) and Undetermined are
  // normal and expected to self-resolve on the next send -- suppressing on
  // those would silently drop a real subscriber over a blip that isn't
  // actually their fault. Every complaint suppresses -- there's no
  // "soft complaint," a spam report is unambiguous.
  if (event.type === "email.bounced" && !isHardBounce(event.data?.bounce?.type)) {
    console.warn("[resend-webhook] non-permanent bounce ignored");
    return NextResponse.json({ received: true });
  }

  if (typeof emailId !== "string" || !emailId.trim() || emailId.length > 512) {
    console.warn(
      `[resend-webhook] ${event.type} event missing data.email_id -- refusing an untraceable suppression`
    );
    return NextResponse.json(
      { received: false, error: "email id missing" },
      { status: 500 }
    );
  }

  // Handler receipt time is not causal evidence. A provider retry can arrive
  // after a newer checkout or explicit delivery re-consent. Use the signed
  // event clock and fail closed if it is absent, impossible, or implausibly in
  // the future.
  const eventAt = parseResendEventCreatedAt(event.created_at);
  if (!eventAt) {
    console.warn(
      "[resend-webhook] event has an invalid created_at"
    );
    return NextResponse.json(
      { received: false, error: "event timestamp invalid" },
      { status: 500 }
    );
  }

  const recipients = normalizeRecipients(event.data?.to);
  if (recipients.length > 20) {
    console.warn(
      "[resend-webhook] event exceeded the recipient bound"
    );
    return NextResponse.json(
      { received: false, error: "recipient count invalid" },
      { status: 400 }
    );
  }

  const sb = await supabaseServiceClient();

  // One service-only database transaction records the audit key and applies a
  // monotonic suppression update. Duplicate events still execute the update,
  // so a retained audit row cannot swallow recovery after an earlier failure.
  const { data: recorded, error: recordError } = await sb.rpc(
    "record_resend_suppression_event",
    {
      p_email_id: emailId,
      p_event_type: event.type,
      p_event_at: eventAt,
      p_recipients: recipients,
    }
  );
  const result = Array.isArray(recorded) && recorded.length === 1 ? recorded[0] : null;
  const status = result?.delivery_status;
  const updatedCount = result?.updated_count;
  if (
    recordError ||
    ![
      "applied",
      "causally_ignored",
      "pending_owner",
      "manual_review",
      "legacy_review",
      "expired_unowned",
    ].includes(status) ||
    !Number.isSafeInteger(updatedCount) ||
    updatedCount < 0 ||
    updatedCount > 1 ||
    (status !== "applied" && updatedCount !== 0)
  ) {
    // Provider identifiers and database errors can carry recipient material.
    // Keep external alerts/logs aggregate-only so they cannot bypass expiry.
    console.error("[resend-webhook] suppression transaction failed");
    await sendOpsWebhookAlert(
      "alpha. resend suppression write failed",
      `Event ${event.type}, recipient_count=${recipients.length}. Check the protected delivery review queue.`
    );
    return NextResponse.json(
      { received: false, error: "suppression write failed" },
      { status: 500 }
    );
  }
  if (status === "expired_unowned") {
    // No identity record is created for an expired, still-unowned replay.
    return NextResponse.json({ received: true });
  }
  if (
    status === "legacy_review" ||
    status === "pending_owner" ||
    status === "manual_review"
  ) {
    console.warn(
      `[resend-webhook] delivery-ownership review required (${status})`
    );
    await sendOpsWebhookAlert(
      "alpha. resend suppression needs review",
      `Event ${event.type}, recipient_count=${recipients.length}, reason=${status}. Check the protected delivery review queue.`,
    );
    return NextResponse.json({ received: true, reviewRequired: true });
  }
  if (updatedCount === 0) {
    console.warn(
      "[resend-webhook] event matched no current causal suppression target"
    );
  }

  return NextResponse.json({ received: true });
}
