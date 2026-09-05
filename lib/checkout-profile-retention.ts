import type { supabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof supabaseServiceClient>>;

export interface TerminalCheckoutScrubResult {
  profilesScrubbed: number;
  fulfillmentsScrubbed: number;
}

export interface StaleCheckoutFulfillmentFinalizerResult {
  completed: number;
  aborted: number;
}

/**
 * Finish stale replay rows only after the database proves the checkout profile
 * is already terminal or fully provisioned. This is a local database cleanup.
 * It never classifies or mutates a provider subscription.
 */
export async function finalizeStaleCheckoutFulfillments(
  sb: ServiceClient,
  nowIso: string = new Date().toISOString(),
  limit = 100
): Promise<StaleCheckoutFulfillmentFinalizerResult> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const { data, error } = await sb.rpc(
    "finalize_stale_checkout_fulfillments",
    { p_now: nowIso, p_limit: safeLimit }
  );
  const row = (Array.isArray(data) ? data[0] : data) as
    | { completed_count?: unknown; aborted_count?: unknown }
    | null;
  const completed = row?.completed_count;
  const aborted = row?.aborted_count;
  if (
    error ||
    !Number.isInteger(completed) ||
    !Number.isInteger(aborted) ||
    Number(completed) < 0 ||
    Number(aborted) < 0
  ) {
    throw new Error(
      `stale checkout fulfillment finalizer failed: ${
        error?.message ?? "invalid database result"
      }`
    );
  }
  return { completed: Number(completed), aborted: Number(aborted) };
}

export async function countDeadLetteredCheckoutProfiles(
  sb: ServiceClient
): Promise<number> {
  const { data, error } = await sb.rpc(
    "count_dead_lettered_checkout_profiles"
  );
  const count = typeof data === "number" ? data : Number.NaN;
  if (error || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      `dead-lettered checkout profile count failed: ${
        error?.message ?? String(data)
      }`
    );
  }
  return count;
}

/**
 * Remove stable subscriber and recurring-billing bindings from terminal
 * checkout tombstones after the fixed 180-day billing-review window. Session
 * ids remain as the durable replay guard. This is service-only and local to
 * the database. It never calls Stripe or another provider.
 */
export async function scrubTerminalCheckoutTombstones(
  sb: ServiceClient,
  nowIso: string = new Date().toISOString(),
  limit = 100
): Promise<TerminalCheckoutScrubResult> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const { data, error } = await sb.rpc(
    "scrub_terminal_checkout_tombstones",
    { p_now: nowIso, p_limit: safeLimit }
  );
  const row = (Array.isArray(data) ? data[0] : data) as
    | { profiles_scrubbed?: unknown; fulfillments_scrubbed?: unknown }
    | null;
  const profilesScrubbed = row?.profiles_scrubbed;
  const fulfillmentsScrubbed = row?.fulfillments_scrubbed;
  if (
    error ||
    !Number.isInteger(profilesScrubbed) ||
    !Number.isInteger(fulfillmentsScrubbed) ||
    Number(profilesScrubbed) < 0 ||
    Number(fulfillmentsScrubbed) < 0
  ) {
    throw new Error(
      `terminal checkout tombstone scrub failed: ${
        error?.message ?? "invalid database result"
      }`
    );
  }
  return {
    profilesScrubbed: Number(profilesScrubbed),
    fulfillmentsScrubbed: Number(fulfillmentsScrubbed),
  };
}

function scrubPatch(nowIso: string) {
  return {
    email: null,
    first_name: null,
    city: null,
    job_blurb: null,
    project_blurb: null,
    fun_blurb: null,
    birthday: null,
    gender: null,
    topics: null,
    theme: null,
    raw_profile_scrubbed_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Retire Sessionless checkout reservations after their five-day operational
 * deadline and report any provider-backed reservation still unresolved.
 *
 * Current Auth-first staging writes profile fields directly to the canonical
 * user, so checkout_profiles is pseudonymous from insertion. The keyed binding
 * and exact Stripe refs stay while billing is unresolved. Only a row that never
 * acquired a Session is retired by age alone.
 */
export async function scrubExpiredCheckoutProfiles(
  sb: ServiceClient,
  nowIso: string = new Date().toISOString(),
  reportUnresolved = true
): Promise<string[]> {
  const errors: string[] = [];

  // A timed-out create-and-bind lease is not terminal evidence. Stripe may
  // have completed the Session before the route lost its response, leaving a
  // live subscription whose Session id never reached this row. Keep that lock
  // for the provider-backed recovery path instead of expiring it locally.

  const { error: retireError } = await sb
    .from("checkout_profiles")
    .update({ billing_state: "expired", ...scrubPatch(nowIso) })
    .eq("billing_state", "open")
    .is("stripe_session_id", null)
    .lt("expires_at", nowIso);
  if (retireError) errors.push(`unbound checkout retirement failed: ${retireError.message}`);

  // Defensive privacy cleanup for a malformed or pre-pivot row. Current
  // staging is already scrubbed and will not match this query.
  const { error: provisionedScrubError } = await sb
    .from("checkout_profiles")
    .update(scrubPatch(nowIso))
    .is("raw_profile_scrubbed_at", null)
    .not("provisioned_user_id", "is", null)
    .lt("expires_at", nowIso);
  if (provisionedScrubError) {
    errors.push(
      `provisioned checkout profile scrub failed: ${provisionedScrubError.message}`
    );
  }

  // Terminal rows cannot bill and need no recovery payload.
  const { error: terminalScrubError } = await sb
    .from("checkout_profiles")
    .update(scrubPatch(nowIso))
    .is("raw_profile_scrubbed_at", null)
    .in("billing_state", ["ended", "expired"])
    .lt("expires_at", nowIso);
  if (terminalScrubError) {
    errors.push(`terminal checkout profile scrub failed: ${terminalScrubError.message}`);
  }

  // A bound reservation past its operational deadline needs fresh Stripe
  // classification. Keep its duplicate-charge lock and make it visible until
  // the recovery worker provisions or ends the exact pair.
  if (reportUnresolved) {
    const { count: overdueCount, error: overdueError } = await sb
      .from("checkout_profiles")
      .select("id", { count: "exact", head: true })
      .is("provisioned_user_id", null)
      .not("stripe_session_id", "is", null)
      .in("billing_state", ["open", "paid", "recovering"])
      .is("recovery_dead_lettered_at", null)
      .lt("expires_at", nowIso);
    if (overdueError) {
      errors.push(`overdue checkout recovery check failed: ${overdueError.message}`);
    } else if ((overdueCount ?? 0) > 0) {
      errors.push(
        `${overdueCount} paid or bound checkout reservation(s) exceeded the operational recovery deadline`
      );
    }
  }

  return errors;
}
