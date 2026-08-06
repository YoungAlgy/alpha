"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function Footer() {
  // Footer renders on statically prerendered pages, so a bare
  // new Date().getFullYear() would freeze at build time and go stale the
  // moment the calendar rolls over without a fresh deploy. Seed with the
  // build-time year (same value as before, so there's no first-paint flash),
  // then correct it on mount against the visitor's real clock.
  const [year, setYear] = useState(() => new Date().getFullYear());
  useEffect(() => {
    setYear(new Date().getFullYear());
  }, []);

  return (
    <footer
      className="px-6 py-10 max-w-5xl mx-auto w-full flex flex-col md:flex-row items-center justify-between gap-3 border-t"
      style={{ borderColor: "var(--rule)" }}
    >
      <div
        className="alpha-mono"
        style={{ color: "var(--ink-soft)" }}
      >
        <Wordmark /> · {year}
      </div>
      <div className="flex gap-6 alpha-ui text-xs" style={{ color: "var(--ink-soft)" }}>
        <Link href="/privacy" className="hover:opacity-70">Privacy</Link>
        <Link href="/terms" className="hover:opacity-70">Terms</Link>
        <Link href="/support" className="hover:opacity-70">Support</Link>
      </div>
    </footer>
  );
}
