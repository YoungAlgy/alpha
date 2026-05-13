"use client";

import { useEffect, useState } from "react";
import { TOPIC_BY_ID } from "@/lib/topics";
import type { Issue } from "@/lib/types";

interface LetterTOCProps {
  issue: Issue;
}

// Sticky left-side table of contents for the letter, desktop-only.
// Highlights the section currently in view.
export function LetterTOC({ issue }: LetterTOCProps) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    function onScroll() {
      let pick: string | null = null;
      for (const s of issue.sections) {
        const el = document.getElementById(`s-${s.topicId}`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.35) {
          pick = s.topicId;
        }
      }
      setActive(pick);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [issue]);

  function jump(topicId: string) {
    const el = document.getElementById(`s-${topicId}`);
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
        {issue.sections.map((s) => {
          const meta = TOPIC_BY_ID[s.topicId];
          const isActive = active === s.topicId;
          return (
            <li key={s.topicId}>
              <button
                type="button"
                onClick={() => jump(s.topicId)}
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
                {meta?.emoji && <span aria-hidden style={{ opacity: 0.85 }}>{meta.emoji}</span>}
                <span>{s.topicLabel}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
