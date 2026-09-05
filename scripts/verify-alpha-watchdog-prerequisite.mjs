import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildWatchdogPrerequisiteSql,
  verifyWatchdogPrerequisiteSource,
  WATCHDOG_FINAL_BODY_NORMALIZED_MD5,
} from './alpha-watchdog-prerequisite.mjs';

const currentMigrationSource = readFileSync('./supabase/migrations/20260819000000_watchdog_delivery_check_bounced_complained.sql', 'utf8');
const oldMigrationSource = readFileSync('./supabase/migrations/20260805150000_watchdog_delivery_check_per_subscriber_coverage.sql', 'utf8');
const pins = verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource });

assert.equal(pins.finalBodyNormalizedMd5, WATCHDOG_FINAL_BODY_NORMALIZED_MD5);
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource: `${currentMigrationSource} `, oldMigrationSource }));
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource: `${oldMigrationSource} ` }));

const absent = buildWatchdogPrerequisiteSql(false);
assert.match(absent, /end;\s*\$watchdog_ledger_shape\$;/);
assert.match(absent, /lock table supabase_migrations\.schema_migrations in share row exclusive mode/i);
assert.ok(absent.includes("btrim(regexp_replace(prosrc, '\\s+', ' ', 'g'))"));
assert.match(absent, /body_hash is distinct from '1106e316332eee62b7eafbf8fd528132'/i);
assert.match(absent, /privilege\.grantee = 0 and privilege\.privilege_type = 'EXECUTE'/i);
assert.match(absent, /version_count <> 1/i);
assert.match(absent, /create or replace function public\.watchdog_delivery_check/i);
assert.match(absent, /insert into supabase_migrations\.schema_migrations/i);

const present = buildWatchdogPrerequisiteSql(true);
assert.doesNotMatch(present, /create or replace function public\.watchdog_delivery_check/i);
assert.doesNotMatch(present, /insert into supabase_migrations\.schema_migrations/i);
assert.match(present, /ledger-present body drift/i);
assert.throws(() => buildWatchdogPrerequisiteSql('false'));
assert.throws(() => buildWatchdogPrerequisiteSql(false, '0'.repeat(64)));
