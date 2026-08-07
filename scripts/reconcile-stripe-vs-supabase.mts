// alpha-drift-r14-10 (review 2026-08-06): nothing anywhere periodically
// compared Stripe's live subscription state against public.users. A
// permanently-failed webhook (past Stripe's ~3-day retry window -- a schema
// drift, an RLS change, a real bug, exactly the class of incident this
// session already hit once this same day with the topics_all_valid EXECUTE
// revoke) would silently desync the two systems forever, with nothing
// surfacing the discrepancy to Algy. The webhook route's own comment
// already admits this in plain language: "if it keeps failing past the
// retry window... Stripe's dashboard shows it, but nothing here is
// watching that dashboard."
//
// Reuses the REAL app logic (hasActiveAccess, isTerminalSubscriptionStatus,
// clampQuota) rather than reimplementing the rules here -- importing from
// lib/ instead of copying them is the whole point: this script's job is to
// catch drift, not become a second, potentially-inconsistent copy of the
// same rules it's checking against.
//
// alpha-drift-r15-14 (found+fixed 2026-08-06): this used to import
// isLiveForManagement from lib/update-quantity-guards.ts instead --
// that set ({active, trialing, past_due}) is scoped to "should this
// subscription be findable by the quantity-change flow," not a general
// Stripe-side liveness check, and doesn't cover `incomplete` or `paused`.
// Neither of those is in deriveCancelledAt's terminal set either (so the
// DB correctly leaves cancelled_at null for them), which meant a
// subscription in either status produced a false-positive access_mismatch
// finding every single reconcile run, for a real, ordinary transient
// Stripe state that was never actually a bug. isTerminalSubscriptionStatus
// is the SAME notion of liveness deriveCancelledAt itself uses to decide
// what the DB should contain -- using it here means this script is
// actually comparing Stripe against the rule that governs the DB, not
// against a narrower, unrelated rule that happens to share a name.
//
// Run: STRIPE_SECRET_KEY=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//      RESEND_API_KEY=... npx tsx scripts/reconcile-stripe-vs-supabase.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!stripeSecret || !supabaseUrl || !supabaseKey) {
  console.log("SKIP: STRIPE_SECRET_KEY / SUPABASE_URL / SUPABASE_SECRET_KEY not all set.");
  process.exit(0);
}

const { getStripeClient } = await import("../lib/stripe.ts");
const { hasActiveAccess } = await import("../lib/access.ts");
const { isTerminalSubscriptionStatus } = await import("../lib/webhook-user-mutation.ts");
const { clampQuota, TOPICS_PER_BUNDLE } = await import("../lib/types.ts");
const { createClient } = await import("@supabase/supabase-js");
const { sendOpsAlert } = await import("../lib/email.ts");

const stripe = getStripeClient();
const sb = createClient(supabaseUrl, supabaseKey);

// --- 1. Every Stripe subscription, paginated. Keep the "best" one per
// customer -- prefer a non-terminal one (active/trialing/past_due/
// incomplete/paused) over a terminal one if a customer somehow has both
// (e.g. an old canceled sub plus a fresh resubscribe), since the
// non-terminal one is what actually governs access. ---
type SubSummary = { id: string; status: Parameters<typeof isTerminalSubscriptionStatus>[0]; quantity: number };
const subsByCustomer = new Map<string, SubSummary>();
let startingAfter: string | undefined;
for (;;) {
  const page = await stripe.subscriptions.list({ status: "all", limit: 100, starting_after: startingAfter });
  for (const sub of page.data) {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const summary: SubSummary = { id: sub.id, status: sub.status, quantity: sub.items?.data?.[0]?.quantity ?? 1 };
    const existing = subsByCustomer.get(customerId);
    if (!existing || (!isTerminalSubscriptionStatus(summary.status) && isTerminalSubscriptionStatus(existing.status))) {
      subsByCustomer.set(customerId, summary);
    }
  }
  if (!page.has_more || page.data.length === 0) break;
  startingAfter = page.data[page.data.length - 1]?.id;
}

