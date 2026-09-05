import { createHash } from 'node:crypto';

export const WATCHDOG_PREREQUISITE_VERSION = '20260819000000';
export const WATCHDOG_PREREQUISITE_SOURCE_SHA256 = 'e2df06248b904ad14fdd52737bb12eda6d17c0add8d758ab127bf269e3e75944';
export const WATCHDOG_OLD_SOURCE_SHA256 = '718778c55e4b88caaa31fd95e8e3b3c53431dd2e9f987e117a455e0f0d6f64c4';
export const WATCHDOG_OLD_BODY_NORMALIZED_SHA256 = '8d2b527cd3e3c66533de3a69f731751cc869dfcdaaab575151bb2105c5f24aa2';
export const WATCHDOG_OLD_BODY_NORMALIZED_MD5 = '327604b5dffc43409a2daaed5b50d18f';
export const WATCHDOG_FINAL_BODY_NORMALIZED_MD5 = '1106e316332eee62b7eafbf8fd528132';

const FUNCTION_SQL = `create or replace function public.watchdog_delivery_check(cutoff timestamptz)
returns table(uncovered_count bigint, active_subscriber_count bigint)
language sql
security definer
set search_path = public
as $$
  select
    (
      select count(*) from public.users u
      where u.subscribed_at is not null
        and (u.cancelled_at is null or u.cancelled_at > now())
        and u.unsubscribed_at is null
        and u.bounced_at is null
        and u.complained_at is null
        and not exists (
          select 1 from public.issues i
          where i.user_id = u.id
            and i.delivered_at >= date_trunc('hour', cutoff)
            and (
              i.resend_message_id is not null
              or i.delivered_at < '2026-08-05T19:10:00Z'::timestamptz
            )
        )
    ) as uncovered_count,
    (
      select count(*) from public.users
      where subscribed_at is not null
        and (cancelled_at is null or cancelled_at > now())
        and unsubscribed_at is null
        and bounced_at is null
        and complained_at is null
    ) as active_subscriber_count;
$$;

revoke all on function public.watchdog_delivery_check(timestamptz) from public;
revoke all on function public.watchdog_delivery_check(timestamptz) from authenticated;
grant execute on function public.watchdog_delivery_check(timestamptz) to anon;`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalizeBody = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const extractBody = (source) => source.match(/create\s+or\s+replace\s+function\s+public\.watchdog_delivery_check[\s\S]*?\bas\s*\$\$([\s\S]*?)\$\$/i)?.[1];
const fixedFunctionBody = extractBody(FUNCTION_SQL);
if (!fixedFunctionBody || createHash('md5').update(normalizeBody(fixedFunctionBody)).digest('hex') !== WATCHDOG_FINAL_BODY_NORMALIZED_MD5) {
  throw new Error('watchdog-prerequisite-fixed-function-hash-mismatch');
}

/**
 * Pure source pinning. The caller supplies source text that it has already
 * loaded locally. This helper performs no file, database, environment, or
 * network access.
 */
export function verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource } = {}) {
  if (typeof currentMigrationSource !== 'string' || sha256(currentMigrationSource) !== WATCHDOG_PREREQUISITE_SOURCE_SHA256) {
    throw new Error('watchdog-prerequisite-source-hash-mismatch');
  }
  if (typeof oldMigrationSource !== 'string' || sha256(oldMigrationSource) !== WATCHDOG_OLD_SOURCE_SHA256) {
    throw new Error('watchdog-prerequisite-old-source-hash-mismatch');
  }
  const oldBody = extractBody(oldMigrationSource);
  const currentBody = extractBody(currentMigrationSource);
  if (!oldBody || !currentBody || sha256(normalizeBody(oldBody)) !== WATCHDOG_OLD_BODY_NORMALIZED_SHA256 ||
      createHash('md5').update(normalizeBody(oldBody)).digest('hex') !== WATCHDOG_OLD_BODY_NORMALIZED_MD5 ||
      createHash('md5').update(normalizeBody(currentBody)).digest('hex') !== WATCHDOG_FINAL_BODY_NORMALIZED_MD5 ||
      normalizeBody(currentBody) !== normalizeBody(fixedFunctionBody)) {
    throw new Error('watchdog-prerequisite-body-hash-mismatch');
  }
  return Object.freeze({ sourceSha256: WATCHDOG_PREREQUISITE_SOURCE_SHA256,
    oldSourceSha256: WATCHDOG_OLD_SOURCE_SHA256, oldBodyNormalizedSha256: WATCHDOG_OLD_BODY_NORMALIZED_SHA256,
    oldBodyNormalizedMd5: WATCHDOG_OLD_BODY_NORMALIZED_MD5, finalBodyNormalizedMd5: WATCHDOG_FINAL_BODY_NORMALIZED_MD5 });
}

