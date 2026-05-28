import { NextResponse } from "next/server";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { sendLetterNotification, resendConfigured } from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

interface SupportPayload {
  name?: string;
  email: string;
  message: string;
}

// Writes the ticket to Supabase support_tickets table when configured,
// otherwise falls back to server-console log. Also notifies youngalgy@gmail.com
// via Resend when configured (best-effort, doesn't block on email failure).
export async function POST(req: Request) {
  // Rate limit: 5 tickets per IP per hour. The table has an "anyone insert"
  // RLS policy + this is an unauthenticated form, so without a cap it's a
  // spam / inbox-flood vector. Resets per cold start (casual-abuse deterrent).
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`support:${ip}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many messages. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: SupportPayload;
  try {
    body = (await req.json()) as SupportPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body?.email || !body?.message) {
    return NextResponse.json({ error: "email and message required" }, { status: 400 });
  }

  // Bound payload sizes so a single ticket can't dump megabytes into the table.
  if (body.email.length > 200 || body.message.length > 5000 || (body.name?.length ?? 0) > 120) {
    return NextResponse.json({ error: "Input too long." }, { status: 400 });
  }

  const supabaseConfigured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (supabaseConfigured) {
    try {
      const sb = await supabaseServiceClient();
      const { error } = await sb.from("support_tickets").insert({
        name: body.name || null,
        email: body.email,
        message: body.message,
      });
      if (error) throw error;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[support] Supabase insert failed:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  } else {
    console.log(
      `[support] ${new Date().toISOString()} from ${body.email}${body.name ? ` (${body.name})` : ""}:\n  ${body.message.replace(/\n/g, "\n  ")}`
    );
  }

  // Best-effort owner notification (don't fail the request if this errors)
  if (resendConfigured()) {
    try {
      const ownerEmail = process.env.SUPPORT_FORWARD_EMAIL || "youngalgy@gmail.com";
      const from = process.env.RESEND_FROM || "Alpha <onboarding@resend.dev>";
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY!);
      await resend.emails.send({
        from,
        to: ownerEmail,
        subject: `[Alpha support] ${body.name || body.email}`,
        text: `From: ${body.name ? `${body.name} <${body.email}>` : body.email}\n\n${body.message}`,
      });
    } catch (e) {
      console.warn("[support] owner notify failed:", e);
    }
  }

  return NextResponse.json({ ok: true });
}
