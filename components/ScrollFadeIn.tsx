"use client";

import { useEffect, useRef, useState } from "react";

interface ScrollFadeInProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

// Wrap content in this to fade it in once it scrolls into view.
// Uses IntersectionObserver, no scroll listener overhead.
export function ScrollFadeIn({
  children,
  delay = 0,
  className,
}: ScrollFadeInProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // alpha-drift-r64-01 (2026-08-21, accessibility-resweep-newer-code-r12):
  // no prefers-reduced-motion check at all -- with the app's only
  // scroll-triggered motion wrapping every topic section of the daily
  // digest (components/Digest.tsx), it re-fired once per section as a
  // reader scrolled the core letter-reading surface.
  //
  // alpha-drift-r65-01 (2026-08-21, self-audit-r64): round 64's own fix
  // read the media query at useState-init time, which diverges between
  // SSR (window is always undefined in Node, so the server ALWAYS emits
  // shown=false) and client hydration -- on app/letter/page.tsx and
  // app/sample/page.tsx, both genuine Server Components that render
  // <Digest> synchronously with no client-side loading gate, a
  // reduced-motion visitor's first client render disagreed with the
  // server-emitted markup. React never patches a hydration mismatch in
  // production, so the mismatched props silently won and the effect's
  // early-return meant setShown was never called again -- every topic
  // section of the actual letter (the "Read the full letter" link in
  // every subscriber email) and the public /sample page stayed
  // PERMANENTLY INVISIBLE for reduced-motion readers. A cosmetic fade
  // became content-blanking for exactly the population the fix meant to
  // protect. Fixed with a CSS-only override instead (see the
  // .alpha-scroll-fade rule in globals.css) -- media queries evaluate
  // identically for SSR-emitted markup and client paint, so there is no
  // divergence regardless of which pages have a client-side loading gate.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }

    // If element is already above the fold, show without animation.
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight - 50) {
      setShown(true);
      return;
    }

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -8% 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`alpha-scroll-fade${className ? ` ${className}` : ""}`}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(12px)",
        transition: `opacity 520ms ease ${delay}ms, transform 520ms ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