// --- 2. Every public.users row with a stripe_customer_id, paginated the
// same way every other full-table read in this codebase already is. ---
type UserRow = { id: string; stripe_customer_id: string; cancelled_at: string | null; topic_quota: number | null };
const PAGE_SIZE = 1000;
const users: UserRow[] = [];
for (let from = 0; ; from += PAGE_SIZE) {
  const { data, error } = await sb
    .from("users")
    .select("id, stripe_customer_id, cancelled_at, topic_quota")
    .not("stripe_customer_id", "is", null)
    .order("id")
    .range(from, from + PAGE_SIZE - 1);
  if (error) {
    console.error("::error:: users query failed:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) break;
  users.push(...(data as UserRow[]));
  if (data.length < PAGE_SIZE) break;
}

// --- 3. Compare each user row against its Stripe subscription. ---
interface Finding {
  type: string;
  userId?: string;
  stripeCustomerId: string;
  detail: string;
}
const findings: Finding[] = [];

for (const user of users) {
  const sub = subsByCustomer.get(user.stripe_customer_id);
  if (!sub) {
    findings.push({
      type: "orphaned_customer_id",
      userId: user.id,
      stripeCustomerId: user.stripe_customer_id,
      detail: "public.users has this stripe_customer_id but Stripe has no subscription (of any status) for it at all",
    });
    continue;
  }
  const stripeIsLive = !isTerminalSubscriptionStatus(sub.status);
  const dbIsLive = hasActiveAccess(user.cancelled_at);
  if (stripeIsLive !== dbIsLive) {
    findings.push({
      type: "access_mismatch",
      userId: user.id,
      stripeCustomerId: user.stripe_customer_id,
      detail: `Stripe subscription ${sub.id} status=${sub.status} (live=${stripeIsLive}) but DB cancelled_at=${user.cancelled_at ?? "null"} (hasActiveAccess=${dbIsLive})`,
    });
  }
  if (stripeIsLive) {
    const expectedQuota = clampQuota(sub.quantity * TOPICS_PER_BUNDLE);
    if (user.topic_quota !== expectedQuota) {
      findings.push({
        type: "quota_mismatch",
        userId: user.id,
        stripeCustomerId: user.stripe_customer_id,
        detail: `Stripe subscription ${sub.id} quantity=${sub.quantity} implies topic_quota=${expectedQuota}, DB has topic_quota=${user.topic_quota ?? "null"}`,
      });
    }
  }
}

// --- 4. Reverse check: a LIVE Stripe subscription with no matching user row
// at all -- e.g. checkout.session.completed's user-linking handler failed
// permanently, so the charge went through but no public.users row exists. ---
const userCustomerIds = new Set(users.map((u) => u.stripe_customer_id));
for (const [customerId, sub] of subsByCustomer) {
  if (!isTerminalSubscriptionStatus(sub.status) && !userCustomerIds.has(customerId)) {
    findings.push({
      type: "orphaned_stripe_subscription",
      stripeCustomerId: customerId,
      detail: `Stripe subscription ${sub.id} is LIVE (status=${sub.status}) for this customer but no public.users row references it -- a paying customer may be getting billed with no account`,
    });
  }
}

// --- 5. Report + alert. ---
const summary = {
  checkedAt: new Date().toISOString(),
  usersWithStripeCustomerId: users.length,
  distinctStripeCustomers: subsByCustomer.size,
  findingsCount: findings.length,
  findings,
};
console.log(JSON.stringify(summary, null, 2));

if (findings.length > 0) {
  const body = findings.map((f) => `- [${f.type}] ${f.detail} (stripe customer ${f.stripeCustomerId}${f.userId ? `, user ${f.userId}` : ""})`).join("\n");
  // Best-effort: never blocks the workflow from reporting its own exit code
  // below, which is the durable signal the workflow step reads.
  await sendOpsAlert(
    "alpha. Stripe/Supabase drift found",
    `${findings.length} discrepanc${findings.length === 1 ? "y" : "ies"} found between Stripe's live subscription state and public.users:\n\n${body}`,
    `alpha-stripe-reconcile-${new Date().toISOString().slice(0, 10)}`
  ).catch((e) => console.warn("sendOpsAlert failed:", e instanceof Error ? e.message : e));
  process.exitCode = 1;
} else {
  console.log(`OK: ${users.length} user(s) with a Stripe customer id, ${subsByCustomer.size} distinct Stripe customer(s) checked, zero drift found.`);
}
