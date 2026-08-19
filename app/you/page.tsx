"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding, nextStep } from "@/lib/onboarding-state";
import { confirm as audioConfirm, tap } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { coerceGender, demographicSummary, maxBirthdayForMinAge, parseBirthday } from "@/lib/demographics";
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

  // alpha-drift-r36-11 (2026-08-14): this page's own comment above claimed
  // to mirror "the QuestionStep guard," but only ported the SESSION half --
  // components/onboarding/QuestionStep.tsx's real guard is two checks (an
  // active session bounces to /inbox, a missing firstName bounces to
  // /welcome), and this page never had the second one. A visitor who reaches
  // /you directly (bookmark, shared link, back-button history) with a
  // completely empty alpha-onboarding state could save a birthday/gender
  // into state already known to be incomplete -- only caught by the NEXT
  // step downstream, by which point real personal data was already written.
  useEffect(() => {
    if (loaded && !state.firstName) router.replace("/welcome" as never);
  }, [loaded, state.firstName, router]);

  // Picking the Zodiac topic requires a birthday (we can't read a sign without
  // it). The topics step comes before this one, so the choice is already made.
  const zodiacPicked = (state.topics ?? []).includes("zodiac");
  // alpha-drift-r22-04 (found+fixed 2026-08-14): this used to only check
  // birthday.length > 0 -- never that it was a real, valid date. A native
  // <input type="date">'s min/max attributes are validity-STYLING only; they
  // don't block .value from holding an out-of-range date typed via keyboard
  // (e.g. a year before 1900, or under the site's own minimum-age floor).
  // That let onboarding hand a malformed birthday to /api/generate, which
  // validates for real via this SAME parseBirthday and rejects it with a
  // deterministic 400 -- but only after Stripe already charged the card, and
  // before the reader is ever signed in (sign-in happens inside a successful
  // generate call), leaving a paid customer with no session and no way to
  // fix the value themselves. Gating Continue on the identical rule the
  // server enforces means this can no longer happen through normal use.
  const birthdayValid = birthday.length === 0 || parseBirthday(birthday) !== null;
  const canContinue = (!zodiacPicked || birthday.length > 0) && birthdayValid;

  function submit() {
    if (!canContinue) return;
    audioConfirm();
    update({
      birthday: birthday || undefined,
      gender: coerceGender(gender) ?? undefined,
    });
    router.push(`/${nextStep("you")}` as never);
  }

  // alpha-drift-r22-06 (found+fixed 2026-08-14): Skip used to just navigate
  // away with no update() call at all -- so a reader who typed a birthday
  // and/or picked a gender, then clicked Skip instead of Continue (maybe
  // just muscle memory, or they didn't realize Continue was already
  // enabled), lost everything they'd just entered. Skip is only ever
  // rendered when !zodiacPicked, i.e. these fields are genuinely optional
  // here, so there's no reason to throw away a valid answer just because
  // the reader chose the "I don't need to finish this" button rather than
  // "Continue". Saves gender unconditionally (coerceGender can't produce a
  // malformed value) and birthday only if it's actually valid -- an
  // in-progress, not-yet-valid birthday is silently dropped rather than
  // saved malformed, same rule canContinue already enforces for Continue.
  function skip() {
    tap();
    update({
      birthday: birthdayValid ? (birthday || undefined) : undefined,
      gender: coerceGender(gender) ?? undefined,
    });
    router.push(`/${nextStep("you")}` as never);
  }

  const summary = demographicSummary(birthday);

  return (
    <StepShell stepIndex={9} prevPath="fun">
      <div className="space-y-8">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            A couple things about you.
          </h1>
          {/* alpha-drift-r17-08 (found+fixed 2026-08-07): this used to say
              "Both are optional" unconditionally, even when Zodiac was
              picked on the prior step -- in that case birthday is required
              to continue (Continue stays disabled, the Skip button is
              removed from the DOM entirely below), and only the dynamic
              helper text under the input actually said so. The static
              claim right above the form was left contradicting the form
              itself. */}
          {/* alpha-drift-r35-11 (2026-08-14): semicolons are a hard no in
              reader-facing copy per house style -- this was the only one
              in the whole onboarding flow. */}
          <p className="alpha-ui text-sm md:text-base" style={{ color: "var(--ink-soft)" }}>
            {zodiacPicked
              ? "This tunes the letter so it reads like it was written for you. Gender is optional. Birthday isn't, since you picked Zodiac. Never shared."
              : "This tunes the letter so it reads like it was written for you. Both are optional, and never shared."}
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
            max={maxBirthdayForMinAge()}
            onChange={(e) => setBirthday(e.target.value)}
            className="alpha-display text-2xl md:text-3xl bg-transparent border-b pt-2 pb-3 focus:outline-none focus:border-current"
            // alpha-drift-r16-04: see components/ProfileEditor.tsx's
            // matching birthday input for why colorScheme:"light" was
            // removed here too -- app/globals.css's per-theme
            // color-scheme now handles this correctly.
            style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
            // alpha-drift-r23-07 (found+fixed 2026-08-14): the r22-04 fix
            // added real validation that silently disables Continue on an
            // out-of-range typed date, but neither the input nor its hint
            // text had any aria wiring -- a screen-reader user got zero
            // announcement that anything changed. aria-describedby always
            // points at the hint (whichever of its 3 states is showing);
            // aria-invalid reflects the SAME format-validity check
            // birthdayValid/canContinue already gate on, not just "empty."
            aria-describedby="alpha-birthday-hint"
            aria-invalid={birthday.length > 0 && !birthdayValid}
          />
          {/* alpha-drift-r23-02 (found+fixed 2026-08-14): --accent-ink fails
              WCAG AA 4.5:1 text contrast against --paper in 12+ of this
              app's themes, including the default "forest" (2.88:1) -- there
              is no dedicated --danger/--error token, and this is genuine
              small-reading-size validation text a reader needs to be able
              to read to know why Continue is disabled. --ink clears 4.5:1
              in every theme (verified in round 21's admin-page fix); same
              swap, not a new token, to stay consistent with that precedent. */}
          <p
            id="alpha-birthday-hint"
            role="status"
            aria-live="polite"
            className="alpha-ui text-xs mt-2"
            style={{ color: (zodiacPicked && !birthday) || (birthday.length > 0 && !birthdayValid) ? "var(--ink)" : "var(--ink-soft)" }}
          >
            {birthday.length > 0 && !birthdayValid
              ? "That date doesn't look right. Double check the day, month, and year."
              : zodiacPicked && !birthday
                ? "You picked Zodiac, so add your birthday and we'll read your sign each day."
                : summary
                  ? `${summary}. The full date also unlocks the Zodiac topic if you want it.`
                  : "The full date tunes the letter to your generation and unlocks the Zodiac topic if you want it."}
          </p>
        </div>

        <div>
          <span id="you-gender-label" className="alpha-ui text-sm block mb-2" style={{ color: "var(--ink-soft)" }}>
            Gender
          </span>
          <div role="group" aria-labelledby="you-gender-label" className="flex flex-wrap gap-2">
            {GENDERS.map((g) => {
              const active = gender === g.value;
              return (
                <button
                  key={g.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => { setGender(active ? null : g.value); tap(); }}
                  // alpha-drift-r20-11 (found+fixed 2026-08-13): py-2 measured
                  // ~38px tall live, 2px under the commonly-cited 40px mobile
                  // touch-target guideline (still passed WCAG's stricter 24px
                  // floor, but worth the bump since these sit right next to
                  // each other in a row).
                  className="alpha-ui text-sm px-4 py-2.5 rounded-full border transition"
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
              aria-pressed={gender === "skip"}
              onClick={() => { setGender(gender === "skip" ? null : "skip"); tap(); }}
              // alpha-drift-r20-11: same touch-target bump as the two gender
              // buttons above.
              className="alpha-ui text-sm px-4 py-2.5 rounded-full border transition"
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
              onClick={skip}
              // alpha-drift-r23-09 (found+fixed 2026-08-14): ~20px tall
              // (bare text-sm, no padding), under the WCAG 2.5.8 24px
              // floor, sitting right next to Continue -- same "these sit
              // right next to each other" configuration r20-11 already
              // bumped elsewhere on this page. p-2 -m-2 (InstallPrompt.tsx's
              // established pattern): the negative margin cancels the
              // padding's layout impact, so the tap target grows without
              // moving anything visually.
              className="alpha-ui text-sm underline underline-offset-4 p-2 -m-2"
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
