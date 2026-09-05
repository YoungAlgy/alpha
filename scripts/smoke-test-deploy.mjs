#!/usr/bin/env node
// Hits the LIVE deployed site right after `opennextjs-cloudflare deploy` and
// fails loudly (non-zero exit) if anything's actually broken. Written
// 2026-08-05 after a real incident: a deploy went out with Supabase silently
// broken (a poisoned build-time env var), and the only reason it got caught
// same-day was a human manually curling routes out of habit -- the deploy
// script itself declared success and moved on. This is the difference
// between "detect within 20 hours via the watchdog" and "know within seconds
// of the deploy command finishing." Wired as the last step of `npm run
// cf:deploy` in package.json -- if this fails, the deploy is NOT actually
// done, even though wrangler already reported success.
//
// Deliberately does NOT hit anything that mutates real data or sends a real
// email/letter (no /api/generate, no /api/cron/weekly-send) -- every probe
// here is either read-only or a request that's EXPECTED to fail validation
// before touching anything real.

const CANONICAL_BASE_URL = "https://alpha.everyday.report";
const configuredBaseUrl = process.env.SMOKE_TEST_URL?.trim() || CANONICAL_BASE_URL;
let parsedBaseUrl;
try {
  parsedBaseUrl = new URL(configuredBaseUrl);
} catch {
  console.error("::error:: SMOKE_TEST_URL must be the canonical Alpha HTTPS host (value withheld).");
  process.exit(1);
}
if (
  parsedBaseUrl.protocol !== "https:" ||
  parsedBaseUrl.hostname !== "alpha.everyday.report" ||
  parsedBaseUrl.port !== "" ||
  !["", "/"].includes(parsedBaseUrl.pathname) ||
  parsedBaseUrl.username !== "" ||
  parsedBaseUrl.password !== "" ||
  parsedBaseUrl.search !== "" ||
  parsedBaseUrl.hash !== ""
) {
  console.error("::error:: SMOKE_TEST_URL must be the canonical Alpha HTTPS host (value withheld).");
  process.exit(1);
}
const BASE_URL = parsedBaseUrl.origin;
const EXPECTED_RELEASE = process.env.ALPHA_EXPECTED_RELEASE_SHA?.trim() || "";
const EXPECTED_CHECKOUT_MODE =
  process.env.ALPHA_EXPECTED_CHECKOUT_MODE?.trim() || "";
const TIMEOUT_MS = 10_000;

if (!/^[0-9a-f]{40}$/.test(EXPECTED_RELEASE)) {
  console.error(
    "::error:: ALPHA_EXPECTED_RELEASE_SHA must be the full 40-character commit SHA. " +
      "Use scripts/deploy-from-wsl.sh so the intended release is captured before deployment."
  );
  process.exit(1);
}
if (EXPECTED_CHECKOUT_MODE !== "paused") {
  console.error(
    "::error:: Access-only releases require ALPHA_EXPECTED_CHECKOUT_MODE=paused."
  );
  process.exit(1);
}

function accessOnlyHealthMatches(body) {
  return body?.accessMode === "invite" && body?.subscriberDeliveryMode === "paused";
}

