import { supabaseServiceClient } from "@/lib/supabase/server";
import { coerceGender } from "@/lib/demographics";
import { sendOpsAlert, removeResendSuppression } from "@/lib/email";
import type { Issue, UserProfile } from "@/lib/types";

interface PersistResult {
  userId: string;
  // The verifiable token from generateLink(), NOT the raw action_link URL --
  // found in review 2026-08-06: returning the full link in the /api/generate
  // JSON response body put a live, fully-authenticating bearer credential
  // directly into a JS-readable fetch response (any extension with response-
  // reading permissions, or a future XSS foothold, gets full account
  // takeover of the reader who just paid -- a materially larger exposure
  // than the email-delivery channel this replaced). The caller verifies this
  // hash server-side instead (auth.verifyOtp) and never ships the raw token
  // to the client at all.
  hashedToken: string | null;
  // The verification type to pass to auth.verifyOtp alongside hashedToken --
  // see hashedToken's sibling comment on why this can't be hardcoded to
  // "magiclink".
  verificationType: string;
}

function supabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

// The set of profile fields that the incoming request actually HAS a value for.
// Used to UPDATE an existing public.users row WITHOUT clobbering: a field the
// caller left empty is omitted, so it can never null out a real subscriber's
// saved blurbs/city/theme/topics. Mirrors the non-clobbering pattern in
// lib/user-sync.ts. (The first-letter INSERT path still writes the full profile
// — see persistIssueIfPossible — because onboarding always carries every field.)
function nonEmptyProfileFields(profile: UserProfile): Record<string, string | string[]> {
  const f: Record<string, string | string[]> = {};
  if (profile.firstName?.trim()) f.first_name = profile.firstName.trim();
  if (profile.city?.trim()) f.city = profile.city.trim();
  if (profile.jobBlurb?.trim()) f.job_blurb = profile.jobBlurb.trim();
  if (profile.projectBlurb?.trim()) f.project_blurb = profile.projectBlurb.trim();
  if (profile.funBlurb?.trim()) f.fun_blurb = profile.funBlurb.trim();
  if (profile.birthday?.trim()) f.birthday = profile.birthday.trim();
  const g = coerceGender(profile.gender);
  if (g) f.gender = g;
  if (profile.theme?.trim()) f.theme = profile.theme.trim();
  if (Array.isArray(profile.topics) && profile.topics.length > 0) f.topics = profile.topics;
  return f;
}

/**
 * Best-effort persistence of a freshly-generated issue. Idempotent over the
 * (user_id, week_of) unique constraint — re-runs will upsert.
 *
 * Pattern: use service-role admin.generateLink to find-or-create the auth user
 * by email AND get a verifiable token in one round trip. The caller verifies
 * it server-side (auth.verifyOtp) to establish a real session via cookies --
 * see hashedToken's own comment for why the raw link is never returned here.
 *
 * Returns null if Supabase isn't configured or no email is available — letter
 * still renders fine, just isn't archived.
 */
