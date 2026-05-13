import { NextResponse } from "next/server";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ADMIN_EMAIL = "youngalgy@gmail.com";

async function requireAdmin(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const sb = await supabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  if (user.email !== ADMIN_EMAIL) {
    return { ok: false, res: NextResponse.json({ error: "Not authorized" }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  const sb = await supabaseServiceClient();
  const { data, error } = await sb
    .from("users")
    .select("id, email, first_name, city, theme, topics, stripe_customer_id, subscribed_at, cancelled_at, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ users: data });
}

interface ActionBody {
  action: "delete" | "grant_free" | "revoke_free";
  userId: string;
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.res;

  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const sb = await supabaseServiceClient();

  if (body.action === "delete") {
    // Delete the auth user — cascade removes their public.users + issues rows.
    const { error } = await sb.auth.admin.deleteUser(body.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "grant_free") {
    // Mark as subscribed without a Stripe customer. App checks subscribed_at.
    const { error } = await sb
      .from("users")
      .update({
        subscribed_at: new Date().toISOString(),
        cancelled_at: null,
      })
      .eq("id", body.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "revoke_free") {
    // Only revokes the free-grant flag — does NOT touch real Stripe subs.
    // Guard: only revoke if there's no stripe_customer_id (i.e., they were free-granted).
    const { data: row } = await sb
      .from("users")
      .select("stripe_customer_id")
      .eq("id", body.userId)
      .maybeSingle();
    if (row?.stripe_customer_id) {
      return NextResponse.json(
        { error: "User has a real Stripe subscription — manage in Stripe." },
        { status: 400 }
      );
    }
    const { error } = await sb
      .from("users")
      .update({ subscribed_at: null })
      .eq("id", body.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
