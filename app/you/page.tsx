"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding, nextStep } from "@/lib/onboarding-state";
import { confirm as audioConfirm, tap } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { generationLabel, generationOf, zodiacLabel, zodiacSign } from "@/lib/demographics";
import type { Gender } from "@/lib/types";

const GENDERS: { value: Gender; label: string }[] = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
];

export default function YouPage() {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();
  const [birthday, setBirthday] = useState("");
  // null = unset; "skip" = chose "prefer not to say"; else a Gender.
  const [gender, setGender] = useState<Gender | "skip" | null>(null);

  useEffect(() => {
    if (!loaded) return;
    if (state.birthday) setBirthday(state.birthday);
    if (state.gender) setGender(state.gender);
  }, [loaded, state.birthday, state.gender]);

  // New-user onboarding only. A signed-in reader (or a returning one on a fresh
  // device) gets bounced to their inbox instead of re-running onboarding.
  // Mirrors the QuestionStep guard.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const { data: { session } } = await supabaseClient().auth.getSession();
        if (session) router.replace("/inbox" as never);
      } catch {
        // ignore — show the step
      }
    })();
  }, [router]);

  // Picking the Zodiac topic requires a birthday (we can't read a sign without
  // it). The topics step comes before this one, so the choice is already made.
  const zodiacPicked = (state.topics ?? []).includes("zodiac");
  const canContinue = !zodiacPicked || birthday.length > 0;

  function submit() {
    if (!canContinue) return;
    audioConfirm();
    update({
      birthday: birthday || undefined,
      gender: gender === "male" || gender === "female" ? gender : undefined,
    });
    router.push(`/${nextStep("you")}` as never);
  }

  const gen = generationOf(birthday);
  const sign = zodiacSign(birthday);

  return (
    <StepShell stepIndex={9} prevPath="fun">
      <div className="space-y-8">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            A couple things about you.
          </h1>
          <p className="alpha-ui text-sm md:text-base" style={{ color: "var(--ink-soft)" }}>
            This tunes the letter so it reads like it was written for you. Both are
            optional, and never shared.
          </p>
        </div>

        <div>
          <label htmlFor="alpha-birthday" className="alpha-ui text-sm block mb-2" style={{ color: "var(--ink-soft)" }}>
            Your birthday
          </label>
          <input
            id="alpha-birthday"
            type="date"
            value={birthday}
            min="1920-01-01"
            max="2014-12-31"
            onChange={(e) => setBirthday(e.target.value)}
            className="alpha-display text-2xl md:text-3xl bg-transparent border-b pt-2 pb-3 focus:outline-none focus:border-current"
            style={{ color: "var(--ink)", borderColor: "var(--rule)", colorScheme: "light" }}
          />
          <p className="alpha-ui text-xs mt-2" style={{ color: zodiacPicked && !birthday ? "var(--accent-ink)" : "var(--ink-soft)" }}>
            {zodiacPicked && !birthday
              ? "You picked Zodiac, so add your birthday and we'll read your sign each week."
              : sign && gen
                ? `${generationLabel(gen)}, ${zodiacLabel(sign)}. The full date also unlocks the Zodiac topic if you want it.`
                : "The full date tunes the letter to your generation and unlocks the Zodiac topic if you want it."}
          </p>
        </div>

        <div>
          <span className="alpha-ui text-sm block mb-2" style={{ color: "var(--ink-soft)" }}>
            Gender
          </span>
          <div className="flex flex-wrap gap-2">
            {GENDERS.map((g) => {
              const active = gender === g.value;
              return (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => { setGender(active ? null : g.value); tap(); }}
                  className="alpha-ui text-sm px-4 py-2 rounded-full border transition"
                  style={{
                    borderColor: active ? "var(--accent)" : "var(--rule)",
                    background: active ? "var(--callout-bg)" : "transparent",
                    color: active ? "var(--accent-ink)" : "var(--ink)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {g.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => { setGender(gender === "skip" ? null : "skip"); tap(); }}
              className="alpha-ui text-sm px-4 py-2 rounded-full border transition"
              style={{
                borderColor: gender === "skip" ? "var(--accent)" : "var(--rule)",
                background: gender === "skip" ? "var(--callout-bg)" : "transparent",
                color: gender === "skip" ? "var(--accent-ink)" : "var(--ink-soft)",
              }}
            >
              Prefer not to say
            </button>
          </div>
        </div>

        <div className="flex items-center gap-6 pt-2">
          <button
            type="button"
            onClick={submit}
            disabled={!canContinue}
            className="alpha-button"
            style={{ opacity: canContinue ? 1 : 0.4, cursor: canContinue ? "pointer" : "not-allowed" }}
          >
            Continue →
          </button>
          {!zodiacPicked && (
            <button
              type="button"
              onClick={() => { tap(); router.push(`/${nextStep("you")}` as never); }}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Skip
            </button>
          )}
        </div>
      </div>
    </StepShell>
  );
}
