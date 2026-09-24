import { NextResponse, after } from "next/server";
import { isAuthSessionMissingError, type User } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { clientKeyFromRequest, rateLimit } from "@/lib/rate-limit";
import { consumeDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { isValidTopicId, MAX_CUSTOM_TOPIC_LEN, CUSTOM_PREFIX } from "@/lib/topics";
import { BLURB_CAPS } from "@/lib/types";
import { parseBirthday } from "@/lib/demographics";
import { coerceThemeId } from "@/lib/themes";
import { isInviteOnly } from "@/lib/access-mode";
import { hasReaderAccess } from "@/lib/access";
import {
  authOwnsAccessRequestEmail,
  normalizeAccessRequestEmail,
} from "@/lib/access-request-ownership";
import { sendOpsWebhookAlert } from "@/lib/email";
import { hasUsableReaderProfile } from "@/lib/reader-profile-state";

export const runtime = "nodejs";

const RequestSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  city: z.string().trim().max(120).default(""),
  jobBlurb: z.string().trim().max(BLURB_CAPS.jobBlurb).optional(),
  projectBlurb: z.string().trim().max(BLURB_CAPS.projectBlurb).optional(),
  funBlurb: z.string().trim().max(BLURB_CAPS.funBlurb).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => parseBirthday(value) !== null, "invalid birthday").optional(),
  gender: z.enum(["male", "female"]).optional(),
  topics: z.array(z.string().min(1).max(MAX_CUSTOM_TOPIC_LEN + CUSTOM_PREFIX.length))
    .length(5)
    .refine((items) => items.every(isValidTopicId), "unrecognized topic")
    .refine((items) => new Set(items).size === items.length, "duplicate topic"),
  theme: z.string().max(30).transform((value) => coerceThemeId(value) ?? "forest"),
  email: z.string().trim().email(),
});

