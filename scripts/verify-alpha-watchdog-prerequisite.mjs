import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildWatchdogPrerequisiteSql,
  verifyWatchdogPrerequisiteSource,
  WATCHDOG_FINAL_BODY_NORMALIZED_MD5,
} from './alpha-watchdog-prerequisite.mjs';

// Git's Windows checkout may use CRLF. The historical source pins use LF.
// Canonicalize only line endings at this offline fixture boundary. The helper
// still rejects every unreviewed byte change and keeps its exact SQL/body pins.
const canonicalSource = source => source.replace(/\r\n/g, '\n');
const currentMigrationSource = canonicalSource(readFileSync('./supabase/migrations/20260819000000_watchdog_delivery_check_bounced_complained.sql', 'utf8'));
const oldMigrationSource = canonicalSource(readFileSync('./supabase/migrations/20260805150000_watchdog_delivery_check_per_subscriber_coverage.sql', 'utf8'));
const pins = verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource });

assert.equal(pins.finalBodyNormalizedMd5, WATCHDOG_FINAL_BODY_NORMALIZED_MD5);
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource: `${currentMigrationSource} `, oldMigrationSource }));
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource: `${oldMigrationSource} ` }));

const crlfCurrent = currentMigrationSource.replace(/\n/g, '\r\n');
const crlfOld = oldMigrationSource.replace(/\n/g, '\r\n');
assert.deepEqual(verifyWatchdogPrerequisiteSource({
  currentMigrationSource: canonicalSource(crlfCurrent),
  oldMigrationSource: canonicalSource(crlfOld),
}), pins, 'LF and Windows CRLF fixtures keep the exact same reviewed pins');
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource: crlfCurrent, oldMigrationSource }),
  'the strict helper does not silently normalize source');
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource: canonicalSource(`${crlfCurrent} `), oldMigrationSource }));
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource: canonicalSource(`${crlfOld} `) }));
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource: canonicalSource(crlfCurrent.replace('bounced_at', 'unsubscribed_at')), oldMigrationSource }));
assert.throws(() => verifyWatchdogPrerequisiteSource({ currentMigrationSource, oldMigrationSource: canonicalSource(crlfOld.replace('resend_message_id', 'delivered_at')) }));

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

console.log('PASS watchdog prerequisite offline source pins (LF/CRLF fixtures, content drift rejection and guarded SQL strings)');
