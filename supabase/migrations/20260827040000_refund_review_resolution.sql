-- A captured charge can require a deliberate human refund decision after its
-- subscription has been cancelled. Keep resolution explicit and service-only.
-- This function records an operator's decision. It never calls Stripe.
create or replace function public.resolve_refund_review(
  p_session_id text,
  p_subscription_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_status text;
begin
  if coalesce(p_session_id, '') = ''
     or coalesce(p_subscription_id, '') = ''
     or p_status is null
     or p_status not in ('reviewed', 'refunded', 'not_required') then
    return false;
  end if;

  select r.status
    into v_current_status
    from public.refund_reviews r
   where r.session_id = p_session_id
     and r.subscription_id = p_subscription_id
   for update;

  if not found then
    return false;
  end if;
  if v_current_status = p_status then
    return true;
  end if;
  if v_current_status not in ('pending', 'reviewed') then
    return false;
  end if;

  update public.refund_reviews
     set status = p_status,
         updated_at = now(),
         resolved_at = now()
   where session_id = p_session_id
     and subscription_id = p_subscription_id
     and status = v_current_status;
  return found;
end;
$$;

create or replace function public.count_unresolved_refund_reviews()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
    from public.refund_reviews
   where status in ('pending', 'reviewed');
$$;

-- Exact billing references are useful for a finite dispute and charge-review
-- window after the operator reaches a final decision. They are not retained
-- indefinitely. Unresolved pending/reviewed obligations are never eligible.
create index if not exists refund_reviews_resolved_retention_idx
  on public.refund_reviews (resolved_at, session_id, subscription_id)
  where status in ('refunded', 'not_required');

create or replace function public.prune_resolved_refund_reviews(
  p_now timestamptz,
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  if p_now is null or p_limit is null or p_limit not between 1 and 100 then
    return 0;
  end if;

  with candidates as (
    select r.session_id, r.subscription_id
      from public.refund_reviews r
     where r.status in ('refunded', 'not_required')
       and r.resolved_at <= p_now - interval '180 days'
       and not exists (
         select 1
           from public.legacy_checkout_fulfillments l
          where l.session_id = r.session_id
            and l.stripe_subscription_id = r.subscription_id
            and l.stripe_customer_id = r.customer_id
             and l.status in ('pending', 'deleting')
        )
       -- Resolving the charge decision does not prove the exact subscription
       -- cleanup finished. A dead-lettered current checkout intentionally
       -- scrubs its fulfillment PII while retaining this exact pair in the
       -- profile for operator requeue, so guard the profile independently.
       and not exists (
         select 1
           from public.checkout_profiles p
          where p.stripe_session_id = r.session_id
            and p.stripe_customer_id = r.customer_id
            and p.stripe_subscription_id = r.subscription_id
            and p.billing_state in (
              'open', 'creating', 'paid', 'recovering', 'deleting'
            )
       )
       and not exists (
         select 1
           from public.checkout_fulfillments f
           join public.checkout_profiles p
             on p.id = f.profile_id
            and p.stripe_session_id = f.session_id
          where f.session_id = r.session_id
            and f.status = 'pending'
            and p.stripe_customer_id = r.customer_id
            and p.stripe_subscription_id = r.subscription_id
       )
     order by r.resolved_at, r.session_id, r.subscription_id
     limit p_limit
     for update skip locked
  ), deleted as (
    delete from public.refund_reviews r
     using candidates c
     where r.session_id = c.session_id
       and r.subscription_id = c.subscription_id
       and r.status in ('refunded', 'not_required')
       and r.resolved_at <= p_now - interval '180 days'
     returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

create or replace function public.count_prunable_resolved_refund_reviews(
  p_now timestamptz
)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p_now is null then 0
    else (
      select count(*)::integer
        from public.refund_reviews r
       where r.status in ('refunded', 'not_required')
         and r.resolved_at <= p_now - interval '180 days'
         and not exists (
           select 1
             from public.legacy_checkout_fulfillments l
            where l.session_id = r.session_id
              and l.stripe_subscription_id = r.subscription_id
              and l.stripe_customer_id = r.customer_id
               and l.status in ('pending', 'deleting')
          )
         and not exists (
           select 1
             from public.checkout_profiles p
            where p.stripe_session_id = r.session_id
              and p.stripe_customer_id = r.customer_id
              and p.stripe_subscription_id = r.subscription_id
              and p.billing_state in (
                'open', 'creating', 'paid', 'recovering', 'deleting'
              )
         )
         and not exists (
           select 1
             from public.checkout_fulfillments f
             join public.checkout_profiles p
               on p.id = f.profile_id
              and p.stripe_session_id = f.session_id
            where f.session_id = r.session_id
              and f.status = 'pending'
              and p.stripe_customer_id = r.customer_id
              and p.stripe_subscription_id = r.subscription_id
         )
    )
  end;
$$;

revoke all on function public.resolve_refund_review(text, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_refund_review(text, text, text)
  to service_role;
revoke all on function public.count_unresolved_refund_reviews()
  from public, anon, authenticated;
grant execute on function public.count_unresolved_refund_reviews()
  to service_role;
revoke all on function public.prune_resolved_refund_reviews(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.prune_resolved_refund_reviews(timestamptz, integer)
  to service_role;
revoke all on function public.count_prunable_resolved_refund_reviews(timestamptz)
  from public, anon, authenticated;
grant execute on function public.count_prunable_resolved_refund_reviews(timestamptz)
  to service_role;
