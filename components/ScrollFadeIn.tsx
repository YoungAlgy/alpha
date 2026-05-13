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
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
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
