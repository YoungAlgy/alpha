import { NextResponse } from "next/server";

// Lightweight uptime check. Returns 200 if the app is alive + key env vars
// are configured. Doesn't reach external services (Supabase, Stripe, etc.)
// to keep the check fast and avoid cascading failures from downstream blips.
//
// force-dynamic + no-store: discovered 2026-08-05 that this route could
// serve a STALE cached response (checks.supabase showing false well after
// the underlying env vars were confirmed working via live behavioral tests
// on other routes) — this is a monitoring/health endpoint, and the second
// letter-watchdog job reads checks.groq/deepseek/you/gemini/brave straight
// from it, so a cached response here silently defeats that alerting. Force
// a true per-request evaluation at every layer (Next's own route cache,
// Cloudflare's edge) rather than relying on the absence of dynamic APIs to
// keep this uncached by default.
export const dynamic = "force-dynamic";

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
    // 2nd content-GENERATION tier (Gemini -> Groq -> DeepSeek -> Haiku ->
    // Sonnet). Own separate account/quota from Anthropic and Google — false
    // means a Gemini-exhausted, Anthropic-unfunded day is one tier closer to
    // the stale-resend backup layer.
    groq: !!process.env.GROQ_API_KEY,
    // 3rd content-GENERATION tier, the uncapped backstop behind Groq — no
    // daily/per-minute cap the way Gemini/Groq's free tiers have. false
    // means a Gemini-AND-Groq-exhausted, Anthropic-unfunded day has no real
    // fallback left besides the stale-resend backup layer.
    deepseek: !!process.env.DEEPSEEK_API_KEY,
  };
  return NextResponse.json(
    {
      ok: true,
      version: "alpha-v0.63",
      timestamp: new Date().toISOString(),
      checks,
    },
    { headers: { "Cache-Control": "no-store, must-revalidate" } }
  );
}