/**
 * Produces SQL for a caller-owned local rehearsal only. `ledgerPresent` means
 * the exact 20260819000000 version row was already observed locally.
 */
export function buildWatchdogPrerequisiteSql(ledgerPresent, expectedOldBodySha256 = WATCHDOG_OLD_BODY_NORMALIZED_SHA256) {
  if (typeof ledgerPresent !== 'boolean') throw new TypeError('ledgerPresent must be boolean');
  if (expectedOldBodySha256 !== WATCHDOG_OLD_BODY_NORMALIZED_SHA256) throw new Error('watchdog-prerequisite-old-body-pin-mismatch');
  const observedLedger = ledgerPresent ? 'true' : 'false';
  const applyWhenAbsent = ledgerPresent ? '' : `
${FUNCTION_SQL}

insert into supabase_migrations.schema_migrations(version)
select '${WATCHDOG_PREREQUISITE_VERSION}'
where not exists (
  select 1 from supabase_migrations.schema_migrations
  where version = '${WATCHDOG_PREREQUISITE_VERSION}'
);`;
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $watchdog_ledger_shape$
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'watchdog prerequisite ledger missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
      and column_name = 'version' and data_type in ('text', 'character varying') and is_nullable = 'NO'
  ) or exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
      and column_name <> 'version' and is_nullable = 'NO' and column_default is null
      and is_identity = 'NO' and is_generated = 'NEVER'
  ) then
    raise exception 'watchdog prerequisite ledger shape invalid';
  end if;
end;
$watchdog_ledger_shape$;

lock table supabase_migrations.schema_migrations in share row exclusive mode;

do $watchdog_preflight$
declare
  observed_ledger boolean;
  body_hash text;
begin
  select exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '${WATCHDOG_PREREQUISITE_VERSION}'
  ) into observed_ledger;
  if observed_ledger is distinct from ${observedLedger} then
    raise exception 'watchdog prerequisite ledger state changed';
  end if;
  select md5(lower(btrim(regexp_replace(prosrc, '\\s+', ' ', 'g'))))
    into body_hash
  from pg_proc where oid = to_regprocedure('public.watchdog_delivery_check(timestamptz)');
  if body_hash is null then
    raise exception 'watchdog prerequisite function missing';
  end if;
  if observed_ledger and body_hash is distinct from '${WATCHDOG_FINAL_BODY_NORMALIZED_MD5}' then
    raise exception 'watchdog prerequisite ledger-present body drift';
  end if;
  if not observed_ledger and body_hash is distinct from '${WATCHDOG_OLD_BODY_NORMALIZED_MD5}' and body_hash is distinct from '${WATCHDOG_FINAL_BODY_NORMALIZED_MD5}' then
    raise exception 'watchdog prerequisite unknown old body';
  end if;
end
$watchdog_preflight$;${applyWhenAbsent}

do $watchdog_postflight$
declare body_hash text; version_count bigint;
begin
  select count(*) into version_count from supabase_migrations.schema_migrations
    where version = '${WATCHDOG_PREREQUISITE_VERSION}';
  if version_count <> 1 then
    raise exception 'watchdog prerequisite ledger cardinality invalid';
  end if;
  if not exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '${WATCHDOG_PREREQUISITE_VERSION}'
  ) then
    raise exception 'watchdog prerequisite ledger insert missing';
  end if;
  select md5(lower(btrim(regexp_replace(prosrc, '\\s+', ' ', 'g'))))
    into body_hash
  from pg_proc where oid = to_regprocedure('public.watchdog_delivery_check(timestamptz)');
  if body_hash is distinct from '${WATCHDOG_FINAL_BODY_NORMALIZED_MD5}' or
     exists (
       select 1 from pg_proc p
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
       where p.oid = to_regprocedure('public.watchdog_delivery_check(timestamptz)')
         and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
     ) or
     has_function_privilege('authenticated', to_regprocedure('public.watchdog_delivery_check(timestamptz)'), 'EXECUTE') or
     not has_function_privilege('anon', to_regprocedure('public.watchdog_delivery_check(timestamptz)'), 'EXECUTE') then
    raise exception 'watchdog prerequisite final guard failed';
  end if;
end
$watchdog_postflight$;
commit;
`;
}
