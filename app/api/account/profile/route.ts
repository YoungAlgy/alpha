import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { parseBirthday } from "@/lib/demographics";

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
  job_blurb: 500,
  project_blurb: 500,
  fun_blurb: 500,
} as const;

// A required field: trimmed, must be non-empty, capped. Returns the value or an
// error message. An optional field uses cleanOptional (null when blank).
function cleanRequired(raw: unknown, cap: number): { value: string } | { error: string } {
  if (typeof raw !== "string") return { error: "missing" };
  // Bound before the regex so a pathological multi-MB payload can't make
  // normalization superlinear; the final slice still enforces the real cap.
  const bounded = raw.length > cap * 8 ? raw.slice(0, cap * 8) : raw;
  const v = bounded.replace(/\s+/g, " ").trim().slice(0, cap);
  if (v.length === 0) return { error: "empty" };
  return { value: v };
}

// An optional field: trimmed + capped, or null when the reader cleared it.
// Newlines are preserved for the multiline blurbs (only runs of blank space are
// collapsed) so a deliberately formatted blurb survives.
function cleanOptional(raw: unknown, cap: number): string | null {
  if (typeof raw !== "string") return null;
  const bounded = raw.length > cap * 8 ? raw.slice(0, cap * 8) : raw;
  const v = bounded.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, cap);
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
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
  const gender = body.gender === "male" || body.gender === "female" ? body.gender : null;

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
