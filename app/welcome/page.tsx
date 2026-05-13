"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";

export default function WelcomePage() {
  const router = useRouter();

  useEffect(() => {
    // If the visitor is already signed in (came back via magic link, or stayed
    // signed in on this device), redirect to their inbox. The hero stays
    // visible for that ~50ms — fine; the cross-fade to /inbox is gentle.
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (session) router.replace("/inbox" as never);
      } catch {
        // ignore — show the welcome page as a fallback
      }
    })();
  }, [router]);

  return (
    <StepShell stepIndex={1}>
      <div className="relative">
        <span aria-hidden className="alpha-watermark" style={{ top: "-22vmin", left: "50%", transform: "translateX(-50%)" }}>
          α
        </span>
        <div className="relative z-10 text-center space-y-10">
          <h1 className="alpha-display alpha-hero text-5xl md:text-7xl font-bold tracking-tight leading-[1.05]">
            Your weekly{" "}
            <em style={{ color: "var(--accent-ink)", fontStyle: "italic" }}>
              alpha.
            </em>
          </h1>
          <p
            className="alpha-display text-xl md:text-2xl leading-relaxed max-w-lg mx-auto"
            style={{ color: "var(--ink-soft)" }}
          >
            A personal letter on what matters to you, every Sunday.
          </p>
          <div className="pt-4">
            <Link href="/name" className="alpha-button text-base">
              Let&apos;s get to know you →
            </Link>
          </div>
          <p
            className="alpha-ui text-sm pt-4"
            style={{ color: "var(--ink-soft)" }}
          >
            Already have an account?{" "}
            <Link
              href="/signin"
              className="underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              Sign in →
            </Link>
          </p>
        </div>
      </div>
    </StepShell>
  );
}
