import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";
import { clampQuota } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";
import { rateLimit } from "@/lib/rate-limit";
import { validateTopicsSubmission } from "@/lib/account-topics-guards";

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

  // The real per-user cap needs a DB read to compute (poolCap depends on
  // this reader's topic_quota) -- see lib/account-topics-guards.ts for the
  // full validation chain (empty-pool floor, dup check, isValidTopicId scan)
  // and why the empty-pool floor in particular matters: the DB's own
  // users_topics_len_chk CHECK constraint doesn't catch it (Postgres's
  // array_length of an empty array is NULL, which satisfies that
  // constraint's `topics is null or array_length(...) <= 25` OR), so an
  // empty pool would otherwise silently drop the subscriber from every send
  // (weekly-send/route.ts's skippedEmptyPool path).
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

  const result = validateTopicsSubmission(body.topics, cap);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const { topics } = result;

  const { error } = await svc.from("users").update({ topics }).eq("id", user.id);
  if (error) {
    console.error("[account/topics] update failed:", error.message);
    return NextResponse.json({ error: "Couldn't save. Try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, topics });
}
