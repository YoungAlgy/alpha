#!/usr/bin/env node
// Fails the build LOUDLY if a build-time-inlined NEXT_PUBLIC_* var resolves
// empty or missing. Written 2026-08-05 after a stale, gitignored
// `.env.production.local` (a "Created by Vercel CLI" leftover from before the
// Cloudflare migration) silently overrode NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY with empty strings on every WSL build
// since 2026-07-03 -- including that morning's cron-outage-fix deploy. Next.js
// inlines NEXT_PUBLIC_* references at build time; a bad value baked in this
// way is NOT fixable by any Cloudflare/Wrangler runtime secret afterward, and
// `next build` gives zero warning when it happens. This script uses the exact
// same env-resolution Next.js itself uses (`@next/env`'s loadEnvConfig, same
// precedence: .env.production.local > .env.local > .env.production > .env),
// so it fails BEFORE a broken value ever reaches a deploy, instead of relying
// on catching it after the fact via manual testing or a 20-hour watchdog.
//
// Run this before every build, not just before deploy -- `npm run cf:build`
// (used for `cf:preview` too) and `npm run cf:deploy` both call it as their
// first step. See package.json.

import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

// Only the vars that are actually NEXT_PUBLIC_*-prefixed and referenced by
// app code matter here -- server-only secrets (ANTHROPIC_API_KEY, etc.) are
// read live from the Cloudflare Worker's runtime bindings, not baked in at
// build time, so a wrong LOCAL value for those doesn't ship broken (it just
// makes local dev behave differently from prod, a separate, lower-stakes
// class of problem this script doesn't try to solve).
const REQUIRED_PUBLIC_VARS = [
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    validate: (v) => /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(v),
    hint: "expected https://<ref>.supabase.co",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    validate: (v) => v.length > 20,
    hint: "expected a real publishable key (sb_publishable_... or a legacy anon JWT), got something implausibly short",
  },
];

const { combinedEnv, loadedEnvFiles } = loadEnvConfig(process.cwd(), false);

let failed = false;
for (const { name, validate, hint } of REQUIRED_PUBLIC_VARS) {
  const value = combinedEnv[name];
  if (!value || !validate(value)) {
    failed = true;
    console.error(`\n::error:: ${name} resolved to ${JSON.stringify(value ?? "")} -- ${hint}`);
    // Show which files were loaded, in the exact precedence order Next.js
    // used, so whoever hits this can see WHICH file is winning and overriding
    // a good value -- this is what would have made today's bug obvious in
    // seconds instead of requiring live behavioral testing against prod to
    // diagnose after the fact.
    console.error("  Env files loaded (later entries win ties for the same key):");
    for (const f of loadedEnvFiles) {
      const hasKey = Object.prototype.hasOwnProperty.call(f.env, name);
      console.error(`    - ${f.path}${hasKey ? ` (sets ${name}=${JSON.stringify(f.env[name])})` : ""}`);
    }
  }
}

if (failed) {
  console.error(
    "\n::error:: Build-time env verification failed. This is NOT a Wrangler secret " +
    "problem -- these vars are inlined into the bundle at BUILD time and no runtime " +
    "`wrangler secret put` can fix a bad value baked in this way. Fix the local .env " +
    "file(s) above (the one that sets the wrong value wins) and rebuild.\n"
  );
  process.exit(1);
}

console.log(`OK: verified ${REQUIRED_PUBLIC_VARS.length} build-time env var(s) against ${loadedEnvFiles.length} loaded env file(s).`);
