"use client";

import { useEffect } from "react";

// alpha-drift-r22-01 (found+fixed 2026-08-14): registers public/sw.js — see
// that file's own header comment for why it's deliberately a non-caching,
// navigation-only offline fallback rather than a real caching service
// worker. Mounted once, app-wide, mirroring ThemeApplier's pattern.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Best-effort — an install-time failure (unsupported browser,
      // disabled in a privacy mode) just means no offline fallback page;
      // the app itself works identically either way.
    });
  }, []);

  return null;
}
