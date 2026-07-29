import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Lightweight uptime check. Returns 200 if the app is alive + key env vars
// are configured. Doesn't reach external services (Supabase, Stripe, etc.)
// to keep the check fast and avoid cascading failures from downstream blips.
export async function GET() {
  const checks = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    resend: !!process.env.RESEND_API_KEY,
    emailProvider: process.env.RESEND_API_KEY ? "resend" : "none",
    stripe: !!process.env.STRIPE_SECRET_KEY,
    stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    supabase:
      !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY),
    brave: !!process.env.BRAVE_SEARCH_API_KEY,
    // Fallback provider, not primary — false just means the Brave-outage /
    // Anthropic-outage fallbacks are inert, NOT that the app is down. Surfaced
    // so a rotated/dropped key is visible at a glance BEFORE an outage is the
    // thing that reveals the fallback never armed.
    gemini: !!process.env.GEMINI_API_KEY,
    // 3rd search tier (Brave -> Gemini -> You.com), same reasoning as gemini
    // above — false means that last-resort tier is inert, not that the app
    // is down.
    you: !!process.env.YOU_API_KEY,
  };
  return NextResponse.json({
    ok: true,
    version: "alpha-v0.63",
    timestamp: new Date().toISOString(),
    checks,
  });
}
