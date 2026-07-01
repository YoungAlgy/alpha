import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { isValidTopicId } from "@/lib/topics";
import { clampQuota } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";

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

  let body: { topics?: unknown };
  try {
    body = (await req.json()) as { topics?: unknown };
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  if (!Array.isArray(body.topics) || body.topics.some((t) => typeof t !== "string")) {
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
