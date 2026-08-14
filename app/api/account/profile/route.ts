import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { parseBirthday, coerceGender } from "@/lib/demographics";
import { BLURB_CAPS } from "@/lib/types";
import { rateLimit } from "@/lib/rate-limit";
import { codePointSafeSlice } from "@/lib/text-truncate";

export const runtime = "nodejs";

// Self-serve profile edit — lets a signed-in reader change all of their details
// (the things onboarding collected) from /settings, not just topics. Mirrors the
// /api/resume pattern: the SESSION authorizes the caller (so they can only ever
// edit THEIR OWN row), and the actual write goes through the service role
// (public.users self-UPDATE isn't relied on here, same as resume/unsubscribe/
// delete). Unlike the fire-and-forget user-sync, this path is an explicit user
// action with values loaded from the DB first, so it CAN clear an optional blurb.
//
// first_name is the one load-bearing field — the weekly cron skips any row with
// no first_name (and the letter greets by it), so an empty value is rejected.
// city + the three blurbs are personalization: editable and clearable. Lengths
// are capped server-side (onboarding had no cap) to protect both the DB and the
// generation prompt, which reads these fields verbatim.
const LIMITS = {
  first_name: 60,
  city: 120,
  job_blurb: BLURB_CAPS.jobBlurb,
  project_blurb: BLURB_CAPS.projectBlurb,
  fun_blurb: BLURB_CAPS.funBlurb,
} as const;

// A required field: trimmed, must be non-empty, capped. Returns the value or an
// error message. An optional field uses cleanOptional (null when blank).
function cleanRequired(raw: unknown, cap: number): { value: string } | { error: string } {
  if (typeof raw !== "string") return { error: "missing" };
  // Bound before the regex so a pathological multi-MB payload can't make
  // normalization superlinear; the final slice still enforces the real cap.
  // codePointSafeSlice, not raw .slice(): see its own comment
  // (alpha-drift-r19-01) -- a plain .slice() can split a surrogate pair.
  const bounded = raw.length > cap * 8 ? codePointSafeSlice(raw, cap * 8) : raw;
  const v = codePointSafeSlice(bounded.replace(/\s+/g, " ").trim(), cap);
  if (v.length === 0) return { error: "empty" };
  return { value: v };
}

// An optional field: trimmed + capped, or null when the reader cleared it.
// Newlines are preserved for the multiline blurbs (only runs of blank space are
// collapsed) so a deliberately formatted blurb survives.
function cleanOptional(raw: unknown, cap: number): string | null {
  if (typeof raw !== "string") return null;
  const bounded = raw.length > cap * 8 ? codePointSafeSlice(raw, cap * 8) : raw;
  const v = codePointSafeSlice(bounded.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(), cap);
  return v.length > 0 ? v : null;
}

export async function POST(req: Request) {
  const sb = await supabaseServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  // Rate limit per user (not IP): this is a single-row Supabase write behind
  // auth, so the abuse case is a scripted authenticated client hammering it,
  // not an anonymous IP. 30/hr is well above any real settings-page usage.
  const limited = rateLimit(`account-profile:${user.id}`, { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  // alpha-drift-r31-02 (2026-08-14): a literal JSON `null` body parses
  // successfully (`Request.json()` on `null` doesn't throw -- it's valid
  // JSON), so the try/catch above never fires and `body` becomes the JS
  // value `null`. Every property read below (`body.firstName` etc.) would
  // then throw an unhandled TypeError instead of this route's own clean
  // 400 -- the same guard sibling routes get for free from a Zod
  // `.parse()`, which this route intentionally doesn't use (its fields are
  // individually validated via cleanRequired/LIMITS below, not one schema).
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const firstName = cleanRequired(body.firstName, LIMITS.first_name);
  if ("error" in firstName) {
    return NextResponse.json(
      { error: "Your first name can't be blank. It's how your letter greets you." },
      { status: 400 }
    );
  }
  const city = cleanRequired(body.city, LIMITS.city);
  if ("error" in city) {
    return NextResponse.json(
      { error: "Add your city so the letter can flag what's nearby." },
      { status: 400 }
    );
  }

  // Birthday: keep only a real ISO date; empty or invalid clears it to null
  // (the native date input only ever sends a valid date or ""). Gender: only the
  // two stored values; "prefer not to say" or anything else clears to null.
  const rawBday = typeof body.birthday === "string" ? body.birthday.trim() : "";
  const birthday = rawBday && parseBirthday(rawBday) ? rawBday : null;
  const gender = coerceGender(body.gender);

  const updates = {
    first_name: firstName.value,
    city: city.value,
    job_blurb: cleanOptional(body.jobBlurb, LIMITS.job_blurb),
    project_blurb: cleanOptional(body.projectBlurb, LIMITS.project_blurb),
    fun_blurb: cleanOptional(body.funBlurb, LIMITS.fun_blurb),
    birthday,
    gender,
  };

  const svc = await supabaseServiceClient();
  const { error } = await svc.from("users").update(updates).eq("id", user.id);
  if (error) {
    console.error("[account/profile] update failed:", error.message);
    return NextResponse.json({ error: "Couldn't save. Try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, profile: updates });
}
