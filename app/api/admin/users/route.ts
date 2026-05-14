import { NextResponse } from "next/server";
import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { supabaseServerClient, supabaseServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ADMIN_EMAIL = "youngalgy@gmail.com";

interface Stats {
  totalUsers: number;
  paying: number;
  freeGranted: number;
  cancelled: number;
  unsubscribed: number;
  notSubscribed: number;
  latestIssueWeekOf: string | null;
  latestIssueCount: number;
  sesProductionAccess: boolean | null;
  sesMaxSendsPerDay: number | null;
}

async function gatherStats(): Promise<Stats> {
  const sb = await supabaseServiceClient();

  // One query, in-memory aggregation — small population, fine for V1
  const { data: rows } = await sb
    .from("users")
    .select("subscribed_at, cancelled_at, unsubscribed_at, stripe_customer_id");

  const stats = {
    totalUsers: rows?.length ?? 0,
    paying: 0,
    freeGranted: 0,
    cancelled: 0,
    unsubscribed: 0,
    notSubscribed: 0,
  };
  for (const r of rows ?? []) {
    if (r.unsubscribed_at) stats.unsubscribed++;
    if (r.cancelled_at) stats.cancelled++;
    else if (r.subscribed_at && r.stripe_customer_id) stats.paying++;
    else if (r.subscribed_at && !r.stripe_customer_id) stats.freeGranted++;
    else stats.notSubscribed++;
  }

  // Latest issue snapshot — surfaces whether the weekly cron is running
  const { data: latestIssues } = await sb
    .from("issues")
    .select("week_of")
    .order("week_of", { ascending: false })
    .limit(1);
  const latestWeekOf = latestIssues?.[0]?.week_of ?? null;

  let latestIssueCount = 0;
  if (latestWeekOf) {
    const { count } = await sb
      .from("issues")
      .select("*", { count: "exact", head: true })
      .eq("week_of", latestWeekOf);
    latestIssueCount = count ?? 0;
  }

  // SES production-access probe — costs an extra AWS call but it's the most
  // load-bearing operational flag right now (sandbox = signins broken for
  // non-verified recipients).
  let sesProductionAccess: boolean | null = null;
  let sesMaxSendsPerDay: number | null = null;
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const ses = new SESv2Client({
        region: process.env.AWS_REGION?.trim() || "us-east-1",
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
        },
      });
      const r = await ses.send(new GetAccountCommand({}));
      sesProductionAccess = !!r.ProductionAccessEnabled;
      sesMaxSendsPerDay = r.SendQuota?.Max24HourSend ?? null;
    } catch (e) {
      console.warn("[admin/users] SES probe failed:", e instanceof Error ? e.message : e);
    }
  }

  return {
    ...stats,
    latestIssueWeekOf: latestWeekOf,
    latestIssueCount,
    sesProductionAccess,
    sesMaxSendsPerDay,
  };
}

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
  const [{ data: users, error }, stats] = await Promise.all([
    sb
      .from("users")
      .select("id, email, first_name, city, theme, topics, stripe_customer_id, subscribed_at, cancelled_at, unsubscribed_at, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    gatherStats(),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ users, stats });
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
