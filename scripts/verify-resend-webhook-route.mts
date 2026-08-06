// Verify app/api/webhooks/resend/route.ts's actual HTTP behavior against a
// real disposable Supabase user -- calls the route's exported POST handler
// directly with a constructed Request (this route never touches
// next/headers' cookies(), only supabaseServiceClient(), so it's callable
// outside the Next.js request context entirely -- no dev server needed).
// Uses svix's own Webhook.sign() to build genuinely-valid signed test
// payloads against a LOCAL test secret (never talks to Resend or the real
// production webhook secret) -- this is svix's documented, supported way to
// generate test events, same idea as Stripe's own test-event signing.
// Run: npx tsx scripts/verify-resend-webhook-route.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.log("SKIP: Supabase env vars not set locally.");
  process.exit(0);
}

// A local-only test secret, freshly randomized every run -- never the real
// RESEND_WEBHOOK_SECRET, and never a hardcoded literal (so nothing shaped
// like a real credential ever sits in source for a secret scanner, or a
// human skimming a diff, to mistake for one). Setting it BEFORE importing
// the route matters: the route reads process.env.RESEND_WEBHOOK_SECRET
// fresh on every request (not at module load), but setting it here keeps
// this script self-contained regardless.
const { randomBytes } = await import("node:crypto");
process.env.RESEND_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;

const { Webhook } = await import("svix");
const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const { POST } = await import("../app/api/webhooks/resend/route.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const BASE = "https://alpha.everyday.report/api/webhooks/resend";
const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);

function signedRequest(body: unknown, idOverride?: string): Request {
  const id = idOverride ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const payload = JSON.stringify(body);
  const signature = wh.sign(id, timestamp, payload);
  return new Request(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "svix-signature": signature,
    },
    body: payload,
  });
}

const testEmail = `resend-webhook-verify-${Date.now()}@example.com`;
let userId: string | null = null;

async function suppressionState(): Promise<{ bounced: boolean; complained: boolean } | null> {
  const { data } = await admin.from("users").select("bounced_at, complained_at").eq("id", userId).maybeSingle();
  if (!data) return null;
  return { bounced: data.bounced_at !== null, complained: data.complained_at !== null };
}

try {
  console.log("(setup) creating a real disposable subscribed user");
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: testEmail });
  if (linkErr || !linkData?.user) {
    console.log(`SKIP: generateLink failed (${linkErr?.message ?? "no user"}).`);
    process.exit(0);
  }
  userId = linkData.user.id;
  // subscribed_at/topic_quota etc aren't relevant to this route -- only that
  // the row exists and is matched by email.
  await admin.from("users").update({ subscribed_at: new Date().toISOString(), topics: ["zodiac"] }).eq("id", userId);
  check("(setup) user starts with no suppression state", JSON.stringify(await suppressionState()) === JSON.stringify({ bounced: false, complained: false }));

  // --- (1) missing svix headers -> 400, never reaches the handler ----------
  console.log("(1) missing svix headers -> 400");
  const noHeadersRes = await POST(new Request(BASE, { method: "POST", body: "{}" }));
  check("(1) 400 with no svix headers at all", noHeadersRes.status === 400);

  // --- (2) invalid signature -> 400, no mutation ----------------------------
  console.log("(2) a tampered/invalid signature is rejected");
  const badReq = signedRequest({ type: "email.bounced", data: { email_id: "e1", to: [testEmail], bounce: { type: "Permanent" } } });
  const tamperedReq = new Request(badReq, { headers: new Headers(badReq.headers) });
  tamperedReq.headers.set("svix-signature", "v1,not-a-real-signature=");
  const badRes = await POST(tamperedReq);
  check("(2) invalid signature returns 400", badRes.status === 400);
  check("(2) no suppression write happened", JSON.stringify(await suppressionState()) === JSON.stringify({ bounced: false, complained: false }));

  // --- (3) a TRANSIENT (soft) bounce must NOT suppress ----------------------
  console.log("(3) a soft/transient bounce does not suppress -- the actual correctness bar for this webhook");
  const softRes = await POST(
    signedRequest({ type: "email.bounced", data: { email_id: `soft-${Date.now()}`, to: [testEmail], bounce: { type: "Transient" } } })
  );
  check("(3) 200 received", softRes.status === 200);
  check("(3) bounced_at is STILL null after a soft bounce", (await suppressionState())?.bounced === false);

  // --- (4) a HARD (permanent) bounce DOES suppress --------------------------
  console.log("(4) a hard/permanent bounce suppresses -- the actual point of this webhook");
  const hardRes = await POST(
    signedRequest({ type: "email.bounced", data: { email_id: `hard-${Date.now()}`, to: [testEmail], bounce: { type: "Permanent" } } })
  );
  check("(4) 200 received", hardRes.status === 200);
  check("(4) bounced_at IS now set", (await suppressionState())?.bounced === true);

  // Reset for the complaint case.
  await admin.from("users").update({ bounced_at: null }).eq("id", userId);

  // --- (5) a complaint always suppresses ------------------------------------
  console.log("(5) a spam complaint suppresses -- no such thing as a 'soft' complaint");
  const complaintRes = await POST(signedRequest({ type: "email.complained", data: { email_id: `cmp-${Date.now()}`, to: [testEmail] } }));
  check("(5) 200 received", complaintRes.status === 200);
  check("(5) complained_at IS now set", (await suppressionState())?.complained === true);

  // --- (6) redelivery of the SAME (email_id, type) is deduped, not reprocessed ---
  console.log("(6) redelivery dedup -- same email_id+type twice");
  await admin.from("users").update({ bounced_at: null }).eq("id", userId);
  const dedupEmailId = `dedup-${Date.now()}`;
  const firstRes = await POST(
    signedRequest({ type: "email.bounced", data: { email_id: dedupEmailId, to: [testEmail], bounce: { type: "Permanent" } } })
  );
  check("(6) first delivery: 200, bounced_at set", firstRes.status === 200 && (await suppressionState())?.bounced === true);
  await admin.from("users").update({ bounced_at: null }).eq("id", userId); // clear to detect a REAL reprocess
  const secondRes = await POST(
    signedRequest({ type: "email.bounced", data: { email_id: dedupEmailId, to: [testEmail], bounce: { type: "Permanent" } } })
  );
  check("(6) redelivered event still returns 200 (ack'd, not errored)", secondRes.status === 200);
  check(
    "(6) but does NOT re-suppress -- the dedup guard skipped reprocessing, confirming it actually fired",
    (await suppressionState())?.bounced === false
  );

  // --- (7) an unrelated event type is a clean no-op -------------------------
  console.log("(7) an event type we didn't subscribe to is ignored cleanly");
  await admin.from("users").update({ bounced_at: null, complained_at: null }).eq("id", userId);
  const otherRes = await POST(signedRequest({ type: "email.delivered", data: { email_id: `other-${Date.now()}`, to: [testEmail] } }));
  check("(7) 200 received for an ignored event type", otherRes.status === 200);
  check("(7) no suppression state touched", JSON.stringify(await suppressionState()) === JSON.stringify({ bounced: false, complained: false }));
} finally {
  if (userId) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) console.warn(`Cleanup warning: failed to delete test user ${userId}: ${delErr.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RESEND-WEBHOOK ROUTE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RESEND-WEBHOOK ROUTE ASSERTIONS PASS");
