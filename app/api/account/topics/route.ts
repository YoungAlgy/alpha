import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { isValidTopicId } from "@/lib/topics";
import { clampQuota } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Self-serve topic-pool edit — the signed-in equivalent of onboarding's topic
// picker, called from /topics when a subscriber changes their picks. Mirrors
// the /api/account/profile pattern: the SESSION authorizes the caller (so they
// can only ever edit THEIR OWN row), and the actual write goes through the
// service role rather than the browser's own "users self update" RLS policy.
//
// The DB's BEFORE UPDATE trigger (20260524000000_security_user_column_lock)
// already stops a direct browser write from touching topic_quota/billing
// columns, and a CHECK constraint caps the array at 25 -- this route is
// defense in depth on top of both, not a replacement: it validates every
// entry is a real topic via isValidTopicId (known catalog id or a well-formed
// custom: string, not an arbitrary value a crafted request could otherwise
// smuggle into the generation prompt) and caps the length at THIS reader's
// actual poolCap (quota + backup slots), not just the flat 25-wide table
// constraint.

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
  // not an anonymous IP. 30/hr is well above any real /topics-page usage.
  const limited = rateLimit(`account-topics:${user.id}`, { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  let body: { topics?: unknown };
  try {
    body = (await req.json()) as { topics?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  // Length-check BEFORE the type-scan below: the real per-user cap needs a DB
  // read to compute (poolCap depends on this reader's topic_quota), but a
  // generous absolute bound here rejects a garbage oversized array in O(1)
  // instead of running a full .some() scan over it first. MAX_TOPIC_QUOTA is
  // 25; poolCap adds a handful of backup slots on top, so 100 is well above
  // any real cap while still being a real bound.
  if (!Array.isArray(body.topics) || body.topics.length > 100) {
    return NextResponse.json({ error: "Topics must be a list." }, { status: 400 });
  }
  if (body.topics.some((t) => typeof t !== "string")) {
    return NextResponse.json({ error: "Topics must be a list." }, { status: 400 });
  }
  const topics = body.topics as string[];

  const svc = await supabaseServiceClient();
  const { data: row, error: readErr } = await svc
    .from("users")
    .select("topic_quota")
    .eq("id", user.id)
    .maybeSingle();
  if (readErr) {
    console.error("[account/topics] quota lookup failed:", readErr.message);
    return NextResponse.json({ error: "Couldn't save. Try again." }, { status: 500 });
  }
  const cap = poolCap(clampQuota(row?.topic_quota ?? 5));

  if (topics.length > cap) {
    return NextResponse.json(
      { error: `You can pick up to ${cap} topics on your plan.` },
      { status: 400 }
    );
  }
  if (new Set(topics).size !== topics.length) {
    return NextResponse.json({ error: "That list has a duplicate topic in it." }, { status: 400 });
  }
  if (topics.some((t) => !isValidTopicId(t))) {
    return NextResponse.json({ error: "One of those topics isn't recognized." }, { status: 400 });
  }

  const { error } = await svc.from("users").update({ topics }).eq("id", user.id);
  if (error) {
    console.error("[account/topics] update failed:", error.message);
    return NextResponse.json({ error: "Couldn't save. Try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, topics });
}
