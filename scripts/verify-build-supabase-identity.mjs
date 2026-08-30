#!/usr/bin/env node

// Deployment-only identity check for build-time Supabase configuration.
// Next.js inlines these values into the client bundle, so a stale WSL
// .env.local can ship a valid-looking key for the wrong project. This probe
// sends no subscriber data and prints no environment value.

import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
const ALPHA_SUPABASE_HOST = "xpqxhdciaoicsnyyfshy.supabase.co";
const { combinedEnv } = loadEnvConfig(process.cwd(), false);

const rawUrl = combinedEnv.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
const publishableKey =
  combinedEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || "";

let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  console.error("::error:: Alpha Supabase build URL is missing or invalid; value withheld.");
  process.exit(1);
}

if (
  parsed.protocol !== "https:" ||
  parsed.hostname !== ALPHA_SUPABASE_HOST ||
  (parsed.pathname !== "/" && parsed.pathname !== "") ||
  parsed.username ||
  parsed.password ||
  parsed.search ||
  parsed.hash
) {
  console.error(
    `::error:: Build URL is not the dedicated Alpha Supabase project (${ALPHA_SUPABASE_HOST}); value withheld.`
  );
  process.exit(1);
}

if (!publishableKey) {
  console.error("::error:: Alpha Supabase publishable key is missing; value withheld.");
  process.exit(1);
}

let response;
try {
  response = await fetch(new URL("/auth/v1/settings", parsed), {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${publishableKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
} catch (error) {
  console.error(
    `::error:: Alpha Supabase build identity probe failed before a response: ${
      error instanceof Error ? error.name : "unknown error"
    }`
  );
  process.exit(1);
}

if (!response.ok) {
  console.error(
    `::error:: Alpha Supabase rejected the build-time project/key pair with HTTP ${response.status}; response withheld.`
  );
  process.exit(1);
}

const contentType = response.headers.get("content-type") || "";
if (!contentType.toLowerCase().includes("application/json")) {
  console.error(
    "::error:: Alpha Supabase identity probe returned an unexpected content type; body withheld."
  );
  process.exit(1);
}

console.log(
  `OK: build-time Supabase URL and publishable key were accepted by the dedicated Alpha project (${ALPHA_SUPABASE_HOST}).`
);
