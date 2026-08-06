"use client";

import { useEffect, useState } from "react";
import { topicEmoji, topicAnchor } from "@/lib/topics";
import type { Issue } from "@/lib/types";

interface LetterTOCProps {
  issue: Issue;
}

// Sticky left-side table of contents for the letter, desktop-only.
// Highlights the section currently in view.
export function LetterTOC({ issue }: LetterTOCProps) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    function computeActive() {
      let pick: string | null = null;
      issue.sections.forEach((s, i) => {
        const el = document.getElementById(topicAnchor(s.topicId, i));
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.35) {
          pick = s.topicId;
        }
      });
      setActive(pick);
    }
    // Native scroll events can fire many times per frame; the loop above does a
    // getBoundingClientRect() per section, so run it at most once per animation
    // frame instead of on every event to avoid layout thrashing while scrolling.
    let ticking = false;
    let rafId: number | undefined;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      rafId = requestAnimationFrame(() => {
        computeActive();
        ticking = false;
      });
    }
    computeActive();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [issue]);

  function jump(topicId: string, index: number) {
    const el = document.getElementById(topicAnchor(topicId, index));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <aside
      className="hidden xl:block fixed top-1/2 -translate-y-1/2 z-30"
      style={{ left: "max(2.5rem, calc((100vw - 1280px) / 2 - 40px))" }}
      aria-label="Letter sections"
    >
      <div className="alpha-mono mb-3" style={{ color: "var(--ink-soft)" }}>
        SECTIONS
      </div>
      <ul className="space-y-2">
        {issue.sections.map((s, i) => {
          const emoji = topicEmoji(s.topicId);
          const isActive = active === s.topicId;
          return (
            <li key={s.topicId}>
              <button
                type="button"
                onClick={() => jump(s.topicId, i)}
                className="alpha-ui text-left flex items-center gap-2 text-sm hover:opacity-70"
                style={{
                  color: isActive ? "var(--ink)" : "var(--ink-soft)",
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: 14,
                    height: 1,
                    background: isActive ? "var(--accent)" : "var(--rule)",
                    transition: "width 200ms ease, background 200ms ease",
                  }}
                />
                {emoji && <span aria-hidden style={{ opacity: 0.85 }}>{emoji}</span>}
                <span>{s.topicLabel}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
