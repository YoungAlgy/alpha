import { NextResponse } from "next/server";
import type { CreateEmailRequestOptions } from "resend";
import { z } from "zod";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { resendConfigured, sanitizeDisplayName } from "@/lib/email";
import { rateLimit, clientKeyFromRequest, isDuplicateSubmission } from "@/lib/rate-limit";
import {
  consumeDistributedRateLimit,
  distributedRateLimitKeyHash,
} from "@/lib/distributed-rate-limit";
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
  // alpha-drift-r69-02 (2026-08-21, form-validation-consistency-audit-r15):
  // message had no lower bound -- app/support/SupportForm.tsx blocks an
  // empty/whitespace-only submit client-side, but a direct POST bypasses
  // that entirely, and this route is deliberately unauthenticated with no
  // CSRF guard, so nothing else stood between a raw request and a stored,
  // owner-notified ticket with a blank body. .refine, not a bare .min(1) or
  // a .trim() transform: a bare min(1) still lets " " through, and a
  // .trim() transform would silently mutate the stored text and the dedup
  // key below (isDuplicateSubmission hashes email+message).
  message: z.string().max(5000).refine((s) => s.trim().length > 0, "Message can't be empty."),
});
type SupportPayload = z.infer<typeof SupportPayloadSchema>;

// Writes the ticket durably before attempting the owner notification. If the
// database or shared abuse controls are unavailable, the route fails closed
// instead of copying support PII into a log or sending an untracked email.
export async function POST(req: Request) {
  // Rate limit: 5 tickets per IP per hour. support_tickets has ZERO RLS
  // policies (the "anyone insert" policy it started with was dropped in
  // 20260805110000 -- writes only ever go through the service-role client)
  // and this is an unauthenticated form. This first limiter sheds bursts in
  // one isolate. The Supabase-backed IP and global limits below are the
  // durable abuse controls.
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

  let svc: Awaited<ReturnType<typeof supabaseServiceClient>>;
  try {
    svc = await supabaseServiceClient();
  } catch {
    return NextResponse.json(
      { error: "Support is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }

  const [distributedIpLimit, distributedGlobalLimit] = await Promise.all([
    consumeDistributedRateLimit(svc, "support-ip", ip, {
      limit: 5,
      windowMs: 60 * 60 * 1000,
    }),
    consumeDistributedRateLimit(svc, "support-global", "all", {
      limit: 100,
      windowMs: 24 * 60 * 60 * 1000,
    }),
  ]);
  if (!distributedIpLimit.available || !distributedGlobalLimit.available) {
    return NextResponse.json(
      { error: "Support is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  const distributedBlock = !distributedIpLimit.ok
    ? distributedIpLimit
    : !distributedGlobalLimit.ok
      ? distributedGlobalLimit
      : null;
  if (distributedBlock) {
    return NextResponse.json(
      { error: "Support is busy right now. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(distributedBlock.retryAfterSec) },
      }
    );
  }

  // Dedup, not just rate-limit: a rapid double-click or a double-submit
  // before React's disabled-state render commits sails straight through the
  // 5/hour volume cap above (both requests are well under it) and used to
  // insert two identical tickets + send two identical owner-notify emails
  // for what the user experienced as one submission. ip+email+message is a
  // reasonable identity for "the same submission" without needing a
  // client-generated idempotency key.
  let submissionHash: string;
  try {
    submissionHash = distributedRateLimitKeyHash(
      "support-submission",
      `${ip}\n${body.email.toLowerCase()}\n${body.message}`
    );
  } catch {
    return NextResponse.json(
      { error: "Support is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  if (isDuplicateSubmission(`support:${submissionHash}`, 60_000)) {
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

  try {
    const { error } = await svc.from("support_tickets").insert({
      user_id: userId,
      name: body.name || null,
      email: body.email,
      message: body.message,
    });
    if (error) throw error;
  } catch {
    // Keep support PII and provider/database error payloads out of logs. The
    // ticket body and reply address are already sensitive enough without an
    // SDK echoing them through an exception message.
    console.error("[support] Supabase insert failed");
    // Do not return the raw Supabase error to an unauthenticated caller. It
    // can expose schema, constraint, or policy details.
    return NextResponse.json({ error: "Couldn't save. Try again." }, { status: 500 });
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
        // Provider messages can echo request fields. Record only the bounded
        // provider error name so a support address or message cannot leak.
        const errorName =
          typeof result.error.name === "string" && result.error.name.length <= 80
            ? result.error.name
            : "provider_error";
        console.warn("[support] owner notify failed:", errorName);
      }
    } catch {
      console.warn("[support] owner notify failed");
    }
  }

  return NextResponse.json({ ok: true });
}
