"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";

// Handles the magic-link callback for BOTH Supabase flow types:
//   - PKCE flow: `?code=xxx` in the query — exchangeCodeForSession
//   - Implicit flow: `#access_token=...&refresh_token=...` in the URL hash —
//     Supabase client auto-detects + setSession at load
//
// We have to render a client component (not a server route handler) because
// the URL hash is browser-only — server-side handlers never see it. The
// auto-detect on first supabaseClient() call in this page is what picks up
// the implicit-flow tokens and sets the cookie.
//
// When successful we router.replace to `next` (default /inbox).
// When neither code nor hash is present we fall back to /signin.
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackShell message="Signing you in…" />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured()) {
      router.replace("/signin" as never);
      return;
    }

    const next = params.get("next") || "/inbox";
    const code = params.get("code");
    const hasHashSession =
      typeof window !== "undefined" && window.location.hash.includes("access_token=");

    (async () => {
      try {
        const sb = supabaseClient();

        if (code) {
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) throw error;
          router.replace(next as never);
          return;
        }

        if (hasHashSession) {
          // Supabase client auto-detects hash tokens on init and persists the
          // session. Wait one tick for that to settle, then verify.
          await new Promise((r) => setTimeout(r, 50));
          const { data: { session } } = await sb.auth.getSession();
          if (session) {
            // Strip the hash so it doesn't linger in the URL bar
            if (typeof window !== "undefined") {
              window.history.replaceState(null, "", window.location.pathname);
            }
            router.replace(next as never);
            return;
          }
        }

        // Neither path produced a session
        router.replace("/signin?error=no_session" as never);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Sign-in failed");
        setTimeout(() => router.replace("/signin" as never), 1500);
      }
    })();
  }, [router, params]);

  return <CallbackShell message={err || "Signing you in…"} />;
}

function CallbackShell({ message }: { message: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center">
        <div
          className="alpha-display text-5xl mb-4"
          style={{ color: "var(--accent-ink)", opacity: 0.8 }}
        >
          α
        </div>
        <p
          className="alpha-display text-lg"
          style={{ color: "var(--ink-soft)" }}
        >
          {message}
        </p>
      </div>
    </main>
  );
}
