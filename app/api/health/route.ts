import { NextResponse } from "next/server";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { withDeadline } from "@/lib/with-deadline";
import { rateLimit, clientKeyFromRequest } from "@/lib/rate-limit";

// Lightweight uptime check. Returns 200 if the app is alive + key env vars
// are configured. Doesn't reach external services (Stripe, etc.) to keep the
// check fast and avoid cascading failures from downstream blips -- EXCEPT
// Supabase, see checkSupabase() below.
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

// Real connectivity, not just "the env vars are non-empty strings". A
// presence-only check (the old version of this function) is blind to a
// wrong-but-present URL, a revoked/rotated key that still LOOKS like a key,
// or a paused/deleted Supabase project -- all of which would leave the app
// just as broken as the empty-string bug from 2026-08-05 while still
// reporting supabase:true. Bounded to 3s and fails closed (false) on any
// error, including missing env vars, so a slow/down Supabase can't hang this
// route or crash it -- worst case this one field is wrong for 3s, not the
// whole health check.
async function checkSupabase(): Promise<boolean> {
  try {
    const sb = await supabaseServiceClient();
    // This only needs to prove Supabase is reachable and the key is valid --
    // count: "exact" forces PostgREST to run a real SELECT count(*), an
    // O(table size) scan for no benefit here. limit(1) with no count option
    // is a cheap existence probe that proves the identical thing.
    const { error } = await withDeadline(
      Promise.resolve(sb.from("users").select("id").limit(1)),
      3000,
      "health check supabase ping"
    );
    return !error;
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  // alpha-drift-r28-06 (2026-08-15): this route runs a real checkSupabase()
  // round-trip on EVERY call (force-dynamic + no-store above deliberately
  // guarantee that -- see this file's own 2026-08-05 stale-cache comment),
  // fully public, unauthenticated -- unlike every other Supabase/third-
  // party-touching route in this app, which all call rateLimit(). Generous
  // on purpose: this route has real legitimate periodic callers (the
  // watchdog crons read checks.* straight from it, plus any external uptime
  // monitor), so the goal here is only to stop a genuine sustained flood,
  // not to interfere with normal polling at any reasonable interval.
  const ip = clientKeyFromRequest(req);
  const limited = rateLimit(`health:${ip}`, { limit: 60, windowMs: 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many requests." },
      {
        status: 429,
        headers: {
          "Retry-After": String(limited.retryAfterSec),
          "Cache-Control": "no-store, must-revalidate",
        },
      }
    );
  }

  const checks = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    resend: !!process.env.RESEND_API_KEY,
    emailProvider: process.env.RESEND_API_KEY ? "resend" : "none",
    stripe: !!process.env.STRIPE_SECRET_KEY,
    stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    supabase: await checkSupabase(),
    brave: !!process.env.BRAVE_SEARCH_API_KEY,
    // alpha-drift-r46-07 (2026-08-19): this used to describe Gemini as a
    // reactive-only fallback -- accurate before 2026-07-23 (a88a0e7), which
    // flipped topic-blurb.ts's cost-tiering waterfall so Gemini drafts EVERY
    // topic blurb by default, tried before Anthropic regardless of whether
    // Anthropic is even configured (see lib/engine/topic-blurb.ts's
    // cost-tiering, and README.md's own Environment section). PRIMARY
    // generation tier for topic blurbs, AND the Brave-outage search
    // fallback. false means every blurb generation skips straight to Groq
    // (a real behavioral/cost/quality change, not a dormant safety net), on
    // top of the search fallback going inert.
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
