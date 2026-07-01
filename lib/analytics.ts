"use client";

// Thin analytics wrapper around PostHog. Entirely inert unless
// NEXT_PUBLIC_POSTHOG_KEY is set — no network calls, no cookies, nothing
// leaves the browser. First-party funnel measurement only (no session
// recording, no ad tracking), consistent with the "no tracking-for-sale"
// promise on the landing.
//
// posthog-js (~400-500KB) is dynamically imported only when the key is set,
// so it never ships in the shared client bundle for static/legal pages or
// for anyone running the app without analytics configured.
//
// To activate: set NEXT_PUBLIC_POSTHOG_KEY (and optionally
// NEXT_PUBLIC_POSTHOG_HOST, defaults to PostHog US cloud) in Vercel env.

let started = false;
let posthog: typeof import("posthog-js").default | null = null;

export function initAnalytics(): void {
  if (started || typeof window === "undefined") return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return; // inert until configured — posthog-js never even loads
  started = true; // claim the single init attempt before the async import resolves
  import("posthog-js").then(({ default: ph }) => {
    posthog = ph;
    ph.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      capture_pageview: false, // we capture manually on route change (App Router SPA)
      capture_pageleave: true,
      autocapture: true, // clicks on the funnel CTAs, for free
      disable_session_recording: true, // funnel metrics only — no screen capture
      person_profiles: "identified_only",
      respect_dnt: true,
    });
  });
}

export function capturePageview(path: string): void {
  if (!posthog) return;
  posthog.capture("$pageview", { $current_url: path });
}

// Money-moment events. Safe no-ops when analytics isn't configured, or while
// the dynamic import is still in flight.
export function track(event: string, props?: Record<string, unknown>): void {
  if (!posthog) return;
  posthog.capture(event, props);
}
