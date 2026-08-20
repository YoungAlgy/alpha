"use client";

import { useEffect, useState } from "react";

// Brief visual flourish on the very first /inbox arrival. Plays alongside
// the audio fanfare. Renders an oversized α that scales up + fades out,
// plus a soft caption "Your first letter." that fades in/out.
export function FirstLetterCelebration({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) return;
    // alpha-drift-r63-03 (2026-08-21, accessibility-resweep-newer-code-
    // r11): this is a full-viewport scale(0.6)->scale(1.3) animation on a
    // glyph up to ~18rem, the same shape as the app-open intro veil, which
    // already skips under reduced-motion (app/layout.tsx's INTRO_SCRIPT +
    // globals.css's alpha-intro-active media block). This component shipped
    // a month before that convention existed and was never revisited --
    // matching it here rather than leaving the one remaining large-
    // amplitude full-screen animation ungated.
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2400);
    return () => clearTimeout(t);
  }, [active]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
      aria-hidden
    >
      <div
        style={{
          background:
            "radial-gradient(circle at center, var(--paper) 0%, transparent 65%)",
          position: "absolute",
          inset: 0,
          opacity: 0.8,
          animation: "alpha-celebration-fade 2400ms ease-out forwards",
        }}
      />
      <div
        className="alpha-display"
        style={{
          fontSize: "clamp(8rem, 24vw, 18rem)",
          fontWeight: 700,
          lineHeight: 1,
          color: "var(--accent-ink)",
          animation: "alpha-celebration-mark 2400ms ease-out forwards",
        }}
      >
        α
      </div>
      <div
        className="alpha-display absolute"
        style={{
          fontSize: "1.25rem",
          fontWeight: 600,
          color: "var(--ink-soft)",
          marginTop: "16vh",
          letterSpacing: "0.04em",
          animation: "alpha-celebration-caption 2400ms ease-out forwards",
        }}
      >
        Your first letter.
      </div>
      <style>{`
        @keyframes alpha-celebration-fade {
          0%   { opacity: 0.85; }
          70%  { opacity: 0.5; }
          100% { opacity: 0; }
        }
        @keyframes alpha-celebration-mark {
          0%   { transform: scale(0.6); opacity: 0; }
          25%  { transform: scale(1.0); opacity: 1; }
          70%  { transform: scale(1.1); opacity: 0.9; }
          100% { transform: scale(1.3); opacity: 0; }
        }
        @keyframes alpha-celebration-caption {
          0%   { opacity: 0; transform: translateY(8px); }
          30%  { opacity: 1; transform: translateY(0); }
          70%  { opacity: 1; }
          100% { opacity: 0; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}
