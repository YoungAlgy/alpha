"use client";

import { useEffect, useState } from "react";

export function ReadingProgress() {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    function onScroll() {
      const doc = document.documentElement;
      const total = doc.scrollHeight - doc.clientHeight;
      const value = total > 0 ? Math.min(100, Math.max(0, (window.scrollY / total) * 100)) : 0;
      setPct(value);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div
      aria-hidden
      className="fixed top-0 left-0 right-0 z-50 pointer-events-none"
      style={{ height: 2, background: "transparent" }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "var(--accent)",
          transition: "width 80ms linear",
        }}
      />
    </div>
  );
}
