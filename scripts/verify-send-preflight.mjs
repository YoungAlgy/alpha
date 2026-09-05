#!/usr/bin/env node
// Pre-flight check for the daily send job (.github/workflows/daily-send.yml),
// run BEFORE the expensive build+generation step. Written 2026-08-05 after
// two real, separate incidents on the same day: (1) UNSUBSCRIBE_SECRET was
// silently missing from this workflow's secrets -- every subscriber's
// generation ran to completion before failing at the very last step, and
// (2) a broken Resend key/domain meant real Anthropic/Gemini/Groq/DeepSeek
// generation costs were spent for all 4 subscribers locally before anyone
// noticed delivery was impossible. This script catches both classes before
// dependency installation, build, or content generation begins.
//
// The fixed HARD vars are things without which nothing can work at all.
// Generators are soft resilience tiers. With none configured, the route can
// still reuse an already usable persisted issue or its bounded prior-issue
// backup. Blocking before the route runs would disable those zero-model-cost
// recovery paths at exactly the moment they are needed.

import { isExactAlphaSupabaseUrl } from "./alpha-supabase-url.mjs";

const GENERATOR_KEYS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
];

const MAINTENANCE_REQUIRED = [
  "CRON_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "CHECKOUT_BINDING_SECRET",
];

const DELIVERY_REQUIRED = [
  "RESEND_API_KEY",
  "RESEND_FROM",
  "UNSUBSCRIBE_SECRET",
];

const SOFT_RESILIENCE_TIER = [
  ...GENERATOR_KEYS,
  "BRAVE_SEARCH_API_KEY",
  "YOU_API_KEY",
  "ALPHA_OPS_ALERT_WEBHOOK_URL",
];

let maintenanceFailures = 0;
let deliveryReady = true;

function configured(name) {
  return Boolean(process.env[name]?.trim());
}

function enabled(name) {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function setWorkflowOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) return;
  const fs = await import("node:fs");
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

for (const name of MAINTENANCE_REQUIRED) {
  if (!configured(name)) {
    console.error(`::error::${name} is not set (or empty). Local scheduled maintenance cannot run safely.`);
    maintenanceFailures++;
  }
}

if (
  configured("NEXT_PUBLIC_SUPABASE_URL") &&
  !isExactAlphaSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
) {
  console.error(
    "::error::NEXT_PUBLIC_SUPABASE_URL does not match Alpha's dedicated Supabase project (value withheld)."
  );
  maintenanceFailures++;
}

for (const name of DELIVERY_REQUIRED) {
  if (!configured(name)) {
    console.error(`::error::${name} is not set (or empty). Letter generation will be skipped, but billing and privacy maintenance can still run.`);
    deliveryReady = false;
  }
}

if (
  configured("UNSUBSCRIBE_SECRET") &&
  process.env.UNSUBSCRIBE_SECRET.trim().length < 32
) {
  console.error(
    "::error::UNSUBSCRIBE_SECRET is too short for Alpha's token and distributed abuse-protection HMAC root."
  );
  deliveryReady = false;
}

const strictNoModel = enabled("ALPHA_NO_MODEL_MODE");
const publicFeedEnabled = enabled("ALPHA_PUBLIC_FEED_FALLBACK");
const configuredGenerators = GENERATOR_KEYS.filter(configured);
if (!strictNoModel && configuredGenerators.length === 0) {
  console.warn(
    `::warning::No content generator is configured. Fresh generation is unavailable, but backup-only mode can still use an already usable persisted issue or bounded prior-issue backup. Configure one of: ${GENERATOR_KEYS.join(", ")}.`
  );
}

if (strictNoModel) {
  console.log("OK: strict no-model mode is enabled; local source formatting will be used.");
}

const freshSourceTiers = [
  configured("BRAVE_SEARCH_API_KEY") ? "brave" : null,
  !strictNoModel && configured("GEMINI_API_KEY") ? "gemini-grounded" : null,
  configured("YOU_API_KEY") ? "you" : null,
  publicFeedEnabled ? "public-feed" : null,
].filter(Boolean);
const freshSourceReady = freshSourceTiers.length > 0;
if (!freshSourceReady) {
  console.warn(
    "::warning::No current-source discovery tier is configured for this run. Only an already persisted issue or the bounded prior-issue backup can be delivered."
  );
} else {
  console.log(`OK: current-source discovery tiers configured: ${freshSourceTiers.join(", ")}.`);
}

for (const name of SOFT_RESILIENCE_TIER) {
  if (!configured(name)) {
    console.warn(`::warning::${name} is not set -- that resilience-tier fallback is inert (degrades quality/robustness, doesn't block the send).`);
  }
}

if (!configured("STRIPE_SECRET_KEY")) {
  console.warn(
    "::warning::STRIPE_SECRET_KEY is not set. Letter delivery can continue, but overdue paid-checkout cleanup cannot verify or cancel its exact Stripe subscription and the workflow will report a maintenance failure if one is due."
  );
}

if (maintenanceFailures > 0) {
  await setWorkflowOutput("maintenance_ready", "false");
  await setWorkflowOutput("delivery_ready", "false");
  await setWorkflowOutput("fresh_source_ready", "false");
  console.error(
    `\n::error:: ${maintenanceFailures} maintenance requirement(s) failed. Stopping because the local repair route cannot authenticate or reach its database. ` +
    `Check this workflow's secrets against the SEND_* (or WATCHDOG_*) values in the repo settings.`
  );
  process.exit(1);
}

await setWorkflowOutput("maintenance_ready", "true");
await setWorkflowOutput("fresh_source_ready", String(freshSourceReady));

console.log(
  `OK: all ${MAINTENANCE_REQUIRED.length} maintenance secrets present and ` +
  `${configuredGenerators.length} content generator(s) configured` +
  `${configuredGenerators.length > 0 ? ` (${configuredGenerators.join(", ")})` : " (backup-only mode)"}.`
);

// Live Resend check -- confirms the key is valid AND the from-domain is
// actually verified under this account, the EXACT two-bug combination that
// broke delivery today (a revoked key, separately a from-address on an
// unrelated business's unverified domain). GET /domains costs nothing and
// sends no email, but proves both facts: the key authenticates, and we can
// cross-check the from-domain against what Resend actually has verified.
if (deliveryReady) {
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`::error::Resend API key check failed (HTTP ${res.status}). Letter generation will be skipped; maintenance will still run.`);
      deliveryReady = false;
    } else {
      const data = await res.json();
      const domains = (data.data || []).map((d) => d.name);
      const fromMatch = process.env.RESEND_FROM?.match(/@([^\s>]+)/);
      const fromDomain = fromMatch ? fromMatch[1] : null;
      if (!fromDomain || !domains.includes(fromDomain)) {
        console.error(
          `::error::RESEND_FROM's domain (${fromDomain ?? "invalid"}) is not verified in this Resend account. Letter generation will be skipped; maintenance will still run.`
        );
        deliveryReady = false;
      } else {
        console.log(`OK: Resend key valid, RESEND_FROM domain (${fromDomain}) is verified.`);
      }
    }
  } catch (e) {
    console.error(`::error::Resend connectivity check failed: ${e instanceof Error ? e.message : e}. Letter generation will be skipped; maintenance will still run.`);
    deliveryReady = false;
  }
}

await setWorkflowOutput("delivery_ready", String(deliveryReady));
if (!deliveryReady) {
  console.error("::error::Delivery preflight failed. The workflow will run maintenance locally, skip letter generation, then fail red.");
}
