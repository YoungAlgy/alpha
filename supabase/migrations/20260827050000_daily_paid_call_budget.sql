-- A route-local counter resets on every scheduled retry. Reserve the paid-call
-- allowance durably by send date so all retries share one real daily ceiling.
create table public.alpha_paid_call_budgets (
  budget_date     date primary key,
  reserved_calls integer not null default 0 check (
    reserved_calls >= 0 and reserved_calls <= 400
  ),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.alpha_paid_call_budgets enable row level security;

create or replace function public.reserve_alpha_paid_calls(
  p_budget_date date,
  p_requested integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved integer;
  v_granted integer;
begin
  if p_budget_date is null
     or p_requested is null
     or p_requested < 1
     or p_requested > 400 then
    raise exception 'paid-call reservation is invalid';
  end if;

  insert into public.alpha_paid_call_budgets (budget_date)
  values (p_budget_date)
  on conflict (budget_date) do nothing;

  select b.reserved_calls
    into v_reserved
    from public.alpha_paid_call_budgets b
   where b.budget_date = p_budget_date
   for update;

  v_granted := least(p_requested, 400 - v_reserved);
  if v_granted > 0 then
    update public.alpha_paid_call_budgets
       set reserved_calls = reserved_calls + v_granted,
           updated_at = now()
     where budget_date = p_budget_date;
  end if;
  return v_granted;
end;
$$;

revoke all on table public.alpha_paid_call_budgets
  from public, anon, authenticated;
revoke all on function public.reserve_alpha_paid_calls(date, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_alpha_paid_calls(date, integer)
  to service_role;
