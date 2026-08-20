"use client";

import { useEffect } from "react";
import Link from "next/link";

// Branded fallback for unhandled runtime errors in any route segment.
// Without this, Next renders its bare default error screen — jarring on a
// paid product. Keep it calm and give two ways out.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaces in the server/runtime logs with the digest for correlation.
    console.error("[app/error]", error?.digest, error?.message);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md space-y-8">
        <div
          className="alpha-display text-9xl md:text-[10rem] font-bold leading-none"
          style={{ color: "var(--accent-ink)", opacity: 0.85 }}
        >
          α<span style={{ color: "var(--ink-soft)" }}>!</span>
        </div>
        {/* alpha-drift-r58-03 (2026-08-20, accessibility-resweep-newer-
            code-round-6): this is a React error boundary -- it can swap
            already-rendered page content in place on a render-phase throw
            mid-session, with no browser navigation event to cue assistive
            tech, the same no-navigation content-swap this app already
            marks role="alert" on elsewhere (archive/inbox/inbox-issueId's
            loadError blocks). role="alert" alone is treated as an implicit
            assertive live region app-wide (see components/EmailChanger.tsx's
            r56-02 comment), so no separate aria-live is needed. */}
        <h1 className="alpha-display text-3xl md:text-4xl font-bold tracking-tight" role="alert">
          Something hiccuped.
        </h1>
        <p
          className="alpha-display text-lg leading-relaxed"
          style={{ color: "var(--ink-soft)" }}
        >
          A page failed to load. Almost always a transient blip. Try again, or
          head back to your inbox.
        </p>
        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
          <button type="button" onClick={() => reset()} className="alpha-button">
            Try again →
          </button>
          {/* alpha-drift-r59-05 (2026-08-20, accessibility-resweep-newer-
              code-round-7): under the WCAG 2.5.8 24px touch-target minimum
              -- caught the round after alpha-drift-r58-03 touched this
              file's h1 two lines up without catching the gap right next
              to it. */}
          <Link
            href="/inbox"
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--ink-soft)" }}
          >
            Or open your inbox
          </Link>
        </div>
      </div>
    </main>
  );
}
