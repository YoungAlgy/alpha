# Refund review runbook

Alpha records a pending refund review before it cancels a paid subscription it
cannot safely provision. The scheduled maintenance job stays red until a person
records a decision. The application never refunds a charge automatically.

## Review

Use service-role database access to read only pending rows:

```sql
select session_id,
       subscription_id,
       customer_id,
       winner_subscription_id,
       winner_customer_id,
       reason,
       created_at
from public.refund_reviews
where status = 'pending'
order by created_at;
```

Check the exact Checkout Session, Subscription, Customer, and charge in Stripe.
Record the result only after the Stripe action or decision is complete:

```sql
select public.resolve_refund_review(
  'EXACT_CHECKOUT_SESSION_ID',
  'EXACT_SUBSCRIPTION_ID',
  'refunded'
);
```

Allowed results are:

- `refunded`: the related captured charge was refunded in Stripe.
- `not_required`: Stripe proves no refundable charge exists or the charge is
  valid and should remain.
- `reviewed`: the case was inspected but a final decision or Stripe action is
  still outstanding. Scheduled maintenance stays red. A reviewed row must later
  be changed to `refunded` or `not_required`.

The function must return `true`. A `false` result means the identifiers or
transition did not match. Stop and re-read the exact pending row. Do not edit
the table directly and do not guess an identifier.

The refund decision and recurring-subscription cleanup are separate. Winner
fields mean this review also reserves the canonical subscription that must be
kept while Alpha cancels the exact duplicate loser. Do not mark the review
final as a substitute for proving that the loser is terminal.

## Checkout recovery escalation

Checkout recovery makes eight bounded automatic attempts. A permanent binding
conflict can escalate immediately. The exact billing pair and refund review
remain service-only, while the abandoned fulfillment row is identity-scrubbed.
List the manual queue with:

```sql
select id,
       stripe_session_id,
       stripe_customer_id,
       stripe_subscription_id,
       recovery_last_error_code,
       recovery_dead_lettered_at
from public.checkout_profiles
where recovery_dead_lettered_at is not null
order by recovery_dead_lettered_at;
```

Investigate the exact local winner and both Stripe subscriptions first. After
the conflict is corrected or the provider is healthy, requeue only that exact
profile through the service-role RPC:

```sql
select public.requeue_checkout_profile_recovery('EXACT_PROFILE_UUID');
```

The result must be `requeued`. This RPC makes no provider call and restores no
subscriber data to the fulfillment row. Scheduled maintenance performs the
next bounded provider check. `deletion_pending`, `state_changed`, or any other
result means stop and re-read current state.

## Legacy fulfillment escalation

Legacy fulfillment reconciliation also stops after eight failed automatic
attempts. Dead-lettered rows stay out of every automatic provider queue and
keep their exact local cleanup state for manual review. Count and inspect them
with service-role database access:

```sql
select public.count_dead_lettered_legacy_checkout_fulfillments();

select session_id,
       status,
       reconcile_attempt_count,
       reconcile_last_error_code,
       reconcile_dead_lettered_at
from public.legacy_checkout_fulfillments
where reconcile_dead_lettered_at is not null
order by reconcile_dead_lettered_at;
```

After checking the exact local billing state and Stripe subscription, requeue
only the intended Session:

```sql
select public.requeue_legacy_checkout_fulfillment(
  'EXACT_CHECKOUT_SESSION_ID'
);
```

The result must be `requeued`. This service-only RPC resets local retry
eligibility. It does not call Stripe, cancel a subscription, refund a charge,
or restore subscriber identity. Scheduled maintenance performs the next exact,
bounded provider check. Any other result means stop and re-read current state.

## Retention

Pending and `reviewed` rows remain until the refund decision is final. The
scheduled maintenance job deletes `refunded` and `not_required` rows 180 days
after `resolved_at`. This clears their exact Checkout Session, Subscription,
and Customer references after the dispute window. A review cannot be pruned
while its exact current checkout profile or legacy fulfillment still has a
nonterminal subscription-cleanup state. A purge error or any eligible rows
left after the bounded batch keeps maintenance red.
