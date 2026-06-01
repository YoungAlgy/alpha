"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { initAnalytics, capturePageview } from "@/lib/analytics";

// Mounts once in the root layout. Initializes PostHog (inert without a key)
// and captures a pageview on every App Router navigation, so the onboarding
// funnel drop-off is measurable step by step. Uses usePathname only (no
// useSearchParams) so it needs no Suspense boundary.
export function PostHogProvider() {
  const pathname = usePathname();

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    if (!pathname) return;
    // basePath is /alpha; pathname here is the in-app path (e.g. /welcome).
    capturePageview(`/alpha${pathname === "/" ? "" : pathname}`);
  }, [pathname]);

  return null;
}
