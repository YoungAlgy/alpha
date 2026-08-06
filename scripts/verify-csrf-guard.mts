// Behavioral verification of the CSRF guard (isCsrfGuarded + blocksCsrf,
// lib/csrf-guard.ts) that src/worker-entry.ts calls on every request.
// typecheck:worker only proves the caller compiles -- it says nothing about
// whether this logic is right. These two pure functions gate CSRF defense on
// 9 state-changing endpoints (account deletion, both Stripe endpoints,
// admin/users, /api/generate's authed branch, etc.) and are explicitly
// called out in worker-entry.ts's own header comment as security-critical
// and NOT redundant with anything else,
// so a silently-inverted condition or a dropped suffix would compile fine
// and only surface via exploitation.
//
// Imports from lib/csrf-guard.ts, not src/worker-entry.ts directly --
// worker-entry.ts's own top-level `import openNextWorker from
// '../.open-next/worker.js'` pulls in the built Workers bundle, which
// imports `cloudflare:` scheme modules that only resolve inside the actual
// Workers runtime, not plain node/tsx.
//
// Run: npx tsx scripts/verify-csrf-guard.mts
const { isCsrfGuarded, blocksCsrf } = await import("../lib/csrf-guard.ts");

let pass = 0,
  fail = 0;
function check(label: string, got: boolean, want: boolean) {
  const ok = got === want;
  console.log(`  ${ok ? "OK " : "XX "} ${label} → ${got} (want ${want})`);
  ok ? pass++ : fail++;
}

// ---- (A) isCsrfGuarded: every guarded suffix caught, an unguarded route isn't ----
console.log("(A) isCsrfGuarded coverage:");
const GUARDED_SUFFIXES = [
  "/api/resume",
  "/api/account/delete",
  "/api/account/profile",
  "/api/account/email/reconcile",
  "/api/account/topics",
  "/api/admin/users",
  "/api/stripe/portal",
  "/api/stripe/update-quantity",
  // Added 2026-08-06 (round 12): verifyPaid()'s live session-cookie-authed
  // branch fits this guard's own criteria — see lib/csrf-guard.ts's comment
  // on this entry.
  "/api/generate",
];
for (const suffix of GUARDED_SUFFIXES) {
  check(`guarded ${suffix}`, isCsrfGuarded(suffix), true);
  check(`guarded (prefixed) /x${suffix}`, isCsrfGuarded(`/x${suffix}`), true);
}
check("unguarded /api/stripe/webhook", isCsrfGuarded("/api/stripe/webhook"), false);

// ---- (B) blocksCsrf: method + Sec-Fetch-Site matrix on a guarded route ----
console.log("\n(B) blocksCsrf matrix on a guarded route (/api/account/delete):");
const GUARDED = "/api/account/delete";
check("POST, same-origin (null)", blocksCsrf("POST", null, GUARDED), false);
check("POST, Sec-Fetch-Site=same-origin", blocksCsrf("POST", "same-origin", GUARDED), false);
check("POST, Sec-Fetch-Site=same-site", blocksCsrf("POST", "same-site", GUARDED), true);
check("POST, Sec-Fetch-Site=cross-site", blocksCsrf("POST", "cross-site", GUARDED), true);
check("GET, cross-site", blocksCsrf("GET", "cross-site", GUARDED), false);
check("GET, same-site", blocksCsrf("GET", "same-site", GUARDED), false);
check("GET, null", blocksCsrf("GET", null, GUARDED), false);

// ---- (C) blocksCsrf: an unguarded route is never blocked, even cross-site POST ----
console.log("\n(C) blocksCsrf on an unguarded route (/api/stripe/webhook):");
check("POST, cross-site, unguarded route", blocksCsrf("POST", "cross-site", "/api/stripe/webhook"), false);

// ---- (D) blocksCsrf: /api/generate's LEGITIMATE caller (a same-origin
// relative fetch, app/writing/page.tsx) must still pass now that it's
// guarded -- only cross-site/same-site POSTs should be newly rejected ----
console.log("\n(D) blocksCsrf on /api/generate (now guarded):");
check("POST, same-origin (null) — the real caller — NOT blocked", blocksCsrf("POST", null, "/api/generate"), false);
check("POST, cross-site — a forged request — blocked", blocksCsrf("POST", "cross-site", "/api/generate"), true);
check("POST, same-site — a forged request — blocked", blocksCsrf("POST", "same-site", "/api/generate"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CSRF GUARD VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CSRF GUARD ASSERTIONS PASS");
