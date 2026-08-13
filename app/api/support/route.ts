import { NextResponse } from "next/server";
import type { CreateEmailRequestOptions } from "resend";
import { z } from "zod";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { resendConfigured, sanitizeDisplayName } from "@/lib/email";
import { rateLimit, clientKeyFromRequest, isDuplicateSubmission } from "@/lib/rate-limit";
import { isValidEmail } from "@/lib/validate-email";

export const runtime = "nodejs";

// z.string() enforces the type, not just presence -- the old `!body?.email`
// check let a truthy non-string through, and `.length` on a plain object is
// undefined (not > 5000), so the size cap below it silently never fired.
// isValidEmail (same check checkout/onboarding use) closes a gap this schema
// otherwise had on its own: without it, an empty or malformed email passed
// straight through, got saved, and emailed to the owner as the reply-to
// address with no way to ever respond to the submitter.
const SupportPayloadSchema = z.object({
  name: z.string().max(120).optional(),
  email: z.string().min(1).max(200).refine(isValidEmail, "Not a valid email address"),
  message: z.string().max(5000),
});
type SupportPayload = z.infer<typeof SupportPayloadSchema>;

// Writes the ticket to Supabase support_tickets table when configured,
// otherwise falls back to server-console log. Also notifies youngalgy@gmail.com
// via Resend when configured (best-effort, doesn't block on email failure).
export async function POST(req: Request) {
  // Rate limit: 5 tickets per IP per hour. support_tickets has ZERO RLS
  // policies (the "anyone insert" policy it started with was dropped in
  // 20260805110000 -- writes only ever go through the service-role client)
  // and this is an unauthenticated form, so this rate limit is the SOLE
  // abuse control on this insert path. Resets per cold start (casual-abuse deterrent).
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

  // Dedup, not just rate-limit: a rapid double-click or a double-submit
  // before React's disabled-state render commits sails straight through the
  // 5/hour volume cap above (both requests are well under it) and used to
  // insert two identical tickets + send two identical owner-notify emails
  // for what the user experienced as one submission. ip+email+message is a
  // reasonable identity for "the same submission" without needing a
  // client-generated idempotency key.
  if (isDuplicateSubmission(`support:${ip}:${body.email}:${body.message}`, 60_000)) {
    return NextResponse.json({ ok: true });
  }

  // Soft/optional identity: doesn't require sign-in (this form is reachable
  // signed-out), but a signed-in submitter's ticket should carry their real
  // user_id -- otherwise deleteSupportTicketsBeforeDelete (lib/stripe-cancel.ts)
  // can never find their rows when they later delete their account, silently
  // orphaning support-ticket PII despite the privacy page's "delete your
  // account and all associated data" promise (found in review 2026-08-06).
  let userId: string | null = null;
  try {
    const sb = await supabaseServerClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    // Not signed in / Supabase unreachable -- fine, ticket still saves as
    // anonymous (userId stays null), matching today's behavior.
  }

  const supabaseConfigured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (supabaseConfigured) {
    try {
      const sb = await supabaseServiceClient();
      const { error } = await sb.from("support_tickets").insert({
        user_id: userId,
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
      // Same default every other send site in lib/email.ts uses -- this one
      // used to fall back to a Resend sandbox address (onboarding@resend.dev,
      // which can only deliver to the account owner's own verified email and
      // reads as broken/unprofessional even then) instead of the real
      // verified domain, so the app's own default wasn't even consistent
      // with itself if RESEND_FROM were ever unset.
      const from = process.env.RESEND_FROM || '"alpha." <alpha@everyday.report>';
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY!);
      // alpha-drift-r15-06: this route builds its own Resend client rather
      // than reusing lib/email.ts's, so it needs its own timeout too -- a
      // hung request here would otherwise stall an anonymous support-form
      // submission indefinitely even though the ticket is already durably
      // saved to Supabase above. 15s matches every other Resend call site
      // (lib/email.ts's RESEND_TIMEOUT_MS). `signal` is a real, working
      // fetch option the Resend SDK forwards straight through to fetch()
      // (confirmed against its own source, resendClient.post() spreads
      // ...options into the fetch() call) but isn't declared on the SDK's
      // own CreateEmailRequestOptions type -- the cast below is a type-only
      // gap, not a runtime risk.
      const sendOptions = { signal: AbortSignal.timeout(15_000) } as CreateEmailRequestOptions;
      // sanitizeDisplayName: see its own comment in lib/email.ts (alpha-drift-r19-01).
      const safeName = body.name ? sanitizeDisplayName(body.name) : "";
      const result = await resend.emails.send(
        {
          from,
          to: ownerEmail,
          // alpha-drift-r18-01 (found+fixed 2026-08-07): this file's own
          // top-of-file comment already documented the intent -- "emailed to
          // the owner as the reply-to address" -- but the actual send call
          // never set it, so hitting Reply on this notification fell back to
          // the From address (alpha@everyday.report), which has no MX record
          // and bounces. Setting replyTo to the submitter's own address lets
          // Algy just hit Reply and respond directly to them.
          replyTo: safeName ? `${safeName} <${body.email}>` : body.email,
          subject: `[alpha. support] ${safeName || body.email}`,
          text: `From: ${safeName ? `${safeName} <${body.email}>` : body.email}\n\n${body.message}`,
        },
        sendOptions
      );
      // The Resend SDK returns { data, error } on a send failure -- it does
      // NOT throw (same bug class already found+fixed in lib/email.ts's
      // sendOpsAlertViaResend during the 2026-08-05 resilience audit). This
      // catch block never sees a bad key or unverified domain; only an
      // explicit check on result.error does. The message itself is already
      // persisted to Supabase above, so nothing is lost -- only the owner
      // notification silently stops arriving with no warning anywhere.
      if (result.error) {
        // Log only message/name, not the whole error object -- Resend's
        // documented shape is {message, name} today, but a future/different
        // error type (e.g. a payload-validation error) could echo request
        // fields like `to` or the subject (which embeds body.name/body.email
        // above) back into it, and that would flow straight into the log
        // with no code change here to notice.
        console.warn("[support] owner notify failed (Resend returned an error, not a throw):", result.error.name, result.error.message);
      }
    } catch (e) {
      console.warn("[support] owner notify failed:", e);
    }
  }

  return NextResponse.json({ ok: true });
}
