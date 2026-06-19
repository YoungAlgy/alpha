"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding, nextStep, type OnboardingState } from "@/lib/onboarding-state";
import { confirm as audioConfirm, tap } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";

interface QuestionStepProps {
  field: keyof OnboardingState;
  question: string;
  helper?: string;
  placeholder?: string;
  multiline?: boolean;
  optional?: boolean;
  currentPath: string;
  /** Optional format check (e.g. email). Returns an error message to show
   *  inline and block advancing, or null when the value looks good. The
   *  browser's native type="email" is too lax for the money path (it accepts
   *  "john@gmail"), so the email step passes a real validator here. */
  validate?: (value: string) => string | null;
}

export function QuestionStep({
  field,
  question,
  helper,
  placeholder,
  multiline = false,
  optional = false,
  currentPath,
  validate,
}: QuestionStepProps) {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();
  const initial = (state[field] as string) || "";
  const [value, setValue] = useState<string>(initial);
  const [error, setError] = useState<string | null>(null);

  // These are NEW-USER onboarding steps only (editing lives in /settings). A
  // signed-in reader who deep-links here, or a returning subscriber on a fresh
  // device, would otherwise see a blank form and could re-save stale values —
  // bounce them to their inbox, mirroring the welcome page's guard.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const { data: { session } } = await supabaseClient().auth.getSession();
        if (session) router.replace("/inbox" as never);
      } catch {
        // ignore — show the step as a fallback
      }
    })();
  }, [router]);

  useEffect(() => {
    if (loaded) setValue((state[field] as string) || "");
  }, [loaded, field, state]);

  const trimmed = value.trim();
  const canContinue = optional || trimmed.length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canContinue) return;
    // Format gate (e.g. email): block advancing on a likely typo and show it
    // inline here, rather than letting a bad address reach Stripe / the send.
    if (validate) {
      const msg = validate(trimmed);
      if (msg) {
        setError(msg);
        return;
      }
    }
    setError(null);
    audioConfirm();
    update({ [field]: trimmed || undefined } as Partial<OnboardingState>);
    router.push(`/${nextStep(currentPath)}` as never);
  }

  const [skipping, setSkipping] = useState(false);

  function skip() {
    tap();
    setSkipping(true);
    setTimeout(() => {
      update({ [field]: undefined } as Partial<OnboardingState>);
      router.push(`/${nextStep(currentPath)}` as never);
    }, 280);
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-8"
      style={{
        opacity: skipping ? 0 : 1,
        transform: skipping ? "translateY(-6px)" : "translateY(0)",
        transition: "opacity 240ms ease, transform 240ms ease",
      }}
    >
      <h1
        id="alpha-question"
        className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight"
      >
        {question}
      </h1>
      {helper && (
        <p
          className="alpha-ui text-sm md:text-base leading-relaxed"
          style={{ color: "var(--ink-soft)" }}
        >
          {helper}
        </p>
      )}
      {multiline ? (
        <textarea
          autoFocus
          aria-labelledby="alpha-question"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder={placeholder}
          rows={4}
          className="w-full alpha-display text-2xl md:text-3xl bg-transparent border-b pt-3 pb-5 focus:outline-none focus:border-current placeholder:opacity-40 resize-none"
          style={{
            color: "var(--ink)",
            borderColor: "var(--rule)",
            lineHeight: 1.35,
          }}
        />
      ) : (
        <input
          autoFocus
          aria-labelledby="alpha-question"
          type={field === "email" ? "email" : "text"}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder={placeholder}
          className="w-full alpha-display text-3xl md:text-4xl bg-transparent border-b pt-3 pb-5 focus:outline-none focus:border-current placeholder:opacity-40"
          style={{
            color: "var(--ink)",
            borderColor: "var(--rule)",
            lineHeight: 1.35,
          }}
        />
      )}
      {error && (
        <p
          role="alert"
          aria-live="assertive"
          className="alpha-ui text-sm"
          style={{ color: "var(--accent-ink)" }}
        >
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-6 pt-2">
        <div className="flex items-center gap-6">
          <button
            type="submit"
            disabled={!canContinue}
            className="alpha-button"
            style={{
              opacity: canContinue ? 1 : 0.3,
              cursor: canContinue ? "pointer" : "not-allowed",
            }}
          >
            Continue →
          </button>
          {optional && (
            <button
              type="button"
              onClick={skip}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Skip
            </button>
          )}
        </div>
        {canContinue && !multiline && (
          <span className="alpha-kbd-hint hidden md:inline-flex" aria-hidden>
            <span className="alpha-kbd">↵</span> to continue
          </span>
        )}
      </div>
    </form>
  );
}
