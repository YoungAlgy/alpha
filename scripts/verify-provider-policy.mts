import { paidAiEnabled } from "../lib/engine/provider-policy.ts";

let failures = 0;
function check(label: string, expected: boolean): void {
  const actual = paidAiEnabled();
  if (actual === expected) return;
  failures++;
  console.error(`FAIL: ${label} (expected ${expected}, got ${actual})`);
}

const previous = process.env.ALPHA_ALLOW_PAID_AI;
try {
  delete process.env.ALPHA_ALLOW_PAID_AI;
  check("missing policy disables paid AI", false);

  for (const value of ["", "0", "false", "no", "paid", "enabled"]) {
    process.env.ALPHA_ALLOW_PAID_AI = value;
    check(`non-explicit value ${JSON.stringify(value)} disables paid AI`, false);
  }

  for (const value of ["1", "true", "TRUE", "yes", " Yes "]) {
    process.env.ALPHA_ALLOW_PAID_AI = value;
    check(`explicit value ${JSON.stringify(value)} enables paid AI`, true);
  }
} finally {
  if (previous === undefined) delete process.env.ALPHA_ALLOW_PAID_AI;
  else process.env.ALPHA_ALLOW_PAID_AI = previous;
}

if (failures > 0) {
  console.error(`verify-provider-policy: ${failures} failure(s)`);
  process.exit(1);
}
console.log("PASS verify-provider-policy (offline)");
