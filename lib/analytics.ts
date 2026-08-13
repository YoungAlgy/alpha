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
  }).catch((e) => {
    // alpha-drift-r16-08 (found+fixed 2026-08-07): `started` was set to
    // true BEFORE this import settled, with no .catch() at all -- a failed
    // chunk load (network blip, an ad blocker that blocklists posthog-js by
    // name, or a stale chunk hash after a deploy) left `started` permanently
    // true while `posthog` stayed null forever, so every future track()/
    // capturePageview() call for the rest of this page's life silently hit
    // the `if (!started) return` fast-path's SIBLING branch (queue up to 20
    // pending events that would never flush), indistinguishable from
    // analytics working normally -- no error, no console signal, just a
    // session (or every session, for a persistent condition like a proxy)
    // with zero analytics data. Reset `started` on failure so the NEXT
    // PostHogProvider mount/navigation (which calls initAnalytics() again)
    // gets a real retry instead of being permanently locked out by the
    // first failed attempt, and log it so a persistent failure is at least
    // visible in the console instead of silent.
    console.warn("[analytics] posthog-js failed to load, will retry on next navigation:", e);
    started = false;
    posthog = null;
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
  // alpha-drift-r16-09 (found+fixed 2026-08-07): $current_url was set to
  // the bare pathname (e.g. "/checkout") instead of a full absolute URL --
  // PostHog's documented Next.js App Router pattern builds this as
  // `window.origin + pathname` specifically because $current_url is
  // expected to be a full URL: the Web Analytics dashboard, the Paths
  // insight, and session-recording/toolbar URL correlation all key off it.
  // Every OTHER event this app fires (autocapture clicks, checkout_started,
  // etc.) never overrides $current_url and gets the SDK's own correctly-
  // computed full URL automatically -- this was the one capture site
  // clobbering it with a broken value, undermining the exact
  // "measurable step by step" purpose PostHogProvider's own comment states.
  const url = typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
  capture("$pageview", { $current_url: url });
}

// Money-moment events. Safe no-ops when analytics isn't configured.
export function track(event: string, props?: Record<string, unknown>): void {
  capture(event, props);
}