export async function persistIssueIfPossible(
  profile: UserProfile,
  issue: Issue,
  weekOf: string,
  // alpha-drift-r17-03 (found+fixed 2026-08-07): pass the userId verifyPaid()
  // already resolved for an AUTHENTICATED re-generate call (never set for a
  // true first-time/anonymous signup, where there's no existing account to
  // race against). generateLink's find-or-create-by-email behavior below is
  // exactly the mechanism that let a deleted account get silently
  // resurrected: /api/generate can run up to GENERATE_DEADLINE_MS=105s, and
  // if the SAME user deletes their account (app/api/account/delete/route.ts,
  // cascades within seconds) while their own generate call is still in
  // flight, generateLink finds no auth user for that email anymore and
  // IMPLICITLY CREATES A NEW ONE -- this function then inserts a full
  // profile row from the stale in-memory object and the caller establishes
  // a fresh session, undoing the deletion moments after it happened. When
  // expectedUserId is set, re-verify that exact user still exists right
  // before generateLink -- narrows the race window from the full up-to-105s
  // generation time down to the couple of Supabase round trips between this
  // check and generateLink itself (doesn't eliminate the race entirely --
  // that would need a DB-level lock -- but a proportionate reduction from
  // "the whole generation" to "milliseconds," matching this file's own
  // established bar elsewhere for a real risk vs. full-fix complexity).
  expectedUserId?: string
): Promise<PersistResult | null> {
  if (!supabaseConfigured()) return null;
  // We can't write to public.users / public.issues without a user_id (RLS).
  // Email is the bootstrap identifier.
  // Lowercase so the auth user + public.users row key on the same canonical
  // email the checkout/webhook paths use (emails are case-insensitive in
  // practice; Supabase auth lowercases anyway).
  const email = profile.email?.toLowerCase().trim();
  if (!email) return null;

  try {
    const sb = await supabaseServiceClient();

    if (expectedUserId) {
      const { data: stillExists } = await sb.auth.admin.getUserById(expectedUserId);
      if (!stillExists?.user) {
        console.warn(
          `[persist] expectedUserId ${expectedUserId} (${email}) no longer exists -- account was likely deleted while this generate call was in flight. Skipping persistence rather than letting generateLink create a new account for this email.`
        );
        return null;
      }
    }

    // Find-or-create auth user + grab a sign-in link in one call
    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        // .trim(): a trailing space/newline pasted into the Vercel env var
        // silently breaks the redirect URL (and Supabase's allowlist match).
        redirectTo: process.env.NEXT_PUBLIC_APP_URL?.trim()
          ? `${process.env.NEXT_PUBLIC_APP_URL.trim()}/auth/callback?next=/inbox`
          : undefined,
      },
    });
    if (linkErr || !linkData?.user) {
      console.warn("[persist] generateLink failed:", linkErr?.message);
      return null;
    }
    const userId = linkData.user.id;
    const hashedToken = linkData.properties?.hashed_token ?? null;
    // NOT always "magiclink", despite requesting type: "magiclink" above --
    // verified live (2026-08-06): for an email with no EXISTING confirmed
    // auth user, generateLink implicitly creates one via the signup path,
    // and the token it returns must be verified as type "signup", not
    // "magiclink" (verifyOtp rejects it with "Email link is invalid or has
    // expired" otherwise -- caught by an end-to-end browser test before
    // shipping, not by reasoning about the SDK's types alone). Only a
    // RETURNING reader (an existing confirmed user) actually gets a true
    // "magiclink" token back. Read the real type Supabase assigned instead
    // of assuming it matches the request.
    const verificationType = linkData.properties?.verification_type ?? "magiclink";

    // alpha-drift-r18-01 (found+fixed 2026-08-07): this endpoint has its own
    // find-or-create-by-email path, entirely separate from the Stripe webhook
    // -- generateLink above will happily mint a fresh auth user (and this
    // function then writes a full profile row) for an email that bounced or
    // complained on a PREVIOUS, since-deleted account. This app's own
    // bounced_at/complained_at columns don't even apply here (a brand-new
    // row starts NULL either way) -- the actual problem lives entirely in
    // Resend's own account-level suppression list, which is keyed by email,
    // not by this app's user id.
    //
    // alpha-drift-r19-01 (found+fixed 2026-08-07): this used to run
    // unconditionally on EVERY call, including an already-subscribed
    // reader's Nth re-generate (verifyPaid()'s authenticated branch is live
    // and repeatable -- see app/api/generate/route.ts's own user-keyed rate
    // limit, added the same round for exactly that reason). removeResend
    // Suppression carries its own 15s network timeout and sits OUTSIDE
    // generateIssue's withDeadline wrapper -- GENERATE_DEADLINE_MS=105s
    // against a 120s maxDuration leaves only ~15s of designed headroom for
    // everything after generation, so an unconditional extra 15s-capable
    // call here could alone push an ordinary regenerate into a hard
    // platform timeout during a Resend slowdown, for a reader who was never
    // suppressed and gains nothing from the check. verificationType (just
    // computed above) already tells us exactly who needs this: "signup"
    // means generateLink just implicitly CREATED this auth user -- a true
    // first-time signup, or a resubscribe after a full account deletion
    // (same implicit-create path, since the old account no longer exists to
    // find) -- both real re-consent moments where a stale suppression could
    // exist. "magiclink" means an already-existing, continuously-active
    // account, which was never suppressed by definition of still existing
    // normally. AWAITED (never fire-and-forget -- see assemble.ts's
    // blurb-cache write for why that class of bug is real on Workers), but
    // failures here can't block onboarding: removeResendSuppression already
    // swallows and logs its own errors.
    if (verificationType !== "magiclink") {
      await removeResendSuppression(email);
    }

    // Sync the profile fields onto public.users (service role bypasses RLS).
    // Surface failures: this row is what the weekly cron reads — a silently
    // failed sync means next Sunday's letter generates from stale/missing
    // profile data with no trace of why.
    //
    // NON-CLOBBERING insert/update split (was a full-row upsert). A full-row
    // upsert on conflict overwrites EVERY column with the incoming payload, so
    // the day a re-generate path posts a sparse body (ProfileSchema makes the
    // blurbs optional) it would null an existing paid subscriber's
    // job/project/fun blurbs and stomp city/theme/topics with partial client
    // data — the same silent data-loss class as the user-sync.ts bug. So:
    //   • brand-new row  → write the FULL profile (onboarding always carries
    //     every field, and the cron needs first_name + topics present).
    //   • existing row   → write only the fields the caller actually has a
    //     value for; never overwrite a real value with empty/partial input.
    const { data: existingUser } = await sb
      .from("users")
      .select("id")
      .eq("id", userId)
      .maybeSingle();

    if (!existingUser) {
      const { error: insErr } = await sb.from("users").insert({
        id: userId,
        email,
        first_name: profile.firstName,
        city: profile.city || null,
        job_blurb: profile.jobBlurb || null,
        project_blurb: profile.projectBlurb || null,
        fun_blurb: profile.funBlurb || null,
        birthday: profile.birthday || null,
        gender: coerceGender(profile.gender),
        theme: profile.theme || "forest",
        topics: profile.topics,
      });
      if (insErr) {
        // Lost a race with a concurrent insert (e.g. the Stripe checkout
        // webhook creating the row mid-generation) — the row now exists, so
        // fall back to a non-clobbering update instead of dropping the topics.
        const updates = nonEmptyProfileFields(profile);
        if (Object.keys(updates).length > 0) {
          const { error: raceErr } = await sb
            .from("users")
            .update(updates)
            .eq("id", userId);
          if (raceErr) {
            console.error(
              "[persist] users profile insert raced AND update fallback failed:",
              insErr.message,
              raceErr.message
            );
            await sendOpsAlert(
              "alpha profile sync failed",
              `users profile insert raced AND update fallback failed for user ${userId} (${email}): insert=${insErr.message}; update=${raceErr.message}`,
              `alpha-persist-insert-race-${userId}`
            );
          }
        }
      }
    } else {
      const updates = nonEmptyProfileFields(profile);
      if (Object.keys(updates).length > 0) {
        const { error: updErr } = await sb
          .from("users")
          .update(updates)
          .eq("id", userId);
        if (updErr) {
          console.error("[persist] users profile update failed:", updErr.message);
          await sendOpsAlert(
            "alpha profile sync failed",
            `users profile update failed for existing user ${userId} (${email}): ${updErr.message}`,
            `alpha-persist-update-${userId}`
          );
        }
      }
    }

    // Persist the issue. ignoreDuplicates -- NOT an unconditional overwrite
    // -- so a concurrent call for the same (user_id, week_of) can't stomp
    // content another call already wrote. Real scenario, not hypothetical:
    // this function's own caller (app/api/generate/route.ts) explicitly
    // anticipates "double-submits, retries that succeeded the first time
    // but the client never saw the response" via its idempotent
    // deliverLetterOnce claim downstream -- but that claim only guards the
    // SEND, not this write. Two concurrent /api/generate calls for the same
    // signup would previously both reach here and whichever upserted LAST
    // won regardless of which one later won the send claim, same failure
    // class the cron's runPersistAndSend had (see its 2026-08-05 fix and
    // alpha_full_app_review_2026-08-05.md in Claude's memory). Not a full
    // fix of that same class -- an ignoreDuplicates guard here can't
    // guarantee the CLAIM winner's content is what's persisted, only that
    // content is written once, by whichever caller arrives first, instead
    // of last-write-wins -- but it's a real improvement for a real risk at
    // a fraction of the cron fix's complexity, appropriate to this
    // narrower, one-time-per-user blast radius (a rare double-submit at
    // onboarding, not the cron's every-single-day systemic exposure).
    const { error: issueErr } = await sb.from("issues").upsert(
      {
        user_id: userId,
        week_of: weekOf,
        volume: issue.volume,
        number: issue.number,
        editor_intro: issue.editorIntro,
        sections: issue.sections,
      },
      { onConflict: "user_id,week_of", ignoreDuplicates: true }
    );
    if (issueErr) {
      console.warn("[persist] issue upsert failed:", issueErr.message);
    }

    return { userId, hashedToken, verificationType };
  } catch (e) {
    console.warn("[persist] exception:", e instanceof Error ? e.message : e);
    return null;
  }
}
