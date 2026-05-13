"use client";

import Link from "next/link";
import { useState, useEffect, FormEvent, useRef } from "react";
import { useRouter } from "next/navigation";
import { Footer } from "@/components/Footer";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { confirm as audioConfirm } from "@/lib/audio";

const REMEMBERED_EMAIL_KEY = "alpha-signin-email";

type Step = "email" | "code";

export default function SigninPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Pre-fill remembered email + onboarding email
  useEffect(() => {
    try {
      const remembered = localStorage.getItem(REMEMBERED_EMAIL_KEY);
      if (remembered) {
        setEmail(remembered);
        return;
      }
      const onboarding = localStorage.getItem("alpha-onboarding");
      if (onboarding) {
        const parsed = JSON.parse(onboarding) as { email?: string };
        if (parsed.email) setEmail(parsed.email);
      }
    } catch {
      // ignore
    }
  }, []);

  // If a Supabase session is already active (e.g., implicit-flow magic link
  // tokens landed in the URL hash and the client picked them up), skip the
  // sign-in form and go straight to /inbox.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        // Tiny delay so the client's auto-detectSessionInUrl has a chance to run.
        await new Promise((r) => setTimeout(r, 80));
        const { data: { session } } = await sb.auth.getSession();
        if (session) {
          if (typeof window !== "undefined" && window.location.hash) {
            window.history.replaceState(null, "", window.location.pathname);
          }
          router.replace("/inbox" as never);
        }
      } catch {
        // ignore — stay on signin form
      }
    })();
  }, [router]);

  // Auto-focus the code input when we land on step 2
  useEffect(() => {
    if (step === "code") codeInputRef.current?.focus();
  }, [step]);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    setErr(null);

    if (!supabaseConfigured()) {
      // V0 stub path
      setTimeout(() => {
        audioConfirm();
        setStep("code");
        setBusy(false);
      }, 400);
      return;
    }

    try {
      const sb = supabaseClient();
      const { error } = await sb.auth.signInWithOtp({
        email: addr,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
      try {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, addr);
      } catch {
        // ignore
      }
      audioConfirm();
      setStep("code");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't send the code. Try again?");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e?: FormEvent) {
    e?.preventDefault();
    const token = code.replace(/\D/g, "").trim();
    if (token.length < 6) {
      setErr("Code is 6 digits.");
      return;
    }
    setBusy(true);
    setErr(null);

    try {
      const sb = supabaseClient();
      const { error } = await sb.auth.verifyOtp({
        email: email.trim(),
        token,
        type: "email",
      });
      if (error) throw error;
      audioConfirm();
      router.push("/inbox" as never);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That code didn't work. Try again.");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-3xl mx-auto w-full">
        <Link
          href="/welcome"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
      </nav>

      <section className="flex-1 flex items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md text-center">
          {step === "email" ? (
            <>
              <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-3">
                Welcome back.
              </h1>
              <p
                className="alpha-display text-lg mb-10"
                style={{ color: "var(--ink-soft)" }}
              >
                We&apos;ll email you a 6-digit code.
              </p>
              <form onSubmit={sendCode} className="space-y-5">
                <input
                  autoFocus
                  type="email"
                  required
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={busy}
                  className="w-full text-center alpha-display text-2xl bg-transparent border-b py-3 focus:outline-none placeholder:opacity-40"
                  style={{ color: "var(--ink)", borderColor: "var(--rule)", lineHeight: 1.35 }}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="alpha-button"
                  style={{ opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? "Sending…" : "Email me a code →"}
                </button>
              </form>
              {err && (
                <p
                  className="alpha-ui text-sm mt-6"
                  style={{ color: "var(--accent-ink)" }}
                >
                  {err}
                </p>
              )}
              <p
                className="alpha-ui text-sm mt-12"
                style={{ color: "var(--ink-soft)" }}
              >
                New here?{" "}
                <Link
                  href="/welcome"
                  className="underline underline-offset-4"
                  style={{ color: "var(--accent-ink)" }}
                >
                  Start fresh →
                </Link>
              </p>
            </>
          ) : (
            <>
              <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-3">
                Check your email.
              </h1>
              <p
                className="alpha-display text-lg mb-10"
                style={{ color: "var(--ink-soft)" }}
              >
                We sent a 6-digit code to <strong>{email}</strong>.
              </p>
              <form onSubmit={verifyCode} className="space-y-5">
                <input
                  ref={codeInputRef}
                  type="text"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="\d{6}"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  disabled={busy}
                  className="w-full text-center alpha-display text-4xl md:text-5xl tracking-[0.4em] bg-transparent border-b py-3 focus:outline-none placeholder:opacity-30 font-bold"
                  style={{ color: "var(--ink)", borderColor: "var(--rule)", lineHeight: 1.35 }}
                />
                <button
                  type="submit"
                  disabled={busy || code.length < 6}
                  className="alpha-button"
                  style={{ opacity: busy || code.length < 6 ? 0.5 : 1 }}
                >
                  {busy ? "Signing in…" : "Sign in →"}
                </button>
              </form>
              {err && (
                <p
                  className="alpha-ui text-sm mt-6"
                  style={{ color: "var(--accent-ink)" }}
                >
                  {err}
                </p>
              )}
              <div
                className="alpha-ui text-sm mt-12 space-x-4"
                style={{ color: "var(--ink-soft)" }}
              >
                <button
                  type="button"
                  onClick={() => sendCode()}
                  disabled={busy}
                  className="underline underline-offset-4"
                  style={{ color: "var(--accent-ink)" }}
                >
                  Resend code
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setErr(null);
                  }}
                  className="underline underline-offset-4"
                >
                  Use different email
                </button>
              </div>
            </>
          )}
        </div>
      </section>
      <Footer />
    </main>
  );
}
