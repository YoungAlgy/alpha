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

const BASE_URL = process.env.SMOKE_TEST_URL?.trim() || "https://alpha.everyday.report";
const TIMEOUT_MS = 10_000;

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
    name: "/api/health reachable + core providers configured",
    hard: true,
    run: async () => {
      const res = await fetchWithTimeout(`${BASE_URL}/api/health`);
      if (res.status !== 200) return { ok: false, detail: `status ${res.status}` };
      const body = await res.json();
      const CORE = ["anthropic", "resend", "stripe", "stripeWebhook", "supabase"];
      const bad = CORE.filter((k) => body?.checks?.[k] !== true);
      if (bad.length > 0) {
        return { ok: false, detail: `checks.${bad.join(", checks.")} not true -- got ${JSON.stringify(body?.checks)}` };
      }
      const SOFT = ["gemini", "you", "groq", "deepseek"];
      const softBad = SOFT.filter((k) => body?.checks?.[k] !== true);
      if (softBad.length > 0) {
        console.warn(`  (soft warning, not failing) resilience-tier fallback(s) inert: ${softBad.join(", ")}`);
      }
      return { ok: true, detail: "core providers all true" };
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
      const res = await fetchWithTimeout(
        `${BASE_URL}/api/unsubscribe?t=smoke-test-invalid-token-${Date.now()}`
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
