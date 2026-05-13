import { NextResponse } from "next/server";
import Stripe from "stripe";
import { supabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Creates a Stripe Billing Portal session for the authed user. They can
// update card, cancel, switch plans, see invoices — all hosted by Stripe.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  // Auth: read the user's Supabase session and look up their stripe_customer_id
  const sb = await supabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: row, error } = await sb
    .from("users")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !row?.stripe_customer_id) {
    return NextResponse.json(
      { error: "No Stripe customer on file. Subscribe first." },
      { status: 400 }
    );
  }

  try {
    const stripe = new Stripe(secret, { apiVersion: "2026-04-22.dahlia" });
    const origin = new URL(req.url).origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${origin}/alpha/settings`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Stripe error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
