"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding, nextStep, type OnboardingState } from "@/lib/onboarding-state";

interface QuestionStepProps {
  field: keyof OnboardingState;
  question: string;
  helper?: string;
  placeholder?: string;
  multiline?: boolean;
  optional?: boolean;
  currentPath: string;
  required?: boolean;
}

export function QuestionStep({
  field,
  question,
  helper,
  placeholder,
  multiline = false,
  optional = false,
  currentPath,
}: QuestionStepProps) {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();
  const initial = (state[field] as string) || "";
  const [value, setValue] = useState<string>(initial);

  useEffect(() => {
    if (loaded) setValue((state[field] as string) || "");
  }, [loaded, field, state]);

  const trimmed = value.trim();
  const canContinue = optional || trimmed.length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canContinue) return;
    update({ [field]: trimmed || undefined } as Partial<OnboardingState>);
    router.push(`/${nextStep(currentPath)}` as never);
  }

  function skip() {
    update({ [field]: undefined } as Partial<OnboardingState>);
    router.push(`/${nextStep(currentPath)}` as never);
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
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
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={4}
          className="w-full alpha-display text-2xl md:text-3xl bg-transparent border-b py-3 focus:outline-none focus:border-current placeholder:opacity-40 resize-none"
          style={{
            color: "var(--ink)",
            borderColor: "var(--rule)",
          }}
        />
      ) : (
        <input
          autoFocus
          type={field === "email" ? "email" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="w-full alpha-display text-3xl md:text-4xl bg-transparent border-b py-3 focus:outline-none focus:border-current placeholder:opacity-40"
          style={{
            color: "var(--ink)",
            borderColor: "var(--rule)",
          }}
        />
      )}
      <div className="flex items-center gap-6 pt-2">
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
    </form>
  );
}
