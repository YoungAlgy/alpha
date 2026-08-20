"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { isInvalidOrExpiredOtpError, isInvalidOrExpiredPkceError } from "@/lib/gotrue-errors";

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

    // Only accept a same-origin destination -- resolved through the real URL
    // parser, not a hand-rolled regex. A regex check for "doesn't start with
    // //" is an incomplete same-origin test: browsers normalize a leading
    // backslash the same as a forward slash for special schemes, so a value
    // like "/\evil.com" resolves to a cross-origin URL despite passing that
    // check. Resolving via new URL() and comparing .origin closes the gap
    // regardless of which character trick is used, right after the
    // highest-trust moment in the app: the instant after a genuine sign-in.
    const rawNext = params.get("next");
    let next = "/inbox";
    if (rawNext && typeof window !== "undefined") {
      try {
        const resolved = new URL(rawNext, window.location.origin);
        if (resolved.origin === window.location.origin) {
          next = resolved.pathname + resolved.search + resolved.hash;
        }
      } catch {
        // malformed -- keep the /inbox fallback
      }
    }
    const code = params.get("code");
    const hasHashSession =
      typeof window !== "undefined" && window.location.hash.includes("access_token=");

    // alpha-drift-r32-03 (2026-08-14): the hash-flow success path below
    // already scrubs the URL bar after a successful exchange (line ~90) --
    // the PKCE `code` param had no equivalent. On a FAILED exchange this
    // page sits on /auth/callback?code=xxx for up to 1.5s (the error
    // setTimeout below) before redirecting, during which PostHog's
    // autocapture (enabled app-wide) can attach the live $current_url --
    // code and all -- to any event it captures on this page. `code` is
    // already read into the const above, so it's safe to strip from the
    // visible URL immediately, before the exchange even starts, rather than
    // only on the specific paths that happen to redirect elsewhere after.
    if (code && typeof window !== "undefined") {
      window.history.replaceState(null, "", window.location.pathname);
    }

    // Guards every router/setState call below against firing after this
    // effect's cleanup has run (a fast successive navigation off this page) —
    // the error path's 1.5s setTimeout in particular was untracked.
    let cancelled = false;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const sb = supabaseClient();

        if (code) {
          const { error } = await sb.auth.exchangeCodeForSession(code);
          if (error) throw error;
          if (cancelled) return;
          router.replace(next as never);
          return;
        }

        if (hasHashSession) {
          // Supabase client auto-detects hash tokens on init and persists the
          // session. Wait one tick for that to settle, then verify.
          await new Promise((r) => setTimeout(r, 50));
          if (cancelled) return;
          const { data: { session } } = await sb.auth.getSession();
          if (cancelled) return;
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
        if (cancelled) return;
        // alpha-drift-r42-05 (2026-08-19): never show GoTrue's raw vendor
        // wording here either -- this is the one other place in the app a
        // raw Supabase auth SDK error could reach the UI (an expired/
        // already-used magic link, or a PKCE code-verifier mismatch from
        // opening the link in a different browser than it was requested
        // in), the same class app/signin/page.tsx already fixed in round
        // 35. Real message kept in the console for debugging.
        //
        // alpha-drift-r43-01 (2026-08-19, self-audit): the r42 fix only
        // checked isInvalidOrExpiredOtpError, whose shape was built for
        // verifyOtp's error (used by signin/page.tsx), not
        // exchangeCodeForSession's real PKCE error shapes -- so it never
        // actually matched anything this catch block sees, and the
        // friendly copy below silently never fired. Added
        // isInvalidOrExpiredPkceError (lib/gotrue-errors.ts) alongside it;
        // kept the OTP check too as defense-in-depth in case this code
        // path ever changes.
        console.warn("[auth/callback] sign-in failed:", e instanceof Error ? e.message : e);
        const shape = e && typeof e === "object" ? (e as { status?: unknown; code?: unknown; message?: unknown }) : {};
        setErr(
          isInvalidOrExpiredOtpError(shape) || isInvalidOrExpiredPkceError(shape)
            ? "That link didn't work. It may have expired or already been used. Request a new one from the sign-in page."
            : "Sign-in failed. Try again from the sign-in page."
        );
        redirectTimer = setTimeout(() => {
          if (!cancelled) router.replace("/signin" as never);
        }, 1500);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(redirectTimer);
    };
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
