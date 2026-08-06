// Verify app/api/unsubscribe/route.ts's actual HTTP behavior against a real
// disposable Supabase user -- calls the route's exported GET/POST handlers
// directly with constructed Request objects (this route never touches
// next/headers' cookies(), only supabaseServiceClient(), so it's callable
// outside the Next.js request context entirely -- no dev server needed).
//
// This route's own header comment documents a real production incident
// fixed 2026-08-06: GET used to mutate state directly, and email security
// gateways/link-prescanners (Defender Safe Links, Proofpoint, Mimecast) auto-
// fetch every URL in an inbound email, silently unsubscribing paying readers
// who never clicked anything. The fix (GET never mutates, only POST does)
// had zero regression coverage until this script.
// Run: npx tsx scripts/verify-unsubscribe-route.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.log("SKIP: Supabase env vars not set locally.");
  process.exit(0);
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const { makeUnsubscribeToken } = await import("../lib/unsubscribe.ts");
const { GET, POST } = await import("../app/api/unsubscribe/route.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const testEmail = `unsub-route-verify-${Date.now()}@example.com`;
let userId: string | null = null;
const BASE = "https://alpha.everyday.report/api/unsubscribe";

async function isUnsubscribed(): Promise<boolean | null> {
  const { data } = await admin.from("users").select("unsubscribed_at").eq("id", userId).maybeSingle();
  return data ? data.unsubscribed_at !== null : null;
}

try {
  console.log("(setup) creating a real disposable user");
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: testEmail,
  });
  if (linkErr || !linkData?.user) {
    console.log(`SKIP: generateLink failed (${linkErr?.message ?? "no user"}).`);
    process.exit(0);
  }
  userId = linkData.user.id;
  check("(setup) user starts NOT unsubscribed", (await isUnsubscribed()) === false);

  const validToken = makeUnsubscribeToken(userId);

  // --- (1) GET with a valid token must NOT mutate ---------------------------
  console.log("(1) GET never mutates, even with a valid token (the real fix this route exists to prove)");
  const getRes = await GET(new Request(`${BASE}?token=${encodeURIComponent(validToken)}`));
  check("(1) GET returns 200", getRes.status === 200);
  check("(1) GET returns HTML", (getRes.headers.get("content-type") ?? "").includes("text/html"));
  const getBody = await getRes.text();
  check("(1) GET renders a real POST confirmation form", getBody.includes("<form method=\"POST\""));
  check("(1) unsubscribed_at is STILL null after GET -- the actual bug this fix closes", (await isUnsubscribed()) === false);

  // --- (2) GET with an invalid token: no mutation, clean error page ---------
  console.log("(2) GET with an invalid token");
  const getBadRes = await GET(new Request(`${BASE}?token=garbage`));
  check("(2) GET with bad token returns 400", getBadRes.status === 400);
  check("(2) still not unsubscribed", (await isUnsubscribed()) === false);

  // --- (3) POST source=confirm-page (human clicked the real form) -----------
  console.log("(3) POST with source=confirm-page -- the human-confirmation path");
  const confirmReq = new Request(`${BASE}?token=${encodeURIComponent(validToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "source=confirm-page",
  });
  const confirmRes = await POST(confirmReq);
  check("(3) POST confirm-page returns 200", confirmRes.status === 200);
  check("(3) POST confirm-page returns HTML (not JSON) -- for a human's browser", (confirmRes.headers.get("content-type") ?? "").includes("text/html"));
  const confirmBody = await confirmRes.text();
  check("(3) confirmation page mentions the real email", confirmBody.includes(testEmail));
  check("(3) unsubscribed_at IS now set", (await isUnsubscribed()) === true);

  // Reset for the next test.
  await admin.from("users").update({ unsubscribed_at: null }).eq("id", userId);
  check("(reset) unsubscribed_at cleared for the next case", (await isUnsubscribed()) === false);

  // --- (4) POST with no source field -- RFC 8058 one-click machine path -----
  console.log("(4) POST with NO source field -- the RFC 8058 one-click machine path");
  const oneClickReq = new Request(`${BASE}?token=${encodeURIComponent(validToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  const oneClickRes = await POST(oneClickReq);
  check("(4) one-click POST returns 200", oneClickRes.status === 200);
  check("(4) one-click POST returns JSON (not HTML) -- for a mail provider's automated check", (oneClickRes.headers.get("content-type") ?? "").includes("application/json"));
  const oneClickBody = await oneClickRes.json();
  check("(4) JSON body is a bare {ok:true}", oneClickBody.ok === true);
  check("(4) unsubscribed_at IS now set", (await isUnsubscribed()) === true);

  // Reset again.
  await admin.from("users").update({ unsubscribed_at: null }).eq("id", userId);

  // --- (5) POST with an invalid token: correct error shape per caller -------
  console.log("(5) POST with an invalid token -- error shape matches the caller");
  const badConfirmRes = await POST(
    new Request(`${BASE}?token=garbage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "source=confirm-page",
    })
  );
  check("(5) bad token + confirm-page returns 400 HTML", badConfirmRes.status === 400 && (badConfirmRes.headers.get("content-type") ?? "").includes("text/html"));
  const badOneClickRes = await POST(
    new Request(`${BASE}?token=garbage`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "" })
  );
  check("(5) bad token + one-click returns 400 JSON with ok:false", badOneClickRes.status === 400);
  const badOneClickBody = await badOneClickRes.json();
  check("(5) bad token JSON body has ok:false + an error string", badOneClickBody.ok === false && typeof badOneClickBody.error === "string");
  check("(5) never mutated on a bad token", (await isUnsubscribed()) === false);
} finally {
  if (userId) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) console.warn(`Cleanup warning: failed to delete test user ${userId}: ${delErr.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("UNSUBSCRIBE-ROUTE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL UNSUBSCRIBE-ROUTE ASSERTIONS PASS");
