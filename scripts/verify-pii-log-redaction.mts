// Offline source guard for two request paths that previously copied user PII
// into operational logs or alerts. No env file, provider, or network is used.
import assert from "node:assert/strict";
import fs from "node:fs";

const support = fs.readFileSync(
  new URL("../app/api/support/route.ts", import.meta.url),
  "utf8"
);
const resend = fs.readFileSync(
  new URL("../app/api/webhooks/resend/route.ts", import.meta.url),
  "utf8"
);

assert.ok(!support.includes("from ${body.email}"));
assert.ok(!support.includes("body.message.replace"));
assert.match(support, /distributedRateLimitKeyHash/);
assert.match(support, /support-submission/);
assert.ok(!support.includes("support:${ip}:${body.email}:${body.message}"));
assert.ok(!support.includes("result.error.message"));
assert.ok(!/console\.(?:warn|error)\([^\n]*,\s*e\s*\)/.test(support));
assert.match(support, /console\.error\("\[support\] Supabase insert failed"\)/);
assert.ok(!resend.includes('recipients.join(", ")'));
assert.match(resend, /recipient_count=\$\{recipients\.length\}/);

console.log("PASS verify-pii-log-redaction (offline)");
