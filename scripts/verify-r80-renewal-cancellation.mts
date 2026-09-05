// Fully local Round 80 verification for the exact-subscription renewal
// cancellation fallback. Provider and database behavior are in-memory stubs.
// This script never loads env files and never contacts Stripe or Supabase.
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import { STRIPE_PRICE_ID } from "../lib/stripe.ts";
import {
  RenewalCancellationError,
  assertExactAlphaRenewalSubscription,
  isRenewalCancellationSchedulable,
  reconcilePendingAlphaRenewalCancellations,
  scheduleExactAlphaRenewalCancellation,
  verifiedFutureCancellationAt,
} from "../lib/renewal-cancellation.ts";
import { isCsrfGuarded } from "../lib/csrf-guard.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

const userId = "11111111-1111-4111-8111-111111111111";
const customerId = "cus_alpha_exact";
const subscriptionId = "sub_alpha_exact";
const now = new Date("2026-08-28T12:00:00.000Z");
const cancelAtSeconds = Math.floor(now.getTime() / 1000) + 14 * 24 * 60 * 60;

function subscription(
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [
        {
          id: "si_alpha_exact",
          price: { id: STRIPE_PRICE_ID },
          quantity: 1,
        },
      ],
      has_more: false,
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

interface MarkerState {
  pendingAt: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  cancelledAt: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  escalatedAt: string | null;
}

function database(
  options: {
    failSettleOnce?: boolean;
    concurrentCancelledAt?: string;
    canonicalCustomerId?: string;
    canonicalSubscriptionId?: string;
    failNoAccessSettleOnce?: boolean;
  } = {}
) {
  let failSettleOnce = options.failSettleOnce ?? false;
  let failNoAccessSettleOnce = options.failNoAccessSettleOnce ?? false;
  const canonical = {
    customerId: options.canonicalCustomerId ?? customerId,
    subscriptionId: options.canonicalSubscriptionId ?? subscriptionId,
  };
  const state: MarkerState = {
    pendingAt: null,
    customerId: null,
    subscriptionId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    cancelledAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    escalatedAt: null,
  };
  const calls: string[] = [];

  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "claim_alpha_renewal_cancellation") {
        if (
          canonical.customerId !== args.p_customer_id ||
          canonical.subscriptionId !== args.p_subscription_id
        ) {
          return {
            data: [
              {
                decision: "binding_changed",
                pending_at: state.pendingAt,
                cancelled_at: state.cancelledAt,
              },
            ],
            error: null,
          };
        }
        if (
          state.cancelledAt &&
          new Date(state.cancelledAt).getTime() <= now.getTime()
        ) {
          return {
            data: [
              {
                decision: "access_ended",
                pending_at: state.pendingAt,
                cancelled_at: state.cancelledAt,
              },
            ],
            error: null,
          };
        }
        if (
          state.leaseToken &&
          state.leaseExpiresAt &&
          new Date(state.leaseExpiresAt).getTime() > now.getTime()
        ) {
          return {
            data: [
              {
                decision: "in_progress",
                pending_at: state.pendingAt,
                cancelled_at: state.cancelledAt,
              },
            ],
            error: null,
          };
        }
        state.pendingAt ??= "2026-08-28T12:00:00.000Z";
        state.customerId = String(args.p_customer_id);
        state.subscriptionId = String(args.p_subscription_id);
        state.leaseToken = String(args.p_lease_token);
        state.leaseExpiresAt = "2026-08-28T12:05:00.000Z";
        state.nextAttemptAt = state.leaseExpiresAt;
        return {
          data: [
            {
              decision: "claimed",
              pending_at: state.pendingAt,
              cancelled_at: state.cancelledAt,
            },
          ],
          error: null,
        };
      }
      if (name === "settle_alpha_renewal_cancellation") {
        if (failSettleOnce) {
          failSettleOnce = false;
          return { data: null, error: { message: "simulated sync crash" } };
        }
        if (state.leaseToken !== args.p_lease_token) {
          return { data: "lease_lost", error: null };
        }
        state.cancelledAt = options.concurrentCancelledAt ?? state.cancelledAt;
        const providerEnd = String(args.p_cancel_at);
        state.cancelledAt =
          state.cancelledAt &&
          new Date(state.cancelledAt).getTime() <
            new Date(providerEnd).getTime()
            ? state.cancelledAt
            : providerEnd;
        state.pendingAt = null;
        state.customerId = null;
        state.subscriptionId = null;
        state.leaseToken = null;
        state.leaseExpiresAt = null;
        state.nextAttemptAt = null;
        state.attemptCount = 0;
        state.lastErrorCode = null;
        state.escalatedAt = null;
        return { data: "settled", error: null };
      }
      if (name === "settle_alpha_renewal_cancellation_no_access") {
        if (failNoAccessSettleOnce) {
          failNoAccessSettleOnce = false;
          return { data: null, error: { message: "simulated no-access sync crash" } };
        }
        if (
          canonical.customerId !== args.p_customer_id ||
          canonical.subscriptionId !== args.p_subscription_id ||
          state.customerId !== args.p_customer_id ||
          state.subscriptionId !== args.p_subscription_id ||
          state.leaseToken !== args.p_lease_token
        ) {
          return { data: "lease_lost", error: null };
        }
        const endedNow = now.toISOString();
        state.cancelledAt =
          state.cancelledAt &&
          new Date(state.cancelledAt).getTime() < now.getTime()
            ? state.cancelledAt
            : endedNow;
        state.pendingAt = null;
        state.customerId = null;
        state.subscriptionId = null;
        state.leaseToken = null;
        state.leaseExpiresAt = null;
        state.nextAttemptAt = null;
        state.attemptCount = 0;
        state.lastErrorCode = null;
        state.escalatedAt = null;
        return { data: "settled", error: null };
      }
      if (name === "claim_alpha_renewal_cancellation_retirement") {
        if (!state.pendingAt) return { data: "marker_missing", error: null };
        if (
          state.customerId !== args.p_customer_id ||
          state.subscriptionId !== args.p_subscription_id
        ) {
          return { data: "marker_changed", error: null };
        }
        if (
          state.leaseToken &&
          state.leaseExpiresAt &&
          new Date(state.leaseExpiresAt).getTime() > now.getTime()
        ) {
          return { data: "in_progress", error: null };
        }
        state.leaseToken = String(args.p_lease_token);
        state.leaseExpiresAt = "2026-08-28T12:05:00.000Z";
        state.nextAttemptAt = state.leaseExpiresAt;
        return { data: "claimed", error: null };
      }
      if (name === "retire_alpha_renewal_cancellation_marker") {
        if (!state.pendingAt) return { data: "marker_missing", error: null };
        if (
          state.customerId !== args.p_customer_id ||
          state.subscriptionId !== args.p_subscription_id ||
          state.leaseToken !== args.p_lease_token ||
          (canonical.customerId === args.p_customer_id &&
            canonical.subscriptionId === args.p_subscription_id)
        ) {
          return { data: "lease_lost", error: null };
        }
        state.pendingAt = null;
        state.customerId = null;
        state.subscriptionId = null;
        state.leaseToken = null;
        state.leaseExpiresAt = null;
        state.nextAttemptAt = null;
        state.attemptCount = 0;
        state.lastErrorCode = null;
        state.escalatedAt = null;
        return { data: "retired", error: null };
      }
      if (name === "release_alpha_renewal_cancellation_lease") {
        if (state.leaseToken !== args.p_lease_token) {
          return { data: "lease_lost", error: null };
        }
        state.leaseToken = null;
        state.leaseExpiresAt = null;
        const retryFloorSeconds = [60, 300, 900, 3600, 10800, 21600, 43200, 86400][
          Math.min(state.attemptCount, 7)
        ];
        state.nextAttemptAt = new Date(
          now.getTime() +
            Math.max(
              Number(args.p_retry_seconds ?? 0),
              retryFloorSeconds
            ) *
              1000
        ).toISOString();
        state.attemptCount = Math.min(state.attemptCount + 1, 8);
        state.lastErrorCode = String(args.p_error_code ?? "unexpected");
        if (state.attemptCount === 8) {
          state.escalatedAt ??= now.toISOString();
        }
        return { data: "released", error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      let nextAttemptCutoffMs = Number.POSITIVE_INFINITY;
      return {
        select() {
          return this;
        },
        not() {
          return this;
        },
        lte(column: string, value: string) {
          if (column !== "renewal_cancel_next_attempt_at") {
            throw new Error(`unexpected lte column ${column}`);
          }
          nextAttemptCutoffMs = Date.parse(value);
          return this;
        },
        order() {
          return this;
        },
        async limit() {
          if (!state.pendingAt) return { data: [], error: null };
          if (
            state.nextAttemptAt &&
            Date.parse(state.nextAttemptAt) > nextAttemptCutoffMs
          ) {
            return { data: [], error: null };
          }
          return {
            data: [
              {
                id: userId,
                stripe_customer_id: canonical.customerId,
                stripe_subscription_id: canonical.subscriptionId,
                renewal_cancel_pending_at: state.pendingAt,
                renewal_cancel_customer_id: state.customerId,
                renewal_cancel_subscription_id: state.subscriptionId,
                renewal_cancel_next_attempt_at: state.nextAttemptAt,
                renewal_cancel_lease_token: state.leaseToken,
                renewal_cancel_lease_expires_at: state.leaseExpiresAt,
              },
            ],
            error: null,
          };
        },
      };
    },
  };
  return { client, state, calls, canonical };
}

