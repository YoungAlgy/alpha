import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { sendOpsAlert } from "@/lib/email";
import { isHardBounce, normalizeRecipients } from "@/lib/resend-webhook-guards";

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
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid signature";
    console.warn("[resend-webhook] signature verification failed:", msg);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type !== "email.bounced" && event.type !== "email.complained") {
    // We only subscribed to these two events in the Resend dashboard, but
    // ignore anything else defensively rather than erroring -- a dashboard
    // misconfiguration adding more event types shouldn't turn into 400s.
    return NextResponse.json({ received: true });
  }

  const emailId = event.data.email_id;
  if (!emailId) {
    console.warn(`[resend-webhook] ${event.type} event missing data.email_id -- can't dedup, skipping`);
    return NextResponse.json({ received: true });
  }

  const sb = await supabaseServiceClient();

  // Structural redelivery guard, same pattern as stripe_webhook_events --
  // Resend/Svix delivers at-least-once. (email_id, type) is the natural key
  // since Resend doesn't hand webhooks a top-level event id the way Stripe
  // does. ignoreDuplicates -> INSERT ... ON CONFLICT DO NOTHING; 0 rows back
  // means this (email_id, type) pair was already processed.
  const { data: dedupRows, error: dedupErr } = await sb
    .from("resend_webhook_events")
    .upsert({ email_id: emailId, type: event.type }, { onConflict: "email_id,type", ignoreDuplicates: true })
    .select("email_id");
  if (dedupErr) {
    console.warn("[resend-webhook] dedup insert failed, processing without guard:", dedupErr.message);
  } else if ((dedupRows?.length ?? 0) === 0) {
    console.warn(`[resend-webhook] duplicate delivery of ${event.type} for email_id ${emailId} -- skipping`);
    return NextResponse.json({ received: true });
  }

  // Only a HARD (Permanent) bounce suppresses. Transient (mailbox full,
  // greylisting, a temporary receiving-server hiccup) and Undetermined are
  // normal and expected to self-resolve on the next send -- suppressing on
  // those would silently drop a real subscriber over a blip that isn't
  // actually their fault. Every complaint suppresses -- there's no
  // "soft complaint," a spam report is unambiguous.
  if (event.type === "email.bounced" && !isHardBounce(event.data.bounce?.type)) {
    console.warn(
      `[resend-webhook] non-permanent bounce (${event.data.bounce?.type ?? "unknown"}) for email_id ${emailId} -- not suppressing`
    );
    return NextResponse.json({ received: true });
  }

  const recipients = normalizeRecipients(event.data.to);
  if (recipients.length === 0) {
    console.warn(`[resend-webhook] ${event.type} event for email_id ${emailId} has no recipient addresses -- nothing to suppress`);
    return NextResponse.json({ received: true });
  }

  const column = event.type === "email.bounced" ? "bounced_at" : "complained_at";
  const { data: updatedRows, error: updateErr } = await sb
    .from("users")
    .update({ [column]: new Date().toISOString() })
    .in("email", recipients)
    .select("id");
  if (updateErr) {
    console.error(`[resend-webhook] ${column} write failed:`, updateErr.message);
    // Best-effort ops alert, never blocks the response -- a failed
    // suppression write is a deliverability risk, not a paying-customer
    // outage, so this doesn't need Stripe's throw-and-retry treatment.
    await sendOpsAlert(
      "alpha. resend suppression write failed",
      `${event.type} for email_id ${emailId} (${recipients.join(", ")}): ${updateErr.message}`,
      `alpha-resend-webhook-fail-${emailId}-${event.type}`
    );
  } else if ((updatedRows?.length ?? 0) === 0) {
    // 0 rows matched almost always means the recipient isn't (or is no
    // longer) a subscriber -- a stray test send, a since-deleted account, or
    // an address that was never in public.users to begin with. Not an error.
    console.warn(`[resend-webhook] ${event.type} for email_id ${emailId} matched no subscriber row (${recipients.join(", ")})`);
  }

  return NextResponse.json({ received: true });
}
