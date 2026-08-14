"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

// alpha-drift-r22-01 (found+fixed 2026-08-14): app/error.tsx and
// app/global-error.tsx only catch errors thrown during REACT'S RENDER
// phase, in either scope they cover. Neither ever sees:
//   - an error thrown inside an event handler (React's synthetic event
//     system does NOT route these through error boundaries at all -- they
//     become genuinely uncaught, reaching window.onerror only)
//   - an unhandled promise rejection anywhere (an async function or .then()
//     chain whose rejection nothing awaits/catches) -- these fire
//     window.onunhandledrejection, which nothing in this app listened for
//   - a chunk-load failure specifically: a dynamic import() (Next's own
//     route-segment code-splitting, or any lazy-loaded component) rejecting
//     because the client is still running a stale bundle after a new
//     deploy replaced the chunk it's asking for. This is the single most
//     common real-world cause of both errors above on a Next.js app that
//     deploys somewhat often, and unlike a real bug it self-resolves with a
//     fresh page load (which fetches the current chunk manifest) -- worth
//     handling automatically rather than showing the reader an error page.
//
// This is intentionally NOT a replacement for error.tsx/global-error.tsx --
// mounted app-wide alongside them (root layout), same as ThemeApplier and
// ServiceWorkerRegister.
const RELOAD_ATTEMPTED_KEY = "alpha-chunk-reload-attempted";

function isChunkLoadFailure(reason: unknown): boolean {
  const name = reason instanceof Error ? reason.name : "";
  const message = reason instanceof Error ? reason.message : String(reason);
  return (
    name === "ChunkLoadError" ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}

export function GlobalErrorListeners() {
  useEffect(() => {
    function handleRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      if (isChunkLoadFailure(reason)) {
        // One automatic reload per tab session -- guarded via sessionStorage
        // so a genuinely offline/broken connection can't loop forever; a
        // second failure after the reload logs instead of retrying again.
        if (!sessionStorage.getItem(RELOAD_ATTEMPTED_KEY)) {
          sessionStorage.setItem(RELOAD_ATTEMPTED_KEY, "1");
          console.warn("[global-error] chunk load failed, reloading once:", reason);
          window.location.reload();
        } else {
          console.error("[global-error] chunk load failed again after a reload -- not retrying:", reason);
          track("chunk_load_error_persisted");
        }
        return;
      }
      console.error("[global-error] unhandled promise rejection:", reason);
      track("unhandled_rejection", {
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }

    function handleError(event: ErrorEvent) {
      console.error("[global-error] uncaught error:", event.error ?? event.message);
      track("uncaught_error", { message: event.message });
    }

    window.addEventListener("unhandledrejection", handleRejection);
    window.addEventListener("error", handleError);
    return () => {
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("error", handleError);
    };
  }, []);

  return null;
}
