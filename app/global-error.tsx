"use client";

import { useEffect } from "react";

// Root-level error boundary. error.tsx only wraps each route segment's
// {children} -- it never covers app/layout.tsx itself, so a synchronous
// render throw in RootLayout (a provider, an inline script, a font variable)
// has zero recovery UI without this file. This one REPLACES the entire root
// layout when it triggers (Next's own requirement), so it renders its own
// <html>/<body> and deliberately avoids importing ThemeApplier, next/font
// variables, or globals.css theme tokens -- those are exactly the kind of
// thing that might be what failed. Plain inline styles only.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaces in the server/runtime logs with the digest for correlation,
    // same as app/error.tsx.
    console.error("[app/global-error]", error?.digest, error?.message);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          fontFamily: "Georgia, serif",
          background: "#F4EFE0",
          color: "#1F3D2E",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div style={{ fontSize: "5rem", fontWeight: 700, lineHeight: 1, marginBottom: 16, opacity: 0.85 }}>
            α!
          </div>
          {/* alpha-drift-r58-03 (2026-08-20, accessibility-resweep-newer-
              code-round-6): same role="alert" fix as app/error.tsx's
              sibling heading -- a bare HTML attribute, doesn't touch the
              ThemeApplier/font/CSS-token systems this file deliberately
              avoids importing (see the file-header comment). */}
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: "0 0 16px" }} role="alert">
            Something hiccuped.
          </h1>
          <p style={{ fontSize: "1.05rem", lineHeight: 1.6, margin: "0 0 24px", opacity: 0.75 }}>
            The page failed to load. Almost always a transient blip.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              display: "inline-block",
              background: "#1F3D2E",
              color: "#F4EFE0",
              border: "none",
              padding: "12px 24px",
              borderRadius: 6,
              fontFamily: "system-ui, sans-serif",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
