create table if not exists public.weekly_send_delivery_cursors (
  week_of date primary key,
  cursor_user_id uuid,
  updated_at timestamptz not null default now()
);

alter table public.weekly_send_delivery_cursors enable row level security;

create or replace function public.advance_weekly_send_cursor(
  p_week_of date,
  p_expected_cursor_user_id uuid,
  p_cursor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed integer;
begin
  if p_week_of is null or p_cursor_user_id is null then
    raise exception 'weekly send cursor input is invalid';
  end if;

  if p_expected_cursor_user_id is null then
    insert into public.weekly_send_delivery_cursors (
      week_of,
      cursor_user_id,
      updated_at
    ) values (
      p_week_of,
      p_cursor_user_id,
      now()
    )
    on conflict (week_of) do nothing;
    get diagnostics v_changed = row_count;
    if v_changed = 1 then
      delete from public.weekly_send_delivery_cursors
       where week_of < p_week_of - 45;
      return true;
    end if;
  end if;

  update public.weekly_send_delivery_cursors
     set cursor_user_id = p_cursor_user_id,
         updated_at = now()
   where week_of = p_week_of
     and cursor_user_id is not distinct from p_expected_cursor_user_id;
  get diagnostics v_changed = row_count;

  if v_changed = 1 then
    delete from public.weekly_send_delivery_cursors
     where week_of < p_week_of - 45;
    return true;
  end if;
  return false;
end;
$$;

revoke all on table public.weekly_send_delivery_cursors
  from public, anon, authenticated;
revoke all on function public.advance_weekly_send_cursor(date, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.advance_weekly_send_cursor(date, uuid, uuid)
  to service_role;
