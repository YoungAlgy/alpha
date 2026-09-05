// Offline only. Pure injected RPC results and source checks. No env/provider IO.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pruneUnownedResendEvents } from "../lib/resend-event-retention";
import { parseResendEventCreatedAt } from "../lib/resend-suppression-causality";

let checks = 0;
function check(value: unknown, label: string) {
  assert.ok(value, label);
  checks += 1;
}

for (const count of [0, 1, 1000]) {
  const result = await pruneUnownedResendEvents({
    async rpc(name, args) {
      assert.equal(name, "prune_unowned_resend_webhook_events");
      assert.deepEqual(args, { p_limit: 1000 });
      checks += 2;
      return { data: [{ pruned_count: count, remaining: count === 1000 }], error: null };
    },
  });
  assert.deepEqual(result, { pruned: count, remaining: count === 1000, errors: 0 });
  checks += 1;
}

for (const data of [
  null, [], [{}], [{ pruned_count: -1, remaining: false }],
  [{ pruned_count: 1001, remaining: false }],
  [{ pruned_count: 1.5, remaining: false }],
  [{ pruned_count: "1", remaining: false }],
  [{ pruned_count: 1, remaining: "false" }],
  [{ pruned_count: 1, remaining: false }, { pruned_count: 2, remaining: false }],
]) {
  const result = await pruneUnownedResendEvents({
    async rpc() { return { data, error: null }; },
  });
  assert.deepEqual(result, { pruned: 0, remaining: true, errors: 1 });
  checks += 1;
}
for (const thrown of [false, true]) {
  const result = await pruneUnownedResendEvents({
    async rpc() {
      if (thrown) throw new Error("sensitive transport detail must not escape");
      return { data: [{ pruned_count: 1, remaining: false }], error: { message: "private detail" } };
    },
  });
  assert.deepEqual(result, { pruned: 0, remaining: true, errors: 1 });
  checks += 1;
}

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = source("../supabase/migrations/20260830050000_resend_suppression_causality.sql");
const ingress = sql.slice(sql.indexOf("create or replace function public.record_resend_suppression_event("));
const finalize = sql.slice(sql.indexOf("create or replace function public.finalize_resend_delivery_attempt("), sql.indexOf("create or replace function public.block_account_deletion_with_active_delivery("));
const expiry = ingress.indexOf("return query select 'expired_unowned'");
check(expiry > ingress.indexOf("where resend_message_id = p_email_id"), "resolve exact message ownership before expiry");
check(expiry < ingress.indexOf("insert into public.resend_webhook_events"), "reject expired unowned replay before insert");
check(ingress.includes("least(p_event_at, coalesce(v_existing_received_at, v_now))"), "replay retains original event and receipt clocks");
check(!/set\s+received_at\s*=/.test(ingress), "replay does not refresh receipt time");
check(sql.includes("alter column received_at set not null"), "all records have a bounded retention anchor");
check(sql.includes("where received_at is null"), "historical missing receipt anchors are repaired once");
check(sql.includes("create index resend_webhook_events_unowned_retention_idx"), "retention scan has an ownerless expiry index");
check(sql.includes("p_limit > 1000") && sql.includes("for update skip locked"), "prune is bounded and skips busy rows");
check(sql.includes("least(e.event_at, e.received_at) <= v_cutoff"), "prune uses immutable earliest clock");
check(sql.includes("least(e.event_at, e.received_at) <= p_now - interval '7 days'"), "expiry wakes scheduled maintenance");
check(finalize.indexOf("v_now >= v_attempt.retry_deadline_at") < finalize.indexOf("set resend_message_id = p_message_id"), "late unknown finalization stops before message binding");
check(finalize.includes("return query select 'ambiguous_expired'"), "late result is unconfirmed and manual review stays required");
check(parseResendEventCreatedAt("2026-01-01T00:00:00Z", Date.parse("2026-09-04T00:00:00Z")) !== null, "old owned events remain parseable");

const route = source("../app/api/webhooks/resend/route.ts");
const maintenance = source("../app/api/cron/account-deletion-maintenance/route.ts");
const workflow = source("../.github/workflows/daily-send.yml");
check(route.includes('status === "expired_unowned"'), "expired replay is acknowledged without retrying");
check(!route.includes("${emailId}"), "webhook logs and alerts do not retain provider identifiers");
check(!route.includes("recordError?.message"), "raw database errors do not escape into alerts");
check(maintenance.indexOf("await pruneUnownedResendEvents(sb)") < maintenance.indexOf("await reconcileStaleAccountDeletions"), "retention runs before slow account recovery");
check(maintenance.includes("resendEventRetention.remaining") && maintenance.includes("resendEventRetention.errors"), "retention failures and backlog raise review");
check(workflow.includes("Number(s.resendEventRetention.remaining)") && workflow.includes("s.resendEventRetention.errors"), "workflow fails visibly on retention errors or backlog");

console.log(`PASS verify-resend-event-retention (offline, ${checks} assertions)`);
