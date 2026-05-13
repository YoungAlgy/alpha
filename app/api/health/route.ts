import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Lightweight uptime check. Returns 200 if the app is alive + key env vars
// are configured. Doesn't reach external services (Supabase, Stripe, etc.)
// to keep the check fast and avoid cascading failures from downstream blips.
export async function GET() {
  const sesReady =
    !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
  const checks = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    resend: !!process.env.RESEND_API_KEY,
    ses: sesReady,
    emailProvider: sesReady
      ? "ses"
      : process.env.RESEND_API_KEY
      ? "resend"
      : "none",
    stripe: !!process.env.STRIPE_SECRET_KEY,
    stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    supabase:
      !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY),
    brave: !!process.env.BRAVE_SEARCH_API_KEY,
  };
  return NextResponse.json({
    ok: true,
    version: "alpha-v0.37",
    timestamp: new Date().toISOString(),
    checks,
  });
}
