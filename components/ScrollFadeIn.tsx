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
  // this used to always start at false and animate in via the effect below
  // -- with no prefers-reduced-motion check anywhere, wrapping every topic
  // section of the daily digest (components/Digest.tsx), it was the app's
  // only scroll-triggered motion, re-firing once per section as a reader
  // scrolled the core letter-reading surface. Reading the media query at
  // useState-init time (not inside the effect, which runs after first
  // paint) means a reduced-motion reader's `shown` is already true on the
  // very first render -- opacity/transform never change, so the attached
  // CSS transition never actually plays (a JS gate added only inside the
  // effect would still animate once, since the pre-effect paint already
  // committed the opacity:0 starting state).
  const prefersReducedMotion =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (prefersReducedMotion) return;
    const el = ref.current;
    if (!el) return;

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
      className={className}
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
