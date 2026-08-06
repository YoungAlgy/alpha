import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { resendConfigured } from "@/lib/email";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

// z.string() enforces the type, not just presence -- the old `!body?.email`
// check let a truthy non-string through, and `.length` on a plain object is
// undefined (not > 5000), so the size cap below it silently never fired.
const SupportPayloadSchema = z.object({
  name: z.string().max(120).optional(),
  email: z.string().max(200),
  message: z.string().max(5000),
});
type SupportPayload = z.infer<typeof SupportPayloadSchema>;

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
    const raw = await req.json();
    body = SupportPayloadSchema.parse(raw);
  } catch (e) {
    const message =
      e instanceof z.ZodError
        ? `Invalid input: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : "Invalid JSON";
    return NextResponse.json({ error: message }, { status: 400 });
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
      // Don't return the raw Supabase error to an unauthenticated caller --
      // it can leak schema/constraint/RLS details. Match the account/*
      // routes' pattern: log the detail server-side, return a generic message.
      return NextResponse.json({ error: "Couldn't save. Try again." }, { status: 500 });
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
      const from = process.env.RESEND_FROM || '"alpha." <onboarding@resend.dev>';
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY!);
      const result = await resend.emails.send({
        from,
        to: ownerEmail,
        subject: `[alpha. support] ${body.name || body.email}`,
        text: `From: ${body.name ? `${body.name} <${body.email}>` : body.email}\n\n${body.message}`,
      });
      // The Resend SDK returns { data, error } on a send failure -- it does
      // NOT throw (same bug class already found+fixed in lib/email.ts's
      // sendOpsAlertViaResend during the 2026-08-05 resilience audit). This
      // catch block never sees a bad key or unverified domain; only an
      // explicit check on result.error does. The message itself is already
      // persisted to Supabase above, so nothing is lost -- only the owner
      // notification silently stops arriving with no warning anywhere.
      if (result.error) {
        console.warn("[support] owner notify failed (Resend returned an error, not a throw):", result.error);
      }
    } catch (e) {
      console.warn("[support] owner notify failed:", e);
    }
  }

  return NextResponse.json({ ok: true });
}
