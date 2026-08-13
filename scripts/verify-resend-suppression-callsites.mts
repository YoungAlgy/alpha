// Verifies the fix (alpha-drift-r18-01, 2026-08-07) for a gap round 18's
// audit found in round 17's own suppression-removal fix (alpha-drift-r17-06):
// scripts/verify-resend-suppression-removal.mts only ever exercised
// removeResendSuppression() directly -- it never exercised the CALL SITES
// that are supposed to invoke it, so it never would have caught that the
// INSERT branch of both app/api/stripe/webhook/route.ts's checkout.session.
// completed handler AND lib/engine/persist.ts's persistIssueIfPossible
// simply never called it at all. This script closes that specific coverage
// gap: it drives the real route handler and the real persist function
// end-to-end (not the underlying helper in isolation) against a synthetic
// address that's ALREADY suppressed on Resend's real account-level list, and
// confirms the insert path itself clears it.
// Run: npx tsx scripts/verify-resend-suppression-callsites.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const resendKey = process.env.RESEND_API_KEY?.trim();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!resendKey || !supabaseUrl || !supabaseKey || !stripeSecretKey) {
  console.log("SKIP: RESEND_API_KEY / Supabase / STRIPE_SECRET_KEY not all set locally.");
  process.exit(0);
}

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

async function addSuppression(email: string) {
  return fetch("https://api.resend.com/suppressions", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}
async function getSuppression(email: string) {
  return fetch(`https://api.resend.com/suppressions/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${resendKey}` },
  });
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function cleanupByEmail(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = list?.users?.find((u) => u.email?.toLowerCase() === email);
  if (match) {
    const { error } = await admin.auth.admin.deleteUser(match.id);
    if (error) console.warn(`Cleanup warning: failed to delete test user ${match.id}: ${error.message}`);
  }
}

console.log("(A) lib/engine/persist.ts's persistIssueIfPossible -- INSERT branch (true first-time onboarding)");
{
  const email = `alpha-test-r18-01-persist-${Date.now()}@example.invalid`;
  try {
    const suppress = await addSuppression(email);
    check("(A setup) synthetic address suppressed on Resend's real list", suppress.ok);
    const before = await getSuppression(email);
    check("(A setup) confirmed suppressed via GET", before.ok);

    const { persistIssueIfPossible } = await import("../lib/engine/persist.ts");
    const fakeProfile = {
      email,
      firstName: "Test",
      city: "",
      topics: ["ai-news"],
    } as Parameters<typeof persistIssueIfPossible>[0];
    const fakeIssue = {
      id: "test",
      volume: 1,
      number: 1,
      weekOf: "2099-01-01",
      recipientFirstName: "Test",
      recipientCity: "",
      editorIntro: "test",
      sections: [],
    } as Parameters<typeof persistIssueIfPossible>[1];

    const result = await persistIssueIfPossible(fakeProfile, fakeIssue, "2099-01-01");
    check("(A) persistIssueIfPossible succeeded (brand new user created)", result !== null);

    const after = await getSuppression(email);
    check(
      "(A) address genuinely no longer suppressed after the INSERT path -- THE GAP THIS FIX CLOSES",
      after.status === 404
    );
  } finally {
    await cleanupByEmail(email);
  }
}

console.log("(B) app/api/stripe/webhook/route.ts's checkout.session.completed -- INSERT branch (real route, signed request)");
{
  // A local-only test webhook secret, freshly randomized -- never the real
  // STRIPE_WEBHOOK_SECRET (production's lives only in Cloudflare's secret
  // store, and .env.local deliberately doesn't set it). Set BEFORE importing
  // the route: it reads process.env.STRIPE_WEBHOOK_SECRET fresh per request.
  const { randomBytes } = await import("node:crypto");
  process.env.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
  const { default: Stripe } = await import("stripe");
  const { POST } = await import("../app/api/stripe/webhook/route.ts");

  const email = `alpha-test-r18-01-webhook-${Date.now()}@example.invalid`;
  try {
    const suppress = await addSuppression(email);
    check("(B setup) synthetic address suppressed on Resend's real list", suppress.ok);
    const before = await getSuppression(email);
    check("(B setup) confirmed suppressed via GET", before.ok);

    const BASE = "https://alpha.everyday.report/api/stripe/webhook";
    const sessionEvent = {
      id: `evt_test_r18_01_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          object: "checkout.session",
          // No `subscription` field on purpose: keeps this test from making
          // any real network call to Stripe's subscriptions API (the
          // subscriptionLive check only runs when session.subscription is
          // set) -- signature construction/verification below is fully
          // local, keyed off the random secret set above, no real Stripe
          // credentials required for that part either.
          customer: `cus_test_verify_${Date.now()}`,
          customer_details: { email },
          customer_email: null,
          metadata: { alpha_first_name: "Test", alpha_city: "" },
        },
      },
    };
    const payload = JSON.stringify(sessionEvent);
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    const req = new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: payload,
    });

    const res = await POST(req);
    check("(B) route returned 200", res.status === 200);

    const { data: userRow } = await admin.from("users").select("id, email").eq("email", email).maybeSingle();
    check("(B) a real users row was inserted for the synthetic email (confirms the INSERT branch ran)", !!userRow);

    const after = await getSuppression(email);
    check(
      "(B) address genuinely no longer suppressed after the webhook's INSERT branch -- THE GAP THIS FIX CLOSES",
      after.status === 404
    );
  } finally {
    await cleanupByEmail(email);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RESEND-SUPPRESSION-CALLSITES VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RESEND-SUPPRESSION-CALLSITES ASSERTIONS PASS");