function noChargeResponseMatches(status, body, cacheControl, expectedError) {
  return status === 410 && body?.error === expectedError && cacheControl.includes("no-store");
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// { name, run: () => Promise<{ok: boolean, detail: string}>, hard: boolean }
// hard:true fails the whole script; hard:false only warns (matches the app's
// own severity model -- e.g. groq/deepseek/you are resilience fallbacks that
// can legitimately be down without the product being broken, see
// app/api/health/route.ts's own comments on those fields).
const CHECKS = [
  {
    name: "homepage loads",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/`);
      return { ok: res.status === 200, detail: `status ${res.status}` };
    },
  },
  {
    name: "/api/health reachable + hard product dependencies configured",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/health`);
      if (res.status !== 200) return { ok: false, detail: `status ${res.status}` };
      const body = await res.json();
      const CORE = [
        "resend",
        "stripe",
        "stripeWebhook",
        "checkoutBinding",
        "unsubscribe",
        "legacyCheckoutCutoff",
        "supabase",
      ];
      const bad = CORE.filter((k) => body?.checks?.[k] !== true);
      if (bad.length > 0) {
        return { ok: false, detail: `checks.${bad.join(", checks.")} not true -- got ${JSON.stringify(body?.checks)}` };
      }
      if (body?.release !== EXPECTED_RELEASE) {
        return {
          ok: false,
          detail: `release ${JSON.stringify(body?.release)} does not match intended ${EXPECTED_RELEASE}`,
        };
      }
      if (body?.checkoutMode !== EXPECTED_CHECKOUT_MODE) {
        return {
          ok: false,
          detail: `checkoutMode ${JSON.stringify(body?.checkoutMode)} does not match intended ${EXPECTED_CHECKOUT_MODE}`,
        };
      }
      if (!accessOnlyHealthMatches(body)) {
        return {
          ok: false,
          detail: `accessMode ${JSON.stringify(body?.accessMode)}; subscriberDeliveryMode ${JSON.stringify(body?.subscriberDeliveryMode)}`,
        };
      }
      // This mirrors verify-send-preflight's resilience tier. Anthropic is an
      // optional backup generator, so an absent key belongs here as a warning,
      // not in CORE as a deploy blocker.
      const SOFT = ["anthropic", "gemini", "you", "groq", "deepseek", "brave"];
      const softBad = SOFT.filter((k) => body?.checks?.[k] !== true);
      if (softBad.length > 0) {
        console.warn(`  (soft warning, not failing) resilience-tier fallback(s) inert: ${softBad.join(", ")}`);
      }
      return {
        ok: true,
        detail: `hard product dependencies all true; release ${EXPECTED_RELEASE}; invite access; checkout and subscriber delivery paused`,
      };
    },
  },
  {
    name: "/api/health is not stale-cached",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/health`);
      const cc = res.headers.get("cache-control") || "";
      return {
        ok: cc.includes("no-store"),
        detail: `Cache-Control: ${cc || "(none)"} -- this endpoint must never be cacheable, a cached false-positive here already masked a real outage once`,
      };
    },
  },
  {
    name: "Supabase session-auth path (unauthenticated POST should 401, not 500)",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/account/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics: ["smoke-test"] }),
      });
      return {
        ok: res.status === 401,
        detail: `status ${res.status} (expected 401 "Sign in first" -- a 500 here means supabaseServerClient() is broken)`,
      };
    },
  },
  {
    name: "Supabase service-role path (invalid unsubscribe token should 400, not 500)",
    hard: true,
    run: async () => {
      // alpha-drift-r50-04 (2026-08-20): this used to query `?t=`, but the
      // route reads `token` (lib/unsubscribe.ts's own unsubscribeUrl()
      // helper builds every real link as `?token=...`) -- the wrong param
      // name meant this was silently exercising the "no token supplied"
      // path (falls back to "", same 400 as a malformed one) rather than
      // the "invalid token value" path its own name and comment claim to
      // test. Fixed to the real param name.
      const res = await fetchWithTimeout(
        `${BASE_URL}/api/unsubscribe?token=smoke-test-invalid-token-${Date.now()}`
      );
      return {
        ok: res.status === 400,
        detail: `status ${res.status} (expected 400 "Invalid or expired link" -- a 500 here means supabaseServiceClient() is broken)`,
      };
    },
  },
  {
    name: "Resend webhook is configured (missing svix headers should 400, not 503/500)",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/webhooks/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return {
        ok: res.status === 400,
        detail: `status ${res.status} (expected 400 "Missing svix headers" -- a 503 here means RESEND_WEBHOOK_SECRET isn't set, a 500 means the route itself is broken)`,
      };
    },
  },
  {
    // alpha-drift-r16-07 (found+fixed 2026-08-07): /letter server-renders
    // real subscriber PII (name, city, letter body) keyed only by a signed
    // token, no session required -- the same "must never be cacheable"
    // stakes as /api/health above. next.config.ts's headers() rule for
    // this path turned out to be insufficient on its own (Next's own
    // dynamic-page rendering sets a competing default that wins over it);
    // the real fix lives in src/worker-entry.ts, which runs after Next has
    // already built the response. This check is what would have caught
    // that gap immediately instead of relying on a manual curl.
    name: "/letter is not stale-cached",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/letter?t=smoke-test-invalid-token-${Date.now()}`);
      const cc = res.headers.get("cache-control") || "";
      return {
        ok: cc.includes("no-store"),
        detail: `Cache-Control: ${cc || "(none)"} -- this route carries real subscriber PII and must never be cacheable by an intermediary (email security gateways auto-fetch this exact URL shape)`,
      };
    },
  },
  {
    // alpha-drift-r49-05 (2026-08-20): the /letter check above was the ONLY
    // stale-cache regression guard in this script -- src/worker-entry.ts's
    // no-store override used to be /letter-only, so every one of the app's
    // other ~19 statically-prerendered, session-bearing pages (this app's
    // own settings.settings/accounts admin panel among them) had no
    // equivalent guard here to catch a future regression the way this check
    // now does. src/worker-entry.ts's fix broadened the override to apply
    // unconditionally to every non-static-asset route, so any one of those
    // pages works as a representative check -- /settings/accounts picked
    // since it's the highest-stakes of the bunch (admin data).
    name: "/settings/accounts is not stale-cached",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/settings/accounts`);
      const cc = res.headers.get("cache-control") || "";
      return {
        ok: cc.includes("no-store"),
        detail: `Cache-Control: ${cc || "(none)"} -- a statically-prerendered page like this one defaults to the ASSETS binding's own max-age=0 (not no-store) unless src/worker-entry.ts's broad override is actually applying`,
      };
    },
  },
  {
    // Same regression class as above, on the one OTHER non-static-asset
    // shape this app serves: a per-request dynamic page (Next's own
    // "ƒ Dynamic" render, distinct from the ASSETS-binding-served static
    // pages the check above covers).
    name: "/inbox/[issueId] is not stale-cached",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/inbox/smoke-test-nonexistent-id`);
      const cc = res.headers.get("cache-control") || "";
      return {
        ok: cc.includes("no-store"),
        detail: `Cache-Control: ${cc || "(none)"} -- a dynamic page like this one defaults to Next's own no-cache (not no-store) unless src/worker-entry.ts's broad override is actually applying`,
      };
    },
  },
];

CHECKS.splice(2, 0,
  {
    name: "public checkout is permanently closed before provider access",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/stripe/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        // The structured response is part of this hard check.
      }
      const cacheControl = res.headers.get("cache-control") || "";
      return {
        ok: noChargeResponseMatches(res.status, body, cacheControl, "invite_only"),
        detail: `status ${res.status}; error ${JSON.stringify(body?.error)}; Cache-Control ${cacheControl || "(none)"}`,
      };
    },
  },
  {
    name: "paid quantity changes are permanently closed before provider access",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/stripe/update-quantity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "up", expectedQuantity: 1 }),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        // The structured validation response is part of this hard check.
      }
      const cacheControl = res.headers.get("cache-control") || "";
      return {
        ok: noChargeResponseMatches(
          res.status,
          body,
          cacheControl,
          "Alpha is invite-only now. Paid plan changes are closed. You can still turn off renewal from Settings."
        ),
        detail: `status ${res.status}; error ${JSON.stringify(body?.error)}; Cache-Control ${cacheControl || "(none)"}`,
      };
    },
  },
  {
    name: "billing portal is permanently closed before provider access",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/stripe/portal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        // The structured authentication response is part of this hard check.
      }
      return {
        ok: noChargeResponseMatches(
          res.status,
          body,
          res.headers.get("cache-control") || "",
          "Alpha is invite-only. Billing changes are closed."
        ),
        detail: `status ${res.status}; error ${JSON.stringify(body?.error)}`,
      };
    },
  }
);

let hardFailures = 0;
console.log(`Smoke-testing ${BASE_URL} ...\n`);

for (const check of CHECKS) {
  let result;
  try {
    result = await check.run();
  } catch (e) {
    result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const label = result.ok ? "PASS" : check.hard ? "FAIL" : "WARN";
  console.log(`[${label}] ${check.name} -- ${result.detail}`);
  if (!result.ok && check.hard) hardFailures++;
}

if (hardFailures > 0) {
  console.error(
    `\n::error:: ${hardFailures} smoke-test check(s) failed against the LIVE deploy. ` +
    `The deploy command reported success but the site is not actually healthy -- do not walk away, ` +
    `investigate now (see lib/supabase/server.ts, scripts/verify-build-env.mjs, or check ` +
    `\`wrangler tail\` for the real error).`
  );
  process.exit(1);
}

console.log(`\nOK: all hard checks passed against ${BASE_URL}.`);