function stripeStub(
  initial: Stripe.Subscription,
  options: {
    cancelResult?: (current: Stripe.Subscription) => Stripe.Subscription;
    onRetrieve?: () => void;
  } = {}
) {
  let current = initial;
  const updates: Array<{
    id: string;
    params: Stripe.SubscriptionUpdateParams;
    key: string | undefined;
  }> = [];
  const cancellations: Array<{
    id: string;
    params: Stripe.SubscriptionCancelParams;
    key: string | undefined;
  }> = [];
  const client = {
    subscriptions: {
      async retrieve(id: string) {
        if (id !== current.id) throw new Error("wrong subscription read");
        options.onRetrieve?.();
        return current;
      },
      async update(
        id: string,
        params: Stripe.SubscriptionUpdateParams,
        requestOptions?: Stripe.RequestOptions
      ) {
        if (id !== current.id) throw new Error("wrong subscription update");
        updates.push({ id, params, key: requestOptions?.idempotencyKey });
        current = subscription({
          ...current,
          cancel_at_period_end: true,
          cancel_at: cancelAtSeconds,
        });
        return current;
      },
      async cancel(
        id: string,
        params: Stripe.SubscriptionCancelParams,
        requestOptions?: Stripe.RequestOptions
      ) {
        if (id !== current.id) throw new Error("wrong subscription cancel");
        cancellations.push({ id, params, key: requestOptions?.idempotencyKey });
        current = options.cancelResult
          ? options.cancelResult(current)
          : subscription({
              ...current,
              status: "canceled",
              cancel_at_period_end: false,
              cancel_at: null,
            });
        return current;
      },
    },
  } as unknown as Stripe;
  return {
    client,
    updates,
    cancellations,
    current: () => current,
    setCurrent(value: Stripe.Subscription) {
      current = value;
    },
  };
}

