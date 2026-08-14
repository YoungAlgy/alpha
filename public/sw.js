// alpha-drift-r22-01 (found+fixed 2026-08-14): manifest.json declares
// display:"standalone" (an installable app) and InstallPrompt.tsx actively
// invites readers to add it to their home screen, but no service worker
// existed anywhere to back that up -- a standalone-mode PWA with a flaky
// connection just showed the platform's bare, unbranded network-error page,
// which reads especially broken inside what's supposed to feel like a
// native app (no browser chrome to explain what happened).
//
// Deliberately NOT a caching service worker. This app's whole value
// proposition is a genuinely fresh letter every day -- a cache-first or
// stale-while-revalidate strategy risks silently serving yesterday's issue,
// a stale topic list, or a stale paid-access state over a real network
// response. So this SW caches exactly ONE thing (offline.html, at install
// time, never re-fetched) and otherwise gets out of the way completely:
// every request this SW doesn't explicitly intercept below falls straight
// through to the network with no caching layer at all, identical to having
// no service worker.
const OFFLINE_URL = "/offline.html";
const CACHE_NAME = "alpha-offline-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Drop any cache from a prior CACHE_NAME (a future offline.html content
  // change bumps the version) -- this SW never accumulates more than the
  // one entry it's meant to hold.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only ever intercept top-level page navigations (a reader opening or
  // reloading a page). Every other request -- API calls, JS/CSS bundles,
  // images, fonts -- is left completely untouched, so this SW can never
  // affect the freshness or correctness of app data, only the html shell of
  // a failed page load.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(() =>
      caches.open(CACHE_NAME).then((cache) => cache.match(OFFLINE_URL))
    )
  );
});
