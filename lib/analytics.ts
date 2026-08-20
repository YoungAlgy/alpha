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
// alpha-drift-r49-07 (2026-08-20, docs-code-drift-round-5): this said "in
// Vercel env" -- this app hasn't run on Vercel since 2026-08-05, so there's
// no Vercel env to set it in. To activate: set NEXT_PUBLIC_POSTHOG_KEY (and
// optionally NEXT_PUBLIC_POSTHOG_HOST, defaults to PostHog US cloud) via
// .env.local for local dev and `npx wrangler secret put
// NEXT_PUBLIC_POSTHOG_KEY` for production (see docs/SECRETS.md).

let started = false;
let posthog: typeof import("posthog-js").default | null = null;
let queue: Array<() => void> = [];

// alpha-drift-r19-01 (found+fixed 2026-08-07): app/privacy/page.tsx promises
// "We don't track which individual letters you read." /inbox/[issueId]'s
// pathname literally IS that individual letter's public.issues.id (a UUID),
// and PostHog attaches the current page URL to EVERY event it sends while a
// reader is on that page — not just the manual capturePageview() call below,
// but every autocaptured click too, since posthog-js enriches $current_url/
// $pathname from window.location automatically for anything it captures.
// Patching capturePageview() alone would leave autocapture leaking the same
// UUID. sanitize_properties runs on every outgoing event regardless of how
// it was captured, so it's the one place that actually closes this for good.
const ISSUE_URL_PATTERN = /\/inbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// alpha-drift-r23-03 (found+fixed 2026-08-14): GlobalErrorListeners.tsx
// (this round) tracks "unhandled_rejection"/"uncaught_error" with the raw
// `.message` text of whatever error/rejection it catches -- by design an
// UNBOUNDED-scope catch-all (any window-level error nothing else handled),
// not a fixed set of known-safe event shapes like every other track() call
// site in this app. A live audit of every current throw site found none
// that interpolate raw user-submitted text (email, name) into a thrown
// message today, but nothing GUARANTEES a future one won't -- this is
// defense in depth for that unbounded surface, not a fix for a proven
// leak. Same email-shaped-substring scrub PostHog's own recommended PII
// scrubbing pattern uses; deliberately simple (doesn't attempt full RFC
// 5322 validation) since this only needs to catch the common case well
// enough to keep an accidental email out of an error message, not validate
// a form field.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// alpha-drift-r32-03 (2026-08-14): redactValue only ever stripped the two
// patterns above -- it had no coverage for sensitive QUERY-STRING params,
// and autocapture attaches $current_url (via posthog-js's own href-reading,
// same mechanism the $elements comment above documents) to every click it
// captures. Two live leak paths: app/writing/page.tsx reads `session_id`
// from the URL -- this app's own proof-of-payment token, used to rate-limit
// /api/generate -- and renders buttons while it's still in the URL; and
// app/auth/callback/page.tsx's PKCE `code` param (lib/supabase/client.ts
// confirms the PKCE/query-string flow is live) persists through the
// exchange. Anchored to `?`/`&`/string-start so this can't false-positive
// on a LONGER param name that merely ends in "code" or "session_id" (e.g.
// promo_code, zip_code) -- those have neither a `?`/`&` nor the string
// start immediately before the literal "code="/"session_id=".
const SESSION_ID_PARAM_PATTERN = /([?&]|^)session_id=[^&#]*/gi;
const AUTH_CODE_PARAM_PATTERN = /([?&]|^)code=[^&#]*/gi;

// alpha-drift-r20-01 (found+fixed 2026-08-13, self-audit of the fix above):
// the original version only checked `typeof value === "string"` on the
// TOP-LEVEL properties -- but PostHog's autocapture emits $elements as an
// ARRAY of element-descriptor objects for click events, each carrying the
// clicked element's real href verbatim in a nested attr__href string
// (confirmed against posthog-js's own autocapture source). A string check
// on the top level skips arrays entirely, so clicking an /archive letter
// link ($elements[0].attr__href = "/inbox/<uuid>") sent the raw issue UUID
// straight through, unredacted -- defeating the exact promise this file
// exists to keep. Recurses into arrays and plain objects (not just the
// one known-bad shape) so any OTHER nested string PostHog's SDK might
// carry a URL in is covered too, not just the one shape this round happened
// to catch.
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    let v = value.includes("/inbox/") ? value.replace(ISSUE_URL_PATTERN, "/inbox/[id]") : value;
    if (v.includes("@")) v = v.replace(EMAIL_PATTERN, "[email]");
    if (v.includes("session_id=")) v = v.replace(SESSION_ID_PARAM_PATTERN, "$1session_id=[redacted]");
    if (v.includes("code=")) v = v.replace(AUTH_CODE_PARAM_PATTERN, "$1code=[redacted]");
    return v;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Exported for scripts/verify-analytics-redaction.mts only.
export function redactIssueIds<T extends Record<string, unknown>>(properties: T): T {
  for (const key of Object.keys(properties)) {
    (properties as Record<string, unknown>)[key] = redactValue(properties[key]);
  }
  return properties;
}

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
      sanitize_properties: (properties) => redactIssueIds(properties),
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