console.log("(1) exact shape and status guards");
{
  const exact = subscription();
  let exactPassed = true;
  try {
    assertExactAlphaRenewalSubscription(exact, customerId, subscriptionId);
  } catch {
    exactPassed = false;
  }
  check("(1a) exact Customer, Subscription, item, price, and quantity pass", exactPassed);
  check("(1b) active is schedulable", isRenewalCancellationSchedulable("active"));
  check("(1c) trialing is schedulable", isRenewalCancellationSchedulable("trialing"));
  check("(1d) past_due is schedulable", isRenewalCancellationSchedulable("past_due"));
  for (const status of [
    "incomplete",
    "incomplete_expired",
    "paused",
    "unpaid",
    "canceled",
  ] as Stripe.Subscription.Status[]) {
    check(
      `(1) ${status} fails closed`,
      !isRenewalCancellationSchedulable(status)
    );
  }
  let mixedRejected = false;
  try {
    assertExactAlphaRenewalSubscription(
      subscription({
        items: {
          data: [
            ...exact.items.data,
            {
              id: "si_other",
              price: { id: "price_other" },
              quantity: 1,
            } as Stripe.SubscriptionItem,
          ],
          has_more: false,
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      customerId,
      subscriptionId
    );
  } catch {
    mixedRejected = true;
  }
  check("(1e) mixed subscription items are rejected", mixedRejected);
  let incompleteItemsRejected = false;
  try {
    assertExactAlphaRenewalSubscription(
      subscription({
        items: {
          data: exact.items.data,
          has_more: true,
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
      customerId,
      subscriptionId
    );
  } catch {
    incompleteItemsRejected = true;
  }
  check("(1f) an incomplete item page is rejected", incompleteItemsRejected);
}

console.log("(2) a new cancellation claims first and sets period-end only");
{
  const db = database();
  const stripe = stripeStub(subscription());
  const result = await scheduleExactAlphaRenewalCancellation(
    db.client as never,
    {
      userId,
      customerId,
      subscriptionId,
      stripeClient: stripe.client,
      now,
    }
  );
  check("(2a) the durable claim precedes settlement", db.calls[0] === "claim_alpha_renewal_cancellation" && db.calls.includes("settle_alpha_renewal_cancellation"));
  check("(2b) exactly one Stripe update is made", stripe.updates.length === 1);
  check("(2c) the update sets only cancel_at_period_end true", JSON.stringify(stripe.updates[0]?.params) === JSON.stringify({ cancel_at_period_end: true }));
  check("(2d) a stable idempotency key is supplied", stripe.updates[0]?.key?.startsWith(`alpha-renewal-${subscriptionId}-`) === true);
  check("(2e) the future cancellation is mirrored locally", result.cancelAt === db.state.cancelledAt && db.state.pendingAt === null);
  check("(2f) a live exact subscription is never canceled immediately", stripe.cancellations.length === 0 && !result.ended);
}

console.log("(3) an already-scheduled exact subscription is idempotent");
{
  const db = database();
  const stripe = stripeStub(
    subscription({
      cancel_at_period_end: true,
      cancel_at: cancelAtSeconds,
    })
  );
  const result = await scheduleExactAlphaRenewalCancellation(
    db.client as never,
    { userId, customerId, subscriptionId, stripeClient: stripe.client, now }
  );
  check("(3a) already scheduled is reported", result.alreadyScheduled);
  check("(3b) no second Stripe update is sent", stripe.updates.length === 0);
  check("(3c) the exact future end date still settles", db.state.cancelledAt === result.cancelAt && !result.ended && stripe.cancellations.length === 0);
}

console.log("(4) a post-Stripe sync failure stays durable and recovers");
{
  const db = database({ failSettleOnce: true });
  const stripe = stripeStub(subscription());
  let firstFailed = false;
  try {
    await scheduleExactAlphaRenewalCancellation(db.client as never, {
      userId,
      customerId,
      subscriptionId,
      stripeClient: stripe.client,
      now,
    });
  } catch (error) {
    firstFailed =
      error instanceof RenewalCancellationError &&
      error.code === "settlement_failed";
  }
  check("(4a) the simulated sync crash surfaces", firstFailed);
  check("(4b) the exact pending marker survives with its lease released", !!db.state.pendingAt && db.state.customerId === customerId && db.state.subscriptionId === subscriptionId && db.state.leaseToken === null);
  const recovered = await reconcilePendingAlphaRenewalCancellations(
    db.client as never,
    {
      stripeClient: stripe.client,
      now: new Date("2026-08-28T12:02:00.000Z"),
      limit: 5,
    }
  );
  check("(4c) the bounded reconciler recognizes provider success", recovered.alreadyScheduled === 1 && recovered.unresolved === 0);
  check("(4d) recovery does not repeat the Stripe mutation", stripe.updates.length === 1);
  check("(4e) recovery clears only after the token/CAS settlement", db.state.pendingAt === null && !!db.state.cancelledAt);
}

console.log("(5) unsafe provider state remains pending and red");
{
  const db = database();
  const exact = subscription();
  const stripe = stripeStub(
    subscription({
      items: {
        data: [
          ...exact.items.data,
          {
            id: "si_unsafe_mixed",
            price: { id: "price_other" },
            quantity: 1,
          } as Stripe.SubscriptionItem,
        ],
        has_more: false,
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
  );
  let rejected = false;
  try {
    await scheduleExactAlphaRenewalCancellation(db.client as never, {
      userId,
      customerId,
      subscriptionId,
      stripeClient: stripe.client,
      now,
    });
  } catch (error) {
    rejected =
      error instanceof RenewalCancellationError &&
      error.code === "provider_state_unsafe";
  }
  check("(5a) a live mixed subscription is rejected", rejected);
  check("(5b) no Stripe mutation is sent", stripe.updates.length === 0 && stripe.cancellations.length === 0);
  check("(5c) the exact marker remains pending for review", !!db.state.pendingAt && db.state.leaseToken === null);
}

console.log("(6) returned provider proof must include a future cancel_at");
{
  let rejected = false;
  try {
    verifiedFutureCancellationAt(
      subscription({ cancel_at_period_end: true, cancel_at: null }),
      now
    );
  } catch {
    rejected = true;
  }
  check("(6a) scheduled-without-date is rejected", rejected);
  let pastRejected = false;
  try {
    verifiedFutureCancellationAt(
      subscription({
        cancel_at_period_end: true,
        cancel_at: Math.floor(now.getTime() / 1000) - 1,
      }),
      now
    );
  } catch {
    pastRejected = true;
  }
  check("(6b) a past cancel_at is rejected", pastRejected);
}

console.log("(7) settlement never regrants access over a concurrent revocation");
{
  const revokedAt = "2026-08-28T12:00:01.000Z";
  const db = database({ concurrentCancelledAt: revokedAt });
  const stripe = stripeStub(subscription());
  await scheduleExactAlphaRenewalCancellation(db.client as never, {
    userId,
    customerId,
    subscriptionId,
    stripeClient: stripe.client,
    now,
  });
  check(
    "(7a) the earlier webhook access end wins over future period end",
    db.state.cancelledAt === revokedAt
  );
}

console.log("(8) current provider no-access proof ends local access atomically");
{
  let terminalStatusesResolved = true;
  for (const status of [
    "incomplete_expired",
    "canceled",
  ] as Stripe.Subscription.Status[]) {
    const db = database();
    const stripe = stripeStub(subscription({ status }));
    const result = await scheduleExactAlphaRenewalCancellation(
      db.client as never,
      {
        userId,
        customerId,
        subscriptionId,
        stripeClient: stripe.client,
        now,
      }
    );
    terminalStatusesResolved &&=
      result.ended &&
      db.state.cancelledAt === now.toISOString() &&
      db.state.pendingAt === null &&
      stripe.updates.length === 0 &&
      stripe.cancellations.length === 0;
  }
  check(
    "(8a) terminal current statuses end local access without another provider mutation",
    terminalStatusesResolved
  );

  let unsafeStatusesCanceled = true;
  let unsafeStatusKeysStable = true;
  for (const status of [
    "incomplete",
    "paused",
    "unpaid",
  ] as Stripe.Subscription.Status[]) {
    const db = database();
    const stripe = stripeStub(subscription({ status }));
    const result = await scheduleExactAlphaRenewalCancellation(
      db.client as never,
      { userId, customerId, subscriptionId, stripeClient: stripe.client, now }
    );
    unsafeStatusesCanceled &&=
      result.ended &&
      stripe.cancellations.length === 1 &&
      JSON.stringify(stripe.cancellations[0]?.params) ===
        JSON.stringify({ invoice_now: false, prorate: false }) &&
      db.state.cancelledAt === now.toISOString() &&
      db.state.pendingAt === null;
    unsafeStatusKeysStable &&=
      stripe.cancellations[0]?.key?.startsWith(
        `alpha-renewal-end-${subscriptionId}-`
      ) === true;
  }
  check(
    "(8b) each nonterminal no-access exact Alpha state is canceled and verified terminal",
    unsafeStatusesCanceled
  );
  check(
    "(8c) unsafe-state immediate cancellation uses a stable exact-subscription retry key",
    unsafeStatusKeysStable
  );

  const db = database();
  const stripe = stripeStub(
    subscription({
      items: {
        data: [
          {
            id: "si_other_product",
            price: { id: "price_other_product" },
            quantity: 1,
          } as Stripe.SubscriptionItem,
        ],
        has_more: false,
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
  );
  const absentResult = await scheduleExactAlphaRenewalCancellation(
    db.client as never,
    {
      userId,
      customerId,
      subscriptionId,
      stripeClient: stripe.client,
      now,
    }
  );
  check(
    "(8d) a complete current subscription with no Alpha line ends local Alpha access",
    absentResult.ended &&
      db.state.cancelledAt === now.toISOString() &&
      db.state.pendingAt === null &&
      stripe.updates.length === 0 &&
      stripe.cancellations.length === 0
  );

  const unsafeDb = database();
  const unsafeStripe = stripeStub(subscription({ status: "unpaid" }), {
    cancelResult: (current) => subscription({ ...current, status: "unpaid" }),
  });
  let unsafeProofRejected = false;
  try {
    await scheduleExactAlphaRenewalCancellation(unsafeDb.client as never, {
      userId,
      customerId,
      subscriptionId,
      stripeClient: unsafeStripe.client,
      now,
    });
  } catch (error) {
    unsafeProofRejected =
      error instanceof RenewalCancellationError &&
      error.code === "provider_state_unsafe";
  }
  check(
    "(8e) a nonterminal cancel response stays pending and red",
    unsafeProofRejected &&
      unsafeStripe.cancellations.length === 1 &&
      !!unsafeDb.state.pendingAt &&
      unsafeDb.state.leaseToken === null &&
      unsafeDb.state.cancelledAt === null
  );

  const crashDb = database({ failNoAccessSettleOnce: true });
  const crashStripe = stripeStub(subscription({ status: "paused" }));
  let syncCrashSurfaced = false;
  try {
    await scheduleExactAlphaRenewalCancellation(crashDb.client as never, {
      userId,
      customerId,
      subscriptionId,
      stripeClient: crashStripe.client,
      now,
    });
  } catch (error) {
    syncCrashSurfaced =
      error instanceof RenewalCancellationError &&
      error.code === "settlement_failed";
  }
  const recovered = await reconcilePendingAlphaRenewalCancellations(
    crashDb.client as never,
    {
      stripeClient: crashStripe.client,
      now: new Date("2026-08-28T12:02:00.000Z"),
    }
  );
  check(
    "(8f) post-cancel local sync failure recovers without a second immediate cancellation",
    syncCrashSurfaced &&
      recovered.retired === 1 &&
      recovered.unresolved === 0 &&
      crashStripe.cancellations.length === 1 &&
      crashDb.state.pendingAt === null &&
      crashDb.state.cancelledAt === now.toISOString()
  );

  const endedDb = database();
  endedDb.state.pendingAt = "2026-08-27T12:00:00.000Z";
  endedDb.state.nextAttemptAt = now.toISOString();
  endedDb.state.customerId = customerId;
  endedDb.state.subscriptionId = subscriptionId;
  endedDb.state.cancelledAt = "2026-08-28T11:00:00.000Z";
  const endedStripe = stripeStub(subscription({ status: "canceled" }));
  const endedRecovery = await reconcilePendingAlphaRenewalCancellations(
    endedDb.client as never,
    { stripeClient: endedStripe.client, now }
  );
  check(
    "(8g) an already-ended current binding clears by current settlement and preserves the earlier access end",
    endedRecovery.retired === 1 &&
      endedRecovery.unresolved === 0 &&
      endedDb.state.pendingAt === null &&
      endedDb.state.cancelledAt === "2026-08-28T11:00:00.000Z"
  );
}

console.log("(9) stale replaced markers retire only after fresh exact proof");
{
  const oldCustomerId = "cus_alpha_old";
  const oldSubscriptionId = "sub_alpha_old";
  const newCustomerId = "cus_alpha_new";
  const newSubscriptionId = "sub_alpha_new";

  function staleDatabase() {
    const db = database({
      canonicalCustomerId: newCustomerId,
      canonicalSubscriptionId: newSubscriptionId,
    });
    db.state.pendingAt = "2026-08-27T12:00:00.000Z";
    db.state.nextAttemptAt = now.toISOString();
    db.state.customerId = oldCustomerId;
    db.state.subscriptionId = oldSubscriptionId;
    return db;
  }

  const terminalDb = staleDatabase();
  const terminalStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "canceled",
    })
  );
  const terminalResult = await reconcilePendingAlphaRenewalCancellations(
    terminalDb.client as never,
    { stripeClient: terminalStripe.client, now }
  );
  check(
    "(9a) fresh terminal proof retires the exact old-pair marker",
    terminalResult.retired === 1 &&
      terminalResult.unresolved === 0 &&
      terminalDb.state.pendingAt === null
  );
  check(
    "(9b) old-pair retirement cannot revoke access on the new binding",
    terminalDb.state.cancelledAt === null
  );

  const liveDb = staleDatabase();
  const liveStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "active",
    })
  );
  const liveResult = await reconcilePendingAlphaRenewalCancellations(
    liveDb.client as never,
    { stripeClient: liveStripe.client, now }
  );
  check(
    "(9c) an old exact Alpha subscription that may still renew stays pending and red",
    liveResult.retired === 0 &&
      liveResult.unresolved === 1 &&
      !!liveDb.state.pendingAt &&
      liveDb.state.leaseToken === null
  );
  const liveDeferred = await reconcilePendingAlphaRenewalCancellations(
    liveDb.client as never,
    { stripeClient: liveStripe.client, now, limit: 3 }
  );
  check(
    "(9c1) a failed marker backs off while later due cancellations remain selectable",
    liveDb.state.nextAttemptAt === "2026-08-28T12:15:00.000Z" &&
      liveDeferred.inspected === 0 &&
      liveDeferred.unresolved === 0
  );

  const scheduledOldDb = staleDatabase();
  const scheduledOldStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "active",
      cancel_at_period_end: true,
      cancel_at: cancelAtSeconds,
    })
  );
  const scheduledOldResult =
    await reconcilePendingAlphaRenewalCancellations(
      scheduledOldDb.client as never,
      { stripeClient: scheduledOldStripe.client, now }
    );
  check(
    "(9c2) a replaced exact pair with verified future period-end cancellation retires marker-only",
    scheduledOldResult.retired === 1 &&
      scheduledOldResult.unresolved === 0 &&
      scheduledOldStripe.updates.length === 0 &&
      scheduledOldStripe.cancellations.length === 0 &&
      scheduledOldDb.state.pendingAt === null &&
      scheduledOldDb.state.cancelledAt === null
  );

  const absentDb = staleDatabase();
  const absentStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "active",
      items: {
        data: [
          {
            id: "si_replacement_product",
            price: { id: "price_replacement_product" },
            quantity: 1,
          } as Stripe.SubscriptionItem,
        ],
        has_more: false,
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
  );
  const absentResult = await reconcilePendingAlphaRenewalCancellations(
    absentDb.client as never,
    { stripeClient: absentStripe.client, now }
  );
  check(
    "(9d) complete proof that an old replaced pair has no Alpha line retires only its marker",
    absentResult.retired === 1 &&
      absentResult.unresolved === 0 &&
      absentDb.state.pendingAt === null &&
      absentDb.state.cancelledAt === null
  );

  const partialDb = staleDatabase();
  const partialStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "canceled",
      items: {
        data: [],
        has_more: true,
      } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
    })
  );
  const partialResult = await reconcilePendingAlphaRenewalCancellations(
    partialDb.client as never,
    { stripeClient: partialStripe.client, now }
  );
  check(
    "(9e) incomplete provider shape never clears an old marker",
    partialResult.retired === 0 &&
      partialResult.unresolved === 1 &&
      !!partialDb.state.pendingAt
  );

  const unsafeOldDb = staleDatabase();
  const unsafeOldStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "paused",
    })
  );
  const unsafeOldResult = await reconcilePendingAlphaRenewalCancellations(
    unsafeOldDb.client as never,
    { stripeClient: unsafeOldStripe.client, now }
  );
  check(
    "(9f) an old nonterminal no-access exact Alpha pair is canceled before marker retirement",
    unsafeOldResult.retired === 1 &&
      unsafeOldResult.unresolved === 0 &&
      unsafeOldStripe.cancellations.length === 1 &&
      unsafeOldStripe.cancellations[0]?.key?.startsWith(
        `alpha-renewal-end-${oldSubscriptionId}-`
      ) === true &&
      unsafeOldDb.state.pendingAt === null &&
      unsafeOldDb.state.cancelledAt === null
  );

  const unsafeOldProofDb = staleDatabase();
  const unsafeOldProofStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "unpaid",
    }),
    {
      cancelResult: (current) =>
        subscription({ ...current, status: "unpaid" }),
    }
  );
  const unsafeOldProofResult =
    await reconcilePendingAlphaRenewalCancellations(
      unsafeOldProofDb.client as never,
      { stripeClient: unsafeOldProofStripe.client, now }
    );
  check(
    "(9g) an unverifiable old immediate cancellation remains pending and red",
    unsafeOldProofResult.retired === 0 &&
      unsafeOldProofResult.unresolved === 1 &&
      unsafeOldProofStripe.cancellations.length === 1 &&
      !!unsafeOldProofDb.state.pendingAt &&
      unsafeOldProofDb.state.leaseToken === null
  );

  const reboundDb = staleDatabase();
  const reboundStripe = stripeStub(
    subscription({
      id: oldSubscriptionId,
      customer: oldCustomerId,
      status: "canceled",
    }),
    {
      onRetrieve: () => {
        reboundDb.canonical.customerId = oldCustomerId;
        reboundDb.canonical.subscriptionId = oldSubscriptionId;
      },
    }
  );
  const reboundFirst = await reconcilePendingAlphaRenewalCancellations(
    reboundDb.client as never,
    { stripeClient: reboundStripe.client, now }
  );
  const reboundSecond = await reconcilePendingAlphaRenewalCancellations(
    reboundDb.client as never,
    {
      stripeClient: reboundStripe.client,
      now: new Date("2026-08-28T12:16:00.000Z"),
    }
  );
  check(
    "(9h) marker-only retirement loses CAS if the old pair becomes current during provider review",
    reboundFirst.retired === 0 &&
      reboundFirst.unresolved === 1 &&
      reboundSecond.retired === 1 &&
      reboundSecond.unresolved === 0 &&
      reboundDb.state.pendingAt === null &&
      reboundDb.state.cancelledAt === now.toISOString()
  );

  const unavailableDb = database();
  unavailableDb.state.pendingAt = "2026-08-27T12:00:00.000Z";
  unavailableDb.state.nextAttemptAt = now.toISOString();
  unavailableDb.state.customerId = customerId;
  unavailableDb.state.subscriptionId = subscriptionId;
  let unavailableFactoryCalls = 0;
  const unavailableFactory = () => {
    unavailableFactoryCalls += 1;
    throw new Error("simulated local provider initialization failure");
  };
  const unavailableFirst =
    await reconcilePendingAlphaRenewalCancellations(
      unavailableDb.client as never,
      { stripeClientFactory: unavailableFactory, now }
    );
  check(
    "(9i) provider initialization failure defers the exact marker by CAS instead of starving the queue",
    unavailableFirst.inspected === 1 &&
      unavailableFirst.unresolved === 1 &&
      unavailableFactoryCalls === 1 &&
      unavailableDb.calls.slice(-2).join(",") ===
        "claim_alpha_renewal_cancellation_retirement,release_alpha_renewal_cancellation_lease" &&
      unavailableDb.state.pendingAt === "2026-08-27T12:00:00.000Z" &&
      unavailableDb.state.customerId === customerId &&
      unavailableDb.state.subscriptionId === subscriptionId &&
      unavailableDb.state.leaseToken === null &&
      unavailableDb.state.nextAttemptAt === "2026-08-28T12:15:00.000Z" &&
      unavailableDb.state.attemptCount === 1 &&
      unavailableDb.state.lastErrorCode === "provider_unavailable"
  );

  for (let retry = 1; retry < 8; retry += 1) {
    await reconcilePendingAlphaRenewalCancellations(
      unavailableDb.client as never,
      {
        stripeClientFactory: unavailableFactory,
        now: new Date("2026-09-01T12:00:00.000Z"),
      }
    );
  }
  check(
    "(9j) eight failed fast attempts escalate durably without losing exact billing identity",
    unavailableDb.state.attemptCount === 8 &&
      unavailableDb.state.lastErrorCode === "provider_unavailable" &&
      unavailableDb.state.escalatedAt === now.toISOString() &&
      unavailableDb.state.nextAttemptAt === "2026-08-29T12:00:00.000Z" &&
      unavailableDb.state.pendingAt !== null &&
      unavailableDb.state.customerId === customerId &&
      unavailableDb.state.subscriptionId === subscriptionId
  );
  const firstEscalation = unavailableDb.state.escalatedAt;
  await reconcilePendingAlphaRenewalCancellations(
    unavailableDb.client as never,
    {
      stripeClientFactory: unavailableFactory,
      now: new Date("2026-09-01T12:00:00.000Z"),
    }
  );
  check(
    "(9k) escalated work remains operable on a slow retry without resetting its manual-review clock",
    unavailableDb.state.attemptCount === 8 &&
      unavailableDb.state.escalatedAt === firstEscalation &&
      unavailableDb.state.nextAttemptAt === "2026-08-29T12:00:00.000Z" &&
      unavailableDb.state.pendingAt !== null
  );
}

