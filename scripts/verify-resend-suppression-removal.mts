// Verifies the fix (alpha-drift-r17-06, 2026-08-07) for a real gap: Resend
// maintains its OWN account-level suppression list, separate from this app's
// bounced_at/complained_at columns. Clearing this app's own DB columns alone
// (round 17 finding #5's fix) would NOT restore delivery -- Resend would keep
// silently skipping the send regardless of what this app's tables say.
//
// Exercises the REAL Resend REST API end-to-end against a synthetic,
// never-real email: add it to the suppression list, confirm removeResend
// Suppression() actually removes it, and confirm the idempotent/already-
// removed case (a 404 from Resend) is still treated as success.
// Run: npx tsx scripts/verify-resend-suppression-removal.mts
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

const key = process.env.RESEND_API_KEY?.trim();
if (!key) {
  console.log("SKIP: RESEND_API_KEY not set locally.");
  process.exit(0);
}

const SYNTHETIC_EMAIL = `alpha-test-r17-06-${Date.now()}@example.invalid`;

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

async function addSuppression(email: string) {
  return fetch("https://api.resend.com/suppressions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}
async function getSuppression(email: string) {
  return fetch(`https://api.resend.com/suppressions/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

const { removeResendSuppression } = await import("../lib/email.ts");

console.log(`(1) add a synthetic address (${SYNTHETIC_EMAIL}) to Resend's real suppression list`);
{
  const res = await addSuppression(SYNTHETIC_EMAIL);
  check("(1) add-suppression call succeeded", res.ok);
  const check1 = await getSuppression(SYNTHETIC_EMAIL);
  check("(1) address is actually suppressed now (confirmed via GET)", check1.ok);
}

console.log("(2) removeResendSuppression() actually removes it from Resend's real list");
{
  const removed = await removeResendSuppression(SYNTHETIC_EMAIL);
  check("(2) removeResendSuppression returned true", removed === true);
  const after = await getSuppression(SYNTHETIC_EMAIL);
  check("(2) address is genuinely no longer suppressed (GET now 404s) -- THE BUG THIS FIX CLOSES", after.status === 404);
}

console.log("(3) removing an address that was never suppressed is treated as success (idempotent)");
{
  const neverSuppressed = `alpha-test-r17-06-never-${Date.now()}@example.invalid`;
  const removed = await removeResendSuppression(neverSuppressed);
  check("(3) removeResendSuppression returned true for a never-suppressed address", removed === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("RESEND-SUPPRESSION-REMOVAL VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL RESEND-SUPPRESSION-REMOVAL ASSERTIONS PASS");
