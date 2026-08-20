"use client";

import { useEffect, useRef, useState } from "react";
import { useOnboarding } from "@/lib/onboarding-state";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { coerceGender, demographicSummary, maxBirthdayForMinAge, parseBirthday } from "@/lib/demographics";
import { BLURB_CAPS } from "@/lib/types";
import type { Gender } from "@/lib/types";

// The details onboarding collected. Editing them used to be impossible after
// sign-up (settings only let you change topics + theme). Only first name is
// required; everything else (including city, as of alpha-drift-r57-01) is
// optional and clearable, matching app/api/account/profile/route.ts and the
// rest of the app (checkout, generation, the DB schema itself). Labels/
// placeholders mirror the onboarding steps so the questions read the same
// here.
interface Form {
  firstName: string;
  city: string;
  jobBlurb: string;
  projectBlurb: string;
  funBlurb: string;
  birthday: string; // ISO "YYYY-MM-DD" or ""
  gender: "" | Gender; // "" = unspecified
}

const EMPTY: Form = { firstName: "", city: "", jobBlurb: "", projectBlurb: "", funBlurb: "", birthday: "", gender: "" };

function genderOf(v: unknown): "" | Gender {
  return coerceGender(v) ?? ""; // "" = unspecified, for the form state
}

export function ProfileEditor() {
  const { update } = useOnboarding();
  const [form, setForm] = useState<Form>(EMPTY);
  // Snapshot of what's saved, for dirty-detection — Save only lights up when
  // something actually changed. Held in state (not a ref) so the dirty compare
  // reads it cleanly during render.
  const [saved, setSaved] = useState<Form>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  // The reader's saved topics, only so we can warn when they have the Zodiac
  // topic but no birthday (that section gets skipped without one). Mirrors the
  // onboarding "you" step's gate, which the settings editor otherwise lacks.
  const [hasZodiac, setHasZodiac] = useState(false);
  // alpha-drift-r62-07 (2026-08-20, silent-catch-audit-r8): a genuine read
  // failure on the hydrate below used to be indistinguishable from a
  // legitimately-empty profile -- form/saved both landed on EMPTY, Save
  // unlocked the instant the reader retyped just their first name, and the
  // route's own explicit-clear-on-blank semantics then wrote real nulls over
  // the reader's actual city/blurbs/birthday/gender. Logging alone doesn't
  // stop that; this flag blocks Save until the reader reloads and a real
  // hydrate succeeds.
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Synchronous re-entrancy latch: busy is React state, so a sub-16ms double
  // click can call save() twice before the disabled state flushes. The ref flips
  // synchronously and blocks the second POST. (Mirrors the billing action's latch
  // on the settings page.) The write is idempotent, so this is belt-and-suspenders.
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!supabaseConfigured()) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (cancelled) return;
        if (!user) {
          setLoaded(true);
          return;
        }
        setSignedIn(true);
        const { data: row, error: rowErr } = await sb
          .from("users")
          .select("first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics")
          .eq("id", user.id)
          .maybeSingle();
        if (cancelled) return;
        if (rowErr) {
          // Logged AND blocks Save (see hydrateFailed's own comment) --
          // supabase-js resolves rather than throws on a query error, so the
          // catch below was structurally blind to this exact failure mode.
          console.warn("[ProfileEditor] signed-in hydrate row fetch failed:", rowErr.message);
          setHydrateFailed(true);
          return;
        }
        setHasZodiac(Array.isArray(row?.topics) && row.topics.includes("zodiac"));
        const next: Form = {
          firstName: row?.first_name ?? "",
          city: row?.city ?? "",
          jobBlurb: row?.job_blurb ?? "",
          projectBlurb: row?.project_blurb ?? "",
          funBlurb: row?.fun_blurb ?? "",
          birthday: row?.birthday ?? "",
          gender: genderOf(row?.gender),
        };
        setSaved(next);
        setForm(next);
      } catch {
        // ignore — the form stays empty and Save will surface a real error
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof Form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (msg) setMsg(null);
  }

  const dirty =
    form.firstName !== saved.firstName ||
    form.city !== saved.city ||
    form.jobBlurb !== saved.jobBlurb ||
    form.projectBlurb !== saved.projectBlurb ||
    form.funBlurb !== saved.funBlurb ||
    form.birthday !== saved.birthday ||
    form.gender !== saved.gender;

  // alpha-drift-r57-01 (2026-08-20, form-validation-consistency-audit-r2):
  // city dropped out of this gate -- it was the one place in the app
  // requiring it (checkout's isProfileComplete, the generate-route schema,
  // and the DB column itself all treat it as optional), and with no visible
  // required/optional indicator anywhere on this form, a subscriber who
  // legitimately reached Settings with an empty city (e.g. a direct-
  // checkout signup that skipped onboarding -- an explicitly anticipated
  // case, not hypothetical) got a permanently disabled Save button with
  // zero explanation. See app/api/account/profile/route.ts's matching fix.
  const requiredFilled = form.firstName.trim().length > 0;
  // alpha-drift-r34-02 (2026-08-14): this used to only require firstName/city
  // -- birthday had NO validity gate at all, unlike app/you/page.tsx's
  // alpha-drift-r22-04 fix for the identical input. A native <input
  // type="date">'s min/max are validity-STYLING only; they don't block
  // .value from holding an out-of-range date typed via keyboard. Without
  // this, a reader could type a malformed birthday, click Save, and get a
  // false "Saved" success message while app/api/account/profile/route.ts
  // silently coerced the bad value to null server-side -- the Zodiac
  // section would then quietly stop working with zero indication why.
  const birthdayValid = form.birthday.length === 0 || parseBirthday(form.birthday) !== null;
  const canSave = dirty && requiredFilled && birthdayValid && !busy && !hydrateFailed;

  async function save() {
    if (!canSave || saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/account/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setMsg({ kind: "err", text: "Sign in first to edit your details." });
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Authoritative values come back from the server (trimmed/cleared). Adopt
      // them as the new snapshot and refresh the local onboarding mirror so the
      // greeting + theme preview on this device don't go stale. Cleared blurbs
      // come back null → undefined locally (user-sync skips empties, so the DB
      // null the server just wrote is preserved).
      const p = data.profile ?? {};
      const savedForm: Form = {
        firstName: p.first_name ?? "",
        city: p.city ?? "",
        jobBlurb: p.job_blurb ?? "",
        projectBlurb: p.project_blurb ?? "",
        funBlurb: p.fun_blurb ?? "",
        birthday: p.birthday ?? "",
        gender: genderOf(p.gender),
      };
      setSaved(savedForm);
      setForm(savedForm);
      update({
        firstName: savedForm.firstName,
        city: savedForm.city,
        jobBlurb: savedForm.jobBlurb || undefined,
        projectBlurb: savedForm.projectBlurb || undefined,
        funBlurb: savedForm.funBlurb || undefined,
        birthday: savedForm.birthday || undefined,
        gender: savedForm.gender || undefined,
      });
      setMsg({ kind: "ok", text: "Saved. Your next letter uses these." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Couldn't save. Try again." });
    } finally {
      setBusy(false);
      saveInFlight.current = false;
    }
  }

  // alpha-drift-r19-01 (found+fixed 2026-08-07): the only loading gate here
  // used to be the signed-in check just below, which is itself gated on
  // `loaded` -- while loaded was still false, THAT condition was false too,
  // so the component fell through and rendered the full form immediately
  // with form=EMPTY (every field blank, merely disabled). A returning
  // subscriber briefly saw their own profile as if it were empty. Same
  // pulse-skeleton pattern as app/archive/page.tsx and app/settings/
  // accounts/page.tsx's user list, shaped like the eventual field list.
  if (!loaded) {
    return (
      <div className="space-y-5 animate-pulse" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className="h-3 w-20 mb-2 rounded" style={{ background: "var(--rule)" }} />
            <div className="h-9 w-full rounded" style={{ background: "var(--rule)" }} />
          </div>
        ))}
      </div>
    );
  }

  if (supabaseConfigured() && !signedIn) {
    return (
      <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
        Sign in to edit your details.
      </p>
    );
  }

  return (
    <div>
      <p className="alpha-ui text-sm mb-5" style={{ color: "var(--ink-soft)" }}>
        The more your letter knows, the more it feels written for you. Change any
        of it anytime.
      </p>

      {hydrateFailed && (
        <p role="alert" className="alpha-ui text-sm mb-5" style={{ color: "var(--ink)" }}>
          Couldn&apos;t load your saved details. Reload the page before making changes here --
          saving now would overwrite them with blanks.
        </p>
      )}

      <div className="space-y-5">
        <Field
          label="First name"
          value={form.firstName}
          onChange={(v) => set("firstName", v)}
          placeholder="you"
          disabled={!loaded || busy}
          maxLength={60}
          required
        />
        <Field
          label="City"
          value={form.city}
          onChange={(v) => set("city", v)}
          placeholder="St. Petersburg, FL"
          hint="Lets the letter flag what's nearby. Never shared."
          disabled={!loaded || busy}
          maxLength={120}
        />
        <label className="block">
          <span className="alpha-ui text-xs block mb-1" style={{ color: "var(--ink-soft)" }}>
            Birthday
          </span>
          <input
            type="date"
            value={form.birthday}
            min="1920-01-01"
            max={maxBirthdayForMinAge()}
            disabled={!loaded || busy}
            onChange={(e) => set("birthday", e.target.value)}
            className="w-full alpha-ui text-base bg-transparent border-b pt-2 pb-2 focus:outline-none focus:border-current"
            // alpha-drift-r16-04 (found+fixed 2026-08-07): no colorScheme
            // override here anymore -- it hardcoded "light", mismatching
            // native date-picker chrome on any of the app's 7 dark themes.
            // app/globals.css now sets color-scheme:dark on those themes'
            // own [data-theme] blocks, which correctly cascades down to
            // this element without needing a per-input override at all.
            style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
            // alpha-drift-r34-02: aria wiring mirrors app/you/page.tsx's
            // r23-07 fix -- aria-describedby always points at the hint
            // (whichever of its states is showing), aria-invalid reflects
            // the same format-validity check birthdayValid/canSave gate on.
            aria-describedby="profile-birthday-hint"
            aria-invalid={form.birthday.length > 0 && !birthdayValid}
          />
          <span
            id="profile-birthday-hint"
            role="status"
            aria-live="polite"
            className="alpha-ui text-xs block mt-1"
            style={{
              // alpha-drift-r53-01 (2026-08-20, accessibility-resweep-newer-code):
              // this branch still used --accent-ink -- the identical
              // Zodiac-birthday-required warning on app/topics/page.tsx and
              // app/you/page.tsx was fixed to --ink in round 24
              // (alpha-drift-r24-01, --accent-ink fails WCAG AA 4.5:1 in 12+
              // themes) but this ProfileEditor.tsx copy was missed by that
              // sweep, and round 34 later added role="status" to this exact
              // span without touching the color -- scripts/verify-accent-
              // ink-error-text-contrast.mts's own comprehensive scan (check
              // 5) already asserts zero role="status"/role="alert" elements
              // use --accent-ink app-wide, and was failing on exactly this
              // offender until this fix.
              // alpha-drift-r63-02 (2026-08-21, accessibility-resweep-
              // newer-code-r11): the default (non-warning) branch carried
              // opacity: 0.8 on --ink-soft -- the same class round 62 fixed
              // at 2 other spots in this same file, missed here since
              // round 62's regex only matched a bare `color, opacity`
              // object, not this ternary form. --ink-soft alone already
              // clears WCAG AA 4.5:1 in every theme, so dropping the
              // opacity is the whole fix.
              color: (form.birthday.length > 0 && !birthdayValid) ? "var(--ink)" : hasZodiac && !form.birthday ? "var(--ink)" : "var(--ink-soft)",
            }}
          >
            {(() => {
              if (form.birthday.length > 0 && !birthdayValid) {
                return "That date doesn't look right. Double check the day, month, and year.";
              }
              if (hasZodiac && !form.birthday) {
                return "You have the Zodiac topic. Add your birthday or that section gets skipped each day.";
              }
              const summary = demographicSummary(form.birthday);
              return summary
                ? `${summary}. Tunes the letter and unlocks the Zodiac topic. Optional.`
                : "Tunes the letter to your generation and unlocks the Zodiac topic. Optional.";
            })()}
          </span>
        </label>
        <div>
          <span id="profile-gender-label" className="alpha-ui text-xs block mb-2" style={{ color: "var(--ink-soft)" }}>
            Gender
          </span>
          <div role="group" aria-labelledby="profile-gender-label" className="flex flex-wrap gap-2">
            {(["male", "female"] as const).map((g) => {
              const active = form.gender === g;
              return (
                <button
                  key={g}
                  type="button"
                  disabled={!loaded || busy}
                  aria-pressed={active}
                  onClick={() => {
                    setForm((f) => ({ ...f, gender: f.gender === g ? "" : g }));
                    if (msg) setMsg(null);
                  }}
                  className="alpha-ui text-sm px-4 py-2.5 rounded-full border transition"
                  style={{
                    borderColor: active ? "var(--accent)" : "var(--rule)",
                    background: active ? "var(--callout-bg)" : "transparent",
                    color: active ? "var(--accent-ink)" : "var(--ink)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {g === "male" ? "Male" : "Female"}
                </button>
              );
            })}
          </div>
          {/* alpha-drift-r35-13 (2026-08-14): "unset" is a programmer's word
              (unset variable/flag) -- the onboarding version of this same
              question already uses the human phrasing, "Prefer not to say."
              alpha-drift-r62-03 (2026-08-20, accessibility-resweep-newer-
              code-round-10): opacity 0.8 on --ink-soft fails WCAG AA
              4.5:1 in most themes -- --ink-soft alone already clears it. */}
          <span className="alpha-ui text-xs block mt-1" style={{ color: "var(--ink-soft)" }}>
            Optional. Lets the letter talk to you naturally. Leave both off if you&apos;d rather not say.
          </span>
        </div>
        <Field
          label="What you do"
          value={form.jobBlurb}
          onChange={(v) => set("jobBlurb", v)}
          placeholder="one sentence, the thing you'd say at a dinner party"
          hint="Optional."
          multiline
          disabled={!loaded || busy}
          maxLength={BLURB_CAPS.jobBlurb}
        />
        <Field
          label="What you're working on"
          value={form.projectBlurb}
          onChange={(v) => set("projectBlurb", v)}
          placeholder="scaling our agency to 5 people this year"
          hint="Optional."
          multiline
          disabled={!loaded || busy}
          maxLength={BLURB_CAPS.projectBlurb}
        />
        <Field
          label="One fun thing"
          value={form.funBlurb}
          onChange={(v) => set("funBlurb", v)}
          placeholder="Florida pollinator gardening"
          hint="Optional. We'll weave this into your letters when it fits."
          multiline
          disabled={!loaded || busy}
          maxLength={BLURB_CAPS.funBlurb}
        />
      </div>

      <div className="flex items-center gap-4 mt-6">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="alpha-button alpha-button-accent text-sm"
          style={{ opacity: canSave ? 1 : 0.4, cursor: canSave ? "pointer" : "not-allowed" }}
        >
          {busy ? "Saving…" : "Save details"}
        </button>
        {dirty && !busy && (
          <span className="alpha-ui text-xs" style={{ color: "var(--ink-soft)" }}>
            Unsaved changes
          </span>
        )}
      </div>

      {msg && (
        <p
          role="status"
          aria-live="polite"
          className="alpha-ui text-sm mt-3"
          // alpha-drift-r24-01: same --accent-ink WCAG contrast gap round 23
          // fixed elsewhere -- closing the remaining instances in one pass.
          style={{ color: msg.kind === "err" ? "var(--ink)" : "var(--ink-soft)" }}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline = false,
  disabled = false,
  maxLength,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  disabled?: boolean;
  // Matches app/api/account/profile/route.ts's LIMITS for the same field --
  // that route silently truncates an overage rather than rejecting it, so
  // without this a reader could paste something over the cap and see
  // "Saved" with no indication most of what they wrote was cut server-side.
  maxLength?: number;
  // alpha-drift-r57-01 (2026-08-20, form-validation-consistency-audit-r2):
  // this form's Save button silently disables with zero explanation when a
  // required field is empty -- unlike app/support/SupportForm.tsx's own
  // Field, which has always shown a visible marker. Mirrors that pattern so
  // a blocked Save is never a silent dead end again.
  required?: boolean;
}) {
  const shared = {
    value,
    placeholder,
    disabled,
    maxLength,
    // alpha-drift-r58-01 (2026-08-20, self-audit-r57): round 57's required
    // prop only rendered a visual asterisk -- it never reached the actual
    // control, so a screen-reader user got zero indication First name was
    // required (unlike app/support/SupportForm.tsx's Field, which the round
    // 57 commit claimed to mirror: there the caller places a REAL `required`
    // attribute on its own input in addition to that Field's asterisk-only
    // prop, two mechanisms working together -- this component collapsed
    // that into one and silently dropped the accessibility half). No <form>
    // wraps this component and Save is a plain type="button" onClick
    // handler, so adding `required` here has zero native-form-validation
    // side effects -- it's a pure accessibility fix.
    required: required || undefined,
    "aria-required": required || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    className:
      "w-full alpha-ui text-base bg-transparent border-b pt-2 pb-2 focus:outline-none focus:border-current placeholder:opacity-40",
    style: { color: "var(--ink)", borderColor: "var(--rule)" } as React.CSSProperties,
  };
  return (
    <label className="block">
      <span className="alpha-ui text-xs block mb-1" style={{ color: "var(--ink-soft)" }}>
        {label}
        {/* alpha-drift-r58-02 (2026-08-20, accessibility-resweep-newer-
            code-round-6): --accent-ink fails WCAG AA 4.5:1 against --paper
            in the default theme and most others -- --ink clears every
            theme, the same swap already applied repeatedly elsewhere in
            this codebase for informational text. */}
        {required && <span style={{ color: "var(--ink)" }}> *</span>}
      </span>
      {multiline ? (
        <textarea {...shared} rows={2} className={`${shared.className} resize-none`} />
      ) : (
        <input {...shared} type="text" />
      )}
      {/* alpha-drift-r62-03 (2026-08-20, accessibility-resweep-newer-code-
          round-10): opacity 0.8 on --ink-soft fails WCAG AA 4.5:1 in most
          themes -- --ink-soft alone already clears it. */}
      {hint && (
        <span className="alpha-ui text-xs block mt-1" style={{ color: "var(--ink-soft)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}
