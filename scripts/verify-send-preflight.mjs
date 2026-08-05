#!/usr/bin/env node
// Pre-flight check for the daily send job (.github/workflows/daily-send.yml),
// run BEFORE the expensive build+generation step. Written 2026-08-05 after
// two real, separate incidents on the same day: (1) UNSUBSCRIBE_SECRET was
// silently missing from this workflow's secrets -- every subscriber's
// generation ran to completion before failing at the very last step, and
// (2) a broken Resend key/domain meant real Anthropic/Gemini/Groq/DeepSeek
// generation costs were spent for all 4 subscribers locally before anyone
// noticed delivery was impossible. This script makes both classes of bug
// fail in under a second, before a single real API call happens.
//
// Two tiers, matching the app's own resilience model (see app/api/health's
// own checks.* categorization): HARD vars are things without which nothing
// can work at all; SOFT vars are resilience-tier fallbacks (missing one just
// means that tier is inert, not that the send is broken).

const HARD_REQUIRED = [
  "CRON_SECRET",
  "ANTHROPIC_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "UNSUBSCRIBE_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
];

const SOFT_RESILIENCE_TIER = [
  "BRAVE_SEARCH_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "YOU_API_KEY",
];

let hardFailures = 0;

for (const name of HARD_REQUIRED) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    console.error(`::error::${name} is not set (or empty). This is required for the send to work at all.`);
    hardFailures++;
  }
}

for (const name of SOFT_RESILIENCE_TIER) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    console.warn(`::warning::${name} is not set -- that resilience-tier fallback is inert (degrades quality/robustness, doesn't block the send).`);
  }
}

if (hardFailures > 0) {
  console.error(
    `\n::error:: ${hardFailures} required secret(s) missing. Stopping before spending any time or money on a build+generation run that can't deliver. ` +
    `Check this workflow's secrets against the SEND_* (or WATCHDOG_*) values in the repo settings.`
  );
  process.exit(1);
}

console.log(`OK: all ${HARD_REQUIRED.length} hard-required secrets present.`);

// Live Resend check -- confirms the key is valid AND the from-domain is
// actually verified under this account, the EXACT two-bug combination that
// broke delivery today (a revoked key, separately a from-address on an
// unrelated business's unverified domain). GET /domains costs nothing and
// sends no email, but proves both facts: the key authenticates, and we can
// cross-check the from-domain against what Resend actually has verified.
try {
  const res = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`::error::Resend API key check failed (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }
  const data = await res.json();
  const domains = (data.data || []).map((d) => d.name);
  const fromMatch = process.env.RESEND_FROM?.match(/@([^\s>]+)/);
  const fromDomain = fromMatch ? fromMatch[1] : null;
  if (fromDomain && !domains.includes(fromDomain)) {
    console.error(
      `::error::RESEND_FROM's domain (${fromDomain}) is not in this Resend account's verified domain list ` +
      `(${domains.join(", ") || "none"}). Every send will 403 with "domain is not verified" -- this is ` +
      `the exact bug found live 2026-08-05 (RESEND_FROM pointed at an unrelated business's unverified domain).`
    );
    process.exit(1);
  }
  console.log(`OK: Resend key valid, RESEND_FROM domain (${fromDomain}) is verified.`);
} catch (e) {
  console.error(`::error::Resend connectivity check failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
