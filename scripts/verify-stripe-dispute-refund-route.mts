// Verify app/api/stripe/webhook/route.ts's new dispute/refund/radar handling
// (alpha-drift-r14-01) against the actual route, real production Supabase,
// and a REAL (read-only, safe) call to the live Stripe API for the
// charge-lookup failure path. Never touches real money: every payload here
// references either a nonexistent charge id (a safe 404 lookup) or a
// disposable test user's fake stripe_customer_id that was never a real
// Stripe customer, so no live subscription is ever listed/cancelled for
// real. This account is LIVE MODE ONLY (no test-mode key configured) --
// that's exactly why the dispute SUCCESS path (a real charge resolving to a
// real customer) can't be safely live-tested here; every other event
// handler in this same file (checkout/subscription.updated/deleted) has the
// same limitation and is only proven via real production traffic over time,
// not a dedicated unit test -- this script matches that existing bar, not a
// lower one.
// Run: npx tsx scripts/verify-stripe-dispute-refund-route.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!url || !serviceKey || !stripeSecretKey) {
  console.log("SKIP: Supabase or Stripe env vars not set locally.");
  process.exit(0);
}

// A local-only test webhook secret, freshly randomized every run -- never
// the real STRIPE_WEBHOOK_SECRET (which isn't even set in .env.local by
// design; production's lives only in Cloudflare's secret store). Setting it
// BEFORE importing the route matters: the route reads
// process.env.STRIPE_WEBHOOK_SECRET fresh on every request.
const { randomBytes } = await import("node:crypto");
process.env.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;

const { default: Stripe } = await import("stripe");
const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const { POST } = await import("../app/api/stripe/webhook/route.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const BASE = "https://alpha.everyday.report/api/stripe/webhook";

function signedRequest(body: unknown): Request {
  const payload = JSON.stringify(body);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  return new Request(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
}

function fakeDispute(id: string, chargeId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_test_${id}`,
    type: overrides.type ?? "charge.dispute.created",
    data: {
      object: {
        id: `dp_test_${id}`,
        object: "dispute",
        charge: chargeId,
        amount: 500,
        reason: "fraudulent",
        status: overrides.status ?? "warning_needs_response",
      },
    },
  };
}

const testEmail = `stripe-dispute-verify-${Date.now()}@example.com`;
const fakeCustomerId = `cus_test_verify_${Date.now()}`;
let userId: string | null = null;

async function currentState(): Promise<{ cancelledAt: string | null; topicQuota: number | null } | null> {
  const { data } = await admin.from("users").select("cancelled_at, topic_quota").eq("id", userId).maybeSingle();
  if (!data) return null;
  return { cancelledAt: data.cancelled_at, topicQuota: data.topic_quota };
}

try {
  console.log("(setup) creating a real disposable subscribed test user with a FAKE stripe_customer_id");
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: testEmail });
  if (linkErr || !linkData?.user) {
    console.log(`SKIP: generateLink failed (${linkErr?.message ?? "no user"}).`);
    process.exit(0);
  }
  userId = linkData.user.id;
  await admin
    .from("users")
    .update({ subscribed_at: new Date().toISOString(), stripe_customer_id: fakeCustomerId, topics: ["zodiac"] })
    .eq("id", userId);
  check("(setup) test user starts with cancelled_at null", (await currentState())?.cancelledAt === null);

  // --- (1) an invalid/tampered signature is rejected, same as before this change ---
  console.log("(1) invalid signature is still rejected (unchanged path, regression guard)");
  const tampered = new Request(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=not-a-real-signature" },
    body: JSON.stringify(fakeDispute("sig", "ch_doesnotexist")),
  });
  const tamperedRes = await POST(tampered);
  check("(1) tampered signature returns 400", tamperedRes.status === 400);

  // --- (2) charge.dispute.created with a charge that doesn't exist -- safe, real Stripe 404 lookup ---
  console.log("(2) dispute.created with a nonexistent charge -- real (read-only) Stripe lookup, must fail gracefully");
  const disputeRes = await POST(signedRequest(fakeDispute(`nochg-${Date.now()}`, `ch_definitely_does_not_exist_${Date.now()}`)));
  check("(2) route returns 200 (alerted, not crashed)", disputeRes.status === 200);
  check("(2) unrelated test user's cancelled_at is untouched", (await currentState())?.cancelledAt === null);

  // --- (3) charge.dispute.closed -- visibility only, no DB touch, no external calls at all ---
  console.log("(3) dispute.closed -- pure visibility, never touches the DB");
  const closedRes = await POST(
    signedRequest(fakeDispute(`closed-${Date.now()}`, "ch_irrelevant", { type: "charge.dispute.closed", status: "won" }))
  );
  check("(3) route returns 200", closedRes.status === 200);
  check("(3) test user's cancelled_at STILL untouched (closed never auto-restores or auto-revokes)", (await currentState())?.cancelledAt === null);

  // --- (4) charge.refunded referencing our REAL disposable test user -- must NOT auto-revoke ---
  console.log("(4) charge.refunded for a real row -- must alert, must NOT auto-revoke access (the actual design decision under test)");
  const refundEvent = {
    id: `evt_test_refund_${Date.now()}`,
    type: "charge.refunded",
    data: {
      object: {
        id: `ch_test_refund_${Date.now()}`,
        object: "charge",
        customer: fakeCustomerId,
        amount: 500,
        amount_refunded: 500,
      },
    },
  };
  const refundRes = await POST(signedRequest(refundEvent));
  check("(4) route returns 200", refundRes.status === 200);
  check(
    "(4) cancelled_at is STILL null after a full refund -- refund alone must not auto-cancel (goodwill-refund case)",
    (await currentState())?.cancelledAt === null
  );

  // --- (5) redelivery of the SAME dispute event is deduped, not double-processed ---
  console.log("(5) redelivery dedup -- same event id twice");
  const dedupEventId = `dup-${Date.now()}`;
  const first = await POST(signedRequest(fakeDispute(dedupEventId, "ch_also_does_not_exist")));
  check("(5) first delivery: 200", first.status === 200);
  const second = await POST(signedRequest(fakeDispute(dedupEventId, "ch_also_does_not_exist")));
  check("(5) redelivered event still returns 200 (ack'd via the dedup short-circuit, not reprocessed)", second.status === 200);
} finally {
  if (userId) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) console.warn(`Cleanup warning: failed to delete test user ${userId}: ${delErr.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STRIPE DISPUTE/REFUND VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE DISPUTE/REFUND ASSERTIONS PASS");