console.log("(10) route, database, CSRF, and UI wiring");
{
  const route = readFileSync(
    new URL("../app/api/stripe/cancel-renewal/route.ts", import.meta.url),
    "utf8"
  );
  const helper = readFileSync(
    new URL("../lib/renewal-cancellation.ts", import.meta.url),
    "utf8"
  );
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
      import.meta.url
    ),
    "utf8"
  );
  const settings = readFileSync(
    new URL("../app/settings/page.tsx", import.meta.url),
    "utf8"
  );
  const markerRetirementSql = migration.match(
    /create or replace function public\.retire_alpha_renewal_cancellation_marker[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  const periodEndSettlementSql = migration.match(
    /create or replace function public\.settle_alpha_renewal_cancellation\([\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  const currentNoAccessSql = migration.match(
    /create or replace function public\.settle_alpha_renewal_cancellation_no_access[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  const claimSql = migration.match(
    /create or replace function public\.claim_alpha_renewal_cancellation[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  const retirementClaimSql = migration.match(
    /create or replace function public\.claim_alpha_renewal_cancellation_retirement[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  const releaseSql = migration.match(
    /create or replace function public\.release_alpha_renewal_cancellation_lease[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  check("(10a) the route requires a confirmed signed-in Auth user", route.includes("sessionClient.auth.getUser()") && route.includes("user.email_confirmed_at"));
  check("(10b) the route is limited per stable user id", route.includes("cancel-renewal:${user.id}") && route.includes("limit: 5"));
  check("(10c) only exact stored Customer and Subscription ids are selected", route.includes("stripe_customer_id, stripe_subscription_id") && !route.includes(".ilike(") && !route.includes("subscriptions.list"));
  check("(10c2) a locally ended exact binding can still stop a nonterminal Stripe renewal", !route.includes("!row?.subscribed_at") && !claimSql.includes("'access_missing'::text") && !claimSql.includes("'access_ended'::text"));
  check("(10d) the helper retrieves one exact subscription and never scans", helper.includes("subscriptions.retrieve(") && !helper.includes("subscriptions.list("));
  check("(10e) live renewal scheduling mutates only cancel_at_period_end true", helper.includes("{ cancel_at_period_end: true }") && !helper.includes("subscriptions.update(\n          input.subscriptionId,\n          { cancel_at_period_end: false }"));
  check("(10e2) unsafe nonterminal cancellation is exact, no-invoice, idempotent, and terminal-verified", helper.includes("subscriptions.cancel(") && helper.includes("{ invoice_now: false, prorate: false }") && helper.includes("immediateCancellationIdempotencyKey(") && helper.includes("assertExactAlphaRenewalSubscription(\n    terminated") && helper.includes("!isTerminalRenewalStatus(terminated.status)"));
  check("(10f) the migration checks the account-deletion saga before claim", migration.includes("from public.account_deletion_sagas") && migration.includes("'deletion_pending'::text"));
  check("(10f2) the replacement user-column guard preserves every pre-existing Stripe email lease field", migration.includes("new.stripe_email_sync_lease_token := old.stripe_email_sync_lease_token") && migration.includes("new.stripe_email_sync_lease_expires_at := old.stripe_email_sync_lease_expires_at"));
  check("(10g) period-end settle requires the same owner, pair, token, and unexpired lease", periodEndSettlementSql.includes("u.id = p_user_id") && periodEndSettlementSql.includes("u.stripe_customer_id = p_customer_id") && periodEndSettlementSql.includes("u.stripe_subscription_id = p_subscription_id") && periodEndSettlementSql.includes("u.renewal_cancel_lease_token = p_lease_token") && periodEndSettlementSql.includes("u.renewal_cancel_lease_expires_at > now()"));
  check("(10h) period-end settlement preserves an earlier webhook access end", migration.includes("least(") && migration.includes("coalesce(u.cancelled_at, p_cancel_at)") && migration.includes("p_cancel_at"));
  check("(10i) current-pair no-access settlement ends access and clears only by an exact unexpired token/CAS", currentNoAccessSql.includes("cancelled_at = least(coalesce(u.cancelled_at, v_now), v_now)") && currentNoAccessSql.includes("u.stripe_customer_id = p_customer_id") && currentNoAccessSql.includes("u.stripe_subscription_id = p_subscription_id") && currentNoAccessSql.includes("u.renewal_cancel_lease_token = p_lease_token") && currentNoAccessSql.includes("u.renewal_cancel_lease_expires_at > now()") && currentNoAccessSql.includes("renewal_cancel_pending_at = null"));
  check("(10j) old-pair retirement is marker-only, unexpired-lease gated, and cannot clear after becoming current", markerRetirementSql.includes("renewal_cancel_pending_at = null") && !markerRetirementSql.includes("cancelled_at =") && markerRetirementSql.includes("u.renewal_cancel_lease_token = p_lease_token") && markerRetirementSql.includes("u.renewal_cancel_lease_expires_at > now()") && markerRetirementSql.includes("u.stripe_customer_id is distinct from p_customer_id") && markerRetirementSql.includes("u.stripe_subscription_id is distinct from p_subscription_id"));
  check("(10k) failure releases only the exact token lease and never drops its exact marker", releaseSql.includes("u.id = p_user_id") && releaseSql.includes("u.renewal_cancel_customer_id = p_customer_id") && releaseSql.includes("u.renewal_cancel_subscription_id = p_subscription_id") && releaseSql.includes("u.renewal_cancel_lease_token = p_lease_token") && releaseSql.includes("renewal_cancel_lease_token = null") && releaseSql.includes("renewal_cancel_lease_expires_at = null") && !releaseSql.includes("renewal_cancel_pending_at = null") && !releaseSql.includes("renewal_cancel_customer_id = null") && !releaseSql.includes("renewal_cancel_subscription_id = null"));
  check("(10k2) retry metadata is protected from client writes", ["renewal_cancel_next_attempt_at", "renewal_cancel_attempt_count", "renewal_cancel_last_error_code", "renewal_cancel_escalated_at"].every((column) => migration.includes(`new.${column} := old.${column}`)));
  check("(10k3) the database caps the fast failure phase at eight attempts", releaseSql.includes("least(u.renewal_cancel_attempt_count + 1, 8)") && ["when 0 then 60", "when 1 then 300", "when 2 then 900", "when 3 then 3600", "when 4 then 10800", "when 5 then 21600", "when 6 then 43200", "else 86400"].every((step) => releaseSql.includes(step)));
  check("(10k4) escalation is durable, keeps the last stable error, and slows retries to a day", releaseSql.includes("renewal_cancel_last_error_code = p_error_code") && releaseSql.includes("case when u.renewal_cancel_attempt_count >= 7") && releaseSql.includes("coalesce(u.renewal_cancel_escalated_at, now())") && releaseSql.includes("else 86400"));
  check("(10k5) raw errors cannot be stored in the renewal marker", releaseSql.includes("p_error_code not in (") && ["'provider_unavailable'", "'provider_rate_limited'", "'provider_state_unsafe'", "'settlement_failed'", "'binding_changed'", "'unexpected'"].every((code) => releaseSql.includes(code)) && migration.includes("users_renewal_cancel_last_error_code_check"));
  check("(10k6) retry metadata has a strict marker shape", migration.includes("renewal_cancel_attempt_count between 0 and 8") && migration.includes("renewal_cancel_attempt_count = 8") && migration.includes("renewal_cancel_last_error_code is not null") && migration.includes("renewal_cancel_escalated_at is not null"));
  check("(10k7) both claim modes enforce the durable retry deadline", claimSql.includes("v_user.renewal_cancel_next_attempt_at > v_now") && claimSql.includes("'not_due'::text") && retirementClaimSql.includes("v_user.renewal_cancel_next_attempt_at > v_now") && retirementClaimSql.includes("return 'not_due'"));
  check("(10k8) every successful settlement clears retry and escalation state", [periodEndSettlementSql, currentNoAccessSql, markerRetirementSql].every((body) => body.includes("renewal_cancel_attempt_count = 0") && body.includes("renewal_cancel_last_error_code = null") && body.includes("renewal_cancel_escalated_at = null")));
  check("(10l) every cancellation RPC is service-role only with the exact release signature", migration.includes("revoke all on function public.claim_alpha_renewal_cancellation") && migration.includes("revoke all on function public.settle_alpha_renewal_cancellation_no_access") && migration.includes("revoke all on function public.retire_alpha_renewal_cancellation_marker") && migration.includes("revoke all on function public.release_alpha_renewal_cancellation_lease(uuid, text, text, uuid, integer, text)") && migration.includes("grant execute on function public.release_alpha_renewal_cancellation_lease(uuid, text, text, uuid, integer, text)") && migration.includes("grant execute on function public.settle_alpha_renewal_cancellation") && migration.includes("to service_role"));
  check("(10m) the new POST suffix is CSRF guarded", isCsrfGuarded("/api/stripe/cancel-renewal"));
  check("(10n) settings has a separate in-app confirmation", settings.includes("Cancel renewal?") && settings.includes("Turn off renewal") && settings.includes("Keep renewal on"));
  check("(10o) settings retains the portal for cards and invoices", settings.includes("/api/stripe/portal") && settings.includes("Update your card and see invoices in Stripe"));
  check("(10p) settings shows an honest exact returned end date for scheduled and immediate outcomes", settings.includes("data.cancelAt") && settings.includes("data.ended === true") && settings.includes("You keep Alpha through") && settings.includes("Alpha access ended on") && route.includes("const ended = scheduled.ended || !localAccess") && route.includes("ended,") && !route.includes("No immediate cancellation was made"));
}

console.log("(11) scheduled maintenance cannot starve or hide cancellation recovery");
{
  const maintenance = readFileSync(
    new URL("../app/api/cron/maintenance/route.ts", import.meta.url),
    "utf8"
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/daily-send.yml", import.meta.url),
    "utf8"
  );
  const maintenanceMigration = readFileSync(
    new URL(
      "../supabase/migrations/20260828000000_alpha_renewal_cancellation.sql",
      import.meta.url
    ),
    "utf8"
  );
  const maintenanceDueSql = maintenanceMigration.match(
    /create or replace function public\.alpha_scheduled_maintenance_due[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  const renewalSummary = maintenance.match(
    /renewalCancellation:\s*\{[\s\S]*?\n\s*\},/
  )?.[0] ?? "";
  const attentionExpression = maintenance.match(
    /const needsAttention\s*=[\s\S]*?;\n\s*if \(needsAttention\)/
  )?.[0] ?? "";
  const workflowRenewalParser = workflow.match(
    /const n = s\.renewalCancellation;[\s\S]*?process\.stdout\.write\(String\(failed\)\)/
  )?.[0] ?? "";
  const workflowFailureMath = workflowRenewalParser;

  check(
    "(11a) maintenance imports and calls the bounded renewal reconciler",
    maintenance.includes("reconcilePendingAlphaRenewalCancellations,") &&
      maintenance.includes('from "@/lib/renewal-cancellation"') &&
      maintenance.includes("reconcilePendingAlphaRenewalCancellations(sb") &&
      maintenance.includes("limit: 3")
  );
  check(
    "(11b) maintenance exposes every renewal recovery outcome in its summary",
    [
      "inspected",
      "scheduled",
      "alreadyScheduled",
      "retired",
      "inProgress",
      "unresolved",
      "errors",
    ].every((field) => renewalSummary.includes(`${field}:`))
  );
  check(
    "(11c) maintenance counts all markers after the bounded pass",
    maintenance.includes(
      'sb.rpc("count_pending_alpha_renewal_cancellations")'
    ) &&
      maintenance.includes("pendingRenewalCancellations") &&
      maintenance.includes("renewalCancellationCountErrors")
  );
  check(
    "(11d) unresolved, in-progress, error, and remaining-marker states need attention",
    attentionExpression.includes("summary.renewalCancellation.inProgress > 0") &&
      attentionExpression.includes("summary.renewalCancellation.unresolved > 0") &&
      attentionExpression.includes("summary.renewalCancellation.errors > 0") &&
      attentionExpression.includes("renewalCancellationCountErrors > 0") &&
      attentionExpression.includes("pendingRenewalCancellations > 0")
  );
  check(
    "(11e) the workflow parser requires every renewal summary counter",
    [
      "n?.inspected",
      "n?.scheduled",
      "n?.alreadyScheduled",
      "n?.retired",
      "n?.inProgress",
      "n?.unresolved",
      "n?.errors",
      "s.pendingRenewalCancellations",
      "s.renewalCancellationCountErrors",
    ].every((field) => workflowRenewalParser.includes(field))
  );
  check(
    "(11f) the workflow fails for unresolved renewal work and count failures",
    workflowFailureMath.includes(
      "n.inProgress + n.unresolved + n.errors"
    ) &&
      workflowFailureMath.includes("s.pendingRenewalCancellations") &&
      workflowFailureMath.includes("s.renewalCancellationCountErrors")
  );
  check(
    "(11g) the cheap due precheck includes every due renewal retry",
    maintenanceDueSql.includes("u.renewal_cancel_pending_at is not null") &&
      maintenanceDueSql.includes(
        "u.renewal_cancel_next_attempt_at <= p_now"
      )
  );
  check(
    "(11h) escalated renewal obligations stay visible between slow retries",
    /u\.renewal_cancel_pending_at is not null[\s\S]*?u\.renewal_cancel_escalated_at is not null[\s\S]*?or u\.renewal_cancel_next_attempt_at <= p_now/.test(
      maintenanceDueSql
    )
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("RENEWAL-CANCELLATION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RENEWAL-CANCELLATION ASSERTIONS PASS");
