"use client";

// Thin analytics wrapper around PostHog. Entirely inert unless
// NEXT_PUBLIC_POSTHOG_KEY is set — no network calls, no cookies, nothing
// leaves the browser. First-party funnel measurement only (no session
// recording, no ad tracking), consistent with the "no tracking-for-sale"
// promise on the landing.
//
// posthog-js (~400-500KB) is dynamically imported only when the key is set,
// so it never ships in the shared client bundle for static/legal pages or
// for anyone running the app without analytics configured. Events fired
// before the import resolves (the very first pageview is the common case —
// PostHogProvider calls initAnalytics() then capturePageview() in the same
// mount) are queued and flushed once posthog is ready, rather than dropped.
//
// To activate: set NEXT_PUBLIC_POSTHOG_KEY (and optionally
// NEXT_PUBLIC_POSTHOG_HOST, defaults to PostHog US cloud) in Vercel env.

let started = false;
let posthog: typeof import("posthog-js").default | null = null;
let queue: Array<() => void> = [];

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
    const pending = queue;
    queue = [];
    pending.forEach((fn) => fn());
  });
}

function capture(event: string, props?: Record<string, unknown>): void {
  if (!started) return; // analytics not configured at all — stay a true no-op
  if (!posthog) {
    // import("posthog-js") is still in flight — queue rather than drop.
    // Bounded defensively; a real page can't plausibly fire this many events
    // before a same-origin chunk fetch resolves.
    if (queue.length < 20) queue.push(() => capture(event, props));
    return;
  }
  posthog.capture(event, props);
}

export function capturePageview(path: string): void {
  capture("$pageview", { $current_url: path });
}

// Money-moment events. Safe no-ops when analytics isn't configured.
export function track(event: string, props?: Record<string, unknown>): void {
  capture(event, props);
}
