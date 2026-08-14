"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function Footer() {
  // Footer renders on statically prerendered pages, so a bare
  // new Date().getFullYear() would freeze at build time and go stale the
  // moment the calendar rolls over without a fresh deploy. Seed with the
  // build-time year, then correct it on mount against the visitor's real
  // clock.
  //
  // alpha-drift-r30-02 (2026-08-14, self-audit): this used to seed via
  // `new Date().getFullYear()` inside the useState initializer itself, on
  // the mistaken belief that a lazy initializer freezes the server-rendered
  // value. It doesn't -- the initializer function re-runs fresh on the
  // client's OWN hydration render too, so it silently recomputed the LIVE
  // year on the client rather than reusing what the server actually baked
  // into the static HTML. The two only agreed within the same calendar
  // year, producing a real hydration mismatch right at any Dec-to-Jan
  // rollover with no fresh deploy since. NEXT_PUBLIC_BUILD_YEAR (see
  // next.config.ts) is a genuine build-time literal, identical in the
  // server-prerendered output and the client bundle -- unlike a fresh
  // Date() call, there's no live computation left in the initial render at
  // all, only in the post-mount correction below.
  const [year, setYear] = useState(() => Number(process.env.NEXT_PUBLIC_BUILD_YEAR) || new Date().getFullYear());
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
        <Link href="/privacy" className="hover:opacity-70 py-2 -my-2">Privacy</Link>
        <Link href="/terms" className="hover:opacity-70 py-2 -my-2">Terms</Link>
        <Link href="/support" className="hover:opacity-70 py-2 -my-2">Support</Link>
      </div>
    </footer>
  );
}
