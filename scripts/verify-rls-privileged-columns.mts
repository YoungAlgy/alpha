// Verifies protect_user_privileged_columns_trg (supabase/migrations/
// 20260524000000_security_user_column_lock.sql) for real, against a genuine
// non-service-role session -- not the service-role key every other "live"
// verify script in this suite uses (which bypasses RLS and this trigger
// entirely, so none of them could ever catch a regression here).
//
// This trigger is the ONLY thing stopping a signed-in reader from running
// `update users set topic_quota=25, subscribed_at=now() where id=self` via
// the public anon/publishable key and self-granting a full subscription with
// zero Stripe involvement -- the same bug class (a policy/trigger gap on
// public.users-adjacent data) that produced the real, live topic_blurbs
// paywall bypass found and fixed 2026-08-06. It was verified once by hand at
// apply-time (see that migration's own comment) and never since.
//
// Creates a real disposable auth user, gets a genuine authenticated session
// for it (via generateLink + verifyOtp on an ANON-key client -- the same
// mechanism app/api/generate/route.ts uses for real sign-in, see that
// route's 2026-08-06 fix), attempts the locked-column writes through THAT
// session, and cleans up. Costs one real auth user create + delete.
// Run: npx tsx scripts/verify-rls-privileged-columns.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  console.log("SKIP: Supabase env vars not fully set locally.");
  process.exit(0);
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const testEmail = `rls-trigger-verify-${Date.now()}@example.com`;
let userId: string | null = null;

try {
  // --- setup: create a real auth user + get a genuine authenticated session ---
  console.log("(setup) creating a real disposable auth user + session");
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: testEmail,
  });
  if (linkErr || !linkData?.user || !linkData.properties?.hashed_token) {
    console.log(`SKIP: generateLink failed (${linkErr?.message ?? "no token"}).`);
    process.exit(0);
  }
  userId = linkData.user.id;
  // Same lesson as app/api/generate/route.ts's 2026-08-06 fix: a brand-new
  // email's token is type "signup", not "magiclink" -- read the real type
  // instead of assuming.
  const verificationType = linkData.properties.verification_type ?? "magiclink";

  // A FRESH anon-key client, not the admin one -- this is what a real
  // browser's Supabase client is, and verifyOtp on it produces a genuine
  // authenticated (non-service-role) session for subsequent calls.
  const asUser = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: verifyErr } = await asUser.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: verificationType,
  });
  if (verifyErr) {
    console.log(`SKIP: verifyOtp failed (${verifyErr.message}) -- can't get a real session to test with.`);
    process.exit(0);
  }
  const { data: sessionData } = await asUser.auth.getSession();
  check("(setup) got a genuine authenticated session (not service_role)", !!sessionData.session?.access_token);

  // Confirm handle_new_user() actually created the public.users row (admin
  // read, service role -- not part of what's under test here).
  const { data: preRow } = await admin.from("users").select("*").eq("id", userId).maybeSingle();
  check("(setup) public.users row exists for the new auth user", !!preRow);

  // --- (1) privileged columns must NOT change via the authenticated client ---
  console.log("(1) privileged-column writes via the anon-key + user session are silently reverted");
  const before = preRow!;
  const forgedValues = {
    topic_quota: 25,
    subscribed_at: new Date().toISOString(),
    cancelled_at: null,
    stripe_customer_id: "cus_forged_by_verify_script",
    unsubscribed_at: null,
    email: "someone-else@example.com",
  };
  const { error: forgeErr } = await asUser.from("users").update(forgedValues).eq("id", userId);
  // RLS + the trigger mean this UPDATE either matches the row and gets
  // silently overwritten back to OLD values, or -- if something regressed
  // and the UPDATE policy itself no longer matches -- affects 0 rows. Either
  // way the real assertion is the row's CONTENT below, not this call's
  // error/success, since a silently-reverted write reports success.
  void forgeErr;

  const { data: afterForge } = await admin.from("users").select("*").eq("id", userId).maybeSingle();
  check("(1) topic_quota unchanged (trigger held)", afterForge?.topic_quota === before.topic_quota);
  check(
    "(1) subscribed_at unchanged -- THE core paywall-escalation vector this trigger exists to close",
    afterForge?.subscribed_at === before.subscribed_at
  );
  check("(1) stripe_customer_id unchanged", afterForge?.stripe_customer_id === before.stripe_customer_id);
  check("(1) unsubscribed_at unchanged", afterForge?.unsubscribed_at === before.unsubscribed_at);
  check("(1) email unchanged (identity column)", afterForge?.email === before.email);

  // --- (2) a genuine profile field must STILL be self-editable -------------
  // Proves the policy+trigger combo does exactly what it claims -- not
  // failing CLOSED (which would silently break the real onboarding/theme-
  // picker/topics-editor write paths) as well as not failing OPEN (part 1).
  console.log("(2) a real profile column (theme) is still self-editable -- not failing closed");
  const newTheme = before.theme === "sunset" ? "forest" : "sunset";
  const { error: themeErr } = await asUser.from("users").update({ theme: newTheme }).eq("id", userId);
  // Surface the real error, don't just fail silently -- this exact line is
  // what caught alpha-spend-cap-adjacent finding on 2026-08-06: a
  // "permission denied for function topics_all_valid" here (not a theme-
  // specific error) is what revealed that revoking that function's EXECUTE
  // grant broke EVERY self-serve write, not just topics writes, since
  // Postgres re-validates every CHECK constraint on any UPDATE regardless of
  // which columns changed. See 20260806020000_restore_topics_all_valid_execute.sql.
  if (themeErr) console.log(`  (info) update error detail: ${JSON.stringify(themeErr)}`);
  check("(2) theme update call did not error", !themeErr);
  const { data: afterTheme } = await admin.from("users").select("theme").eq("id", userId).maybeSingle();
  check("(2) theme actually changed (self-edit genuinely works)", afterTheme?.theme === newTheme);
} finally {
  // Cleanup: delete the disposable auth user. Cascades to public.users (FK
  // on delete cascade) -- never touches any other row.
  if (userId) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) console.warn(`Cleanup warning: failed to delete test user ${userId}: ${delErr.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RLS PRIVILEGED-COLUMN TRIGGER VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RLS PRIVILEGED-COLUMN TRIGGER ASSERTIONS PASS");