export async function POST(req: Request) {
  if (!isInviteOnly(true)) {
    return NextResponse.json({ error: "Invite access is not enabled." }, { status: 404 });
  }

  const mediaType = req.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return NextResponse.json(
      { error: "Access requests must use JSON." },
      { status: 415 }
    );
  }

  const clientKey = clientKeyFromRequest(req);
  // Malformed or signed-out attempts need a short abuse brake. They must
  // not consume a household's daily allowance for confirmed requests.
  const burst = rateLimit(`access-request-burst:${clientKey}`, {
    limit: 10,
    windowMs: 60 * 1000,
  });
  if (!burst.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(burst.retryAfterSec) } }
    );
  }

  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Please complete your profile and use a valid email." }, { status: 400 });
  }

  const email = normalizeAccessRequestEmail(input.email);
  if (!email) {
    return NextResponse.json(
      { error: "Please complete your profile and use a valid email." },
      { status: 400 }
    );
  }

  let signedInUser: User | null = null;
  try {
    const authClient = await supabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();
    if (authError && !isAuthSessionMissingError(authError)) {
      console.error("[access/request] authenticated account lookup failed:", authError.message);
      return NextResponse.json(
        {
          error: "authentication_unavailable",
          message: "Email confirmation is temporarily unavailable. Try again shortly.",
        },
        { status: 503, headers: { "Retry-After": "60" } }
      );
    }
    signedInUser = user;
  } catch (authError) {
    console.error(
      "[access/request] authenticated account lookup failed:",
      authError instanceof Error ? authError.message : "unknown error"
    );
    return NextResponse.json(
      {
        error: "authentication_unavailable",
        message: "Email confirmation is temporarily unavailable. Try again shortly.",
      },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }

  if (!signedInUser || !signedInUser.email_confirmed_at) {
    return NextResponse.json(
      {
        error: "identity_verification_required",
        message: "Confirm this email before requesting access.",
      },
      { status: 401 }
    );
  }
  if (!authOwnsAccessRequestEmail(signedInUser.email, email)) {
    return NextResponse.json(
      {
        error: "authenticated_email_mismatch",
        message:
          "The signed-in account uses a different email. Go back and use that account email, or sign out before trying this one.",
      },
      { status: 403 }
    );
  }

  const limited = rateLimit(`access-request:${clientKey}`, {
    limit: 3,
    windowMs: 24 * 60 * 60 * 1000,
  });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again tomorrow." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let sb: Awaited<ReturnType<typeof supabaseServiceClient>>;
  try {
    sb = await supabaseServiceClient();
  } catch {
    return NextResponse.json(
      { error: "Access requests are temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  const [ipLimit, emailLimit] = await Promise.all([
    consumeDistributedRateLimit(sb, "access-request-ip", clientKey, {
      limit: 3,
      windowMs: 24 * 60 * 60 * 1000,
    }),
    consumeDistributedRateLimit(sb, "access-request-email", email, {
      limit: 3,
      windowMs: 24 * 60 * 60 * 1000,
    }),
  ]);
  if (!ipLimit.available || !emailLimit.available) {
    return NextResponse.json(
      { error: "Request protection is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
  const blocked = !ipLimit.ok ? ipLimit : !emailLimit.ok ? emailLimit : null;
  if (blocked) {
    return NextResponse.json(
      { error: "Too many requests. Try again tomorrow." },
      { status: 429, headers: { "Retry-After": String(blocked.retryAfterSec) } }
    );
  }
  const userId = signedInUser.id;
  const now = new Date().toISOString();
  const profile = {
    email,
    first_name: input.firstName,
    city: input.city || null,
    job_blurb: input.jobBlurb || null,
    project_blurb: input.projectBlurb || null,
    fun_blurb: input.funBlurb || null,
    birthday: input.birthday || null,
    gender: input.gender || null,
    topics: input.topics,
    theme: input.theme,
    access_requested_at: now,
  };

  const { data: existing, error: existingError } = await sb
    .from("users")
    .select("id, updated_at, first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics, theme, subscribed_at, cancelled_at, access_granted_at, stripe_customer_id")
    .eq("id", userId)
    .maybeSingle();
  if (existingError) {
    console.error("[access/request] profile lookup failed:", existingError.message);
    return NextResponse.json({ error: "We couldn't receive that request. Try again shortly." }, { status: 503 });
  }
  if (
    hasReaderAccess(
      existing?.subscribed_at,
      existing?.cancelled_at,
      existing?.access_granted_at
    )
  ) {
    // An owner can approve an auth-created row before the reader finishes
    // onboarding. Let that reader explicitly fill only missing profile fields.
    // A completed reader's older browser draft must never replace saved data.
    if (!existing?.access_granted_at || hasUsableReaderProfile(existing)) {
      return NextResponse.json({ error: "This account already has Alpha access." }, { status: 409 });
    }
    const repair = {
      first_name: existing.first_name?.trim() ? existing.first_name : profile.first_name,
      topics: hasUsableReaderProfile({
        first_name: existing.first_name?.trim() ? existing.first_name : profile.first_name,
        topics: existing.topics,
        birthday: existing.birthday || profile.birthday,
      })
        ? existing.topics : profile.topics,
      city: existing.city || profile.city,
      job_blurb: existing.job_blurb || profile.job_blurb,
      project_blurb: existing.project_blurb || profile.project_blurb,
      fun_blurb: existing.fun_blurb || profile.fun_blurb,
      birthday: existing.birthday || profile.birthday,
      gender: existing.gender || profile.gender,
      // The auth-created row only has the schema default theme. Keep a theme
      // the reader already changed while signed in, otherwise use their pick.
      theme: existing.theme && existing.theme !== "forest" ? existing.theme : profile.theme,
    };
    let repairWrite = sb.from("users").update(repair)
      .eq("id", userId)
      .eq("access_granted_at", existing.access_granted_at);
    repairWrite = existing.updated_at
      ? repairWrite.eq("updated_at", existing.updated_at)
      : repairWrite.is("updated_at", null);
    const repaired = await repairWrite.select("id").maybeSingle();
    if (repaired.error) {
      console.error("[access/request] approved profile repair failed:", repaired.error.message);
      return NextResponse.json({ error: "We couldn't save your profile. Try again shortly." }, { status: 503 });
    }
    if (!repaired.data) {
      return NextResponse.json({ error: "Your account changed while saving. Check your profile and try again." }, { status: 409 });
    }
    // The reader is already approved, so they never enter Pending. Tell the
    // owner that letters can be enabled now.
    try {
      after(() =>
        sendOpsWebhookAlert(
          "alpha: approved reader finished signup",
          "An approved Alpha reader saved their name and topics. Letters can be enabled from the Accounts panel."
        )
      );
    } catch {
      console.warn("[access/request] optional ops alert could not be scheduled");
    }
    return NextResponse.json({ ok: true, repaired: true });
  }

  let result;
  if (existing) {
    let requestWrite = sb.from("users").update(profile).eq("id", userId);
    requestWrite = existing.subscribed_at
      ? requestWrite.eq("subscribed_at", existing.subscribed_at)
      : requestWrite.is("subscribed_at", null);
    requestWrite = existing.access_granted_at
      ? requestWrite.eq("access_granted_at", existing.access_granted_at)
      : requestWrite.is("access_granted_at", null);
    requestWrite = existing.updated_at
      ? requestWrite.eq("updated_at", existing.updated_at)
      : requestWrite.is("updated_at", null);
    result = await requestWrite.select("id").maybeSingle();
  } else {
    result = await sb.from("users").insert({ id: userId, ...profile }).select("id").maybeSingle();
  }
  if (result.error?.code === "23505" || (!result.error && !result.data)) {
    return NextResponse.json({ error: "Your account changed while saving. Refresh and try again." }, { status: 409 });
  }
  if (result.error || !result.data) {
    console.error("[access/request] profile write failed:", result.error?.message ?? "no row returned");
    return NextResponse.json({ error: "We couldn't receive that request. Try again shortly." }, { status: 503 });
  }

  // The database row is the source of truth. This optional Alpha-only webhook
  // carries no subscriber fields and cannot make a successful request fail.
  try {
    after(() =>
      sendOpsWebhookAlert(
        "alpha: access request pending",
        "A confirmed Alpha account submitted an access request. Review the Accounts panel."
      )
    );
  } catch {
    console.warn("[access/request] optional ops alert could not be scheduled");
  }

  return NextResponse.json({ ok: true, requestedAt: now });
}
