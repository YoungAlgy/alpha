// Offline verification for Stripe webhook processing leases. This replaces
// the old live Supabase mutation script. It loads no environment file, writes
// no database rows, and contacts no external system.
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed++;
  else failed++;
}

const route = readFileSync(
  new URL("../app/api/stripe/webhook/route.ts", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260827010000_stripe_webhook_event_leases.sql",
    import.meta.url
  ),
  "utf8"
);

console.log("(1) database claim distinguishes processing from success");
check("event rows carry processing/succeeded state", /status in \('processing', 'succeeded'\)/.test(migration));
check("claim function locks the event row", /where id = p_event_id\s+for update;/.test(migration));
check("completed events return succeeded", /if v_row\.status = 'succeeded'[\s\S]*return 'succeeded';/.test(migration));
check("live leases return in_progress", /v_row\.lease_expires_at > now\(\)[\s\S]*return 'in_progress';/.test(migration));
check("expired or new events return claimed", /return 'claimed';/.test(migration));

console.log("(2) route fails closed around the durable lease");
check("route claims through the database function", /\.rpc\(\s*"claim_stripe_webhook_event"/.test(route));
check("claim storage errors return 503", /event claim failed:[\s\S]*status: 503/.test(route));
check("only succeeded duplicates return success", /claimDecision === "succeeded"[\s\S]*received: true/.test(route));
check("processing duplicates return non-2xx", /claimDecision === "in_progress"[\s\S]*status: 409/.test(route));

console.log("(3) failure release and success completion are ownership guarded");
check("failure cleanup matches the processing state", /\.eq\("status", "processing"\)/.test(route));
check("failure cleanup matches this request's lease", /\.eq\("lease_token", webhookLeaseToken\)/.test(route));
check("success writes a succeeded marker", /status: "succeeded"/.test(route));
check("completion-marker failure returns 500", /webhook completion unavailable[\s\S]*status: 500/.test(route));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("WEBHOOK DEDUP LEASE VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL WEBHOOK DEDUP LEASE ASSERTIONS PASS");
