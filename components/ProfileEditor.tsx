"use client";

import { useEffect, useRef, useState } from "react";
import { useOnboarding } from "@/lib/onboarding-state";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { coerceGender, demographicSummary } from "@/lib/demographics";
import type { Gender } from "@/lib/types";

// The details onboarding collected. Editing them used to be impossible after
// sign-up (settings only let you change topics + theme). first_name + city are
// required; everything else is optional and clearable. Labels/placeholders
// mirror the onboarding steps so the questions read the same here.
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
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) {
          setLoaded(true);
          return;
        }
        setSignedIn(true);
        const { data: row } = await sb
          .from("users")
          .select("first_name, city, job_blurb, project_blurb, fun_blurb, birthday, gender, topics")
          .eq("id", user.id)
          .maybeSingle();
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
        setLoaded(true);
      }
    })();
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

  const requiredFilled = form.firstName.trim().length > 0 && form.city.trim().length > 0;
  const canSave = dirty && requiredFilled && !busy;

  async function save() {
    if (!canSave || saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/alpha/api/account/profile", {
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

  if (loaded && supabaseConfigured() && !signedIn) {
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

      <div className="space-y-5">
        <Field
          label="First name"
          value={form.firstName}
          onChange={(v) => set("firstName", v)}
          placeholder="you"
          disabled={!loaded || busy}
        />
        <Field
          label="City"
          value={form.city}
          onChange={(v) => set("city", v)}
          placeholder="St. Petersburg, FL"
          hint="Lets the letter flag what's nearby. Never shared."
          disabled={!loaded || busy}
        />
        <label className="block">
          <span className="alpha-ui text-xs block mb-1" style={{ color: "var(--ink-soft)" }}>
            Birthday
          </span>
          <input
            type="date"
            value={form.birthday}
            min="1920-01-01"
            max="2014-12-31"
            disabled={!loaded || busy}
            onChange={(e) => set("birthday", e.target.value)}
            className="w-full alpha-ui text-base bg-transparent border-b pt-2 pb-2 focus:outline-none focus:border-current"
            style={{ color: "var(--ink)", borderColor: "var(--rule)", colorScheme: "light" }}
          />
          <span
            className="alpha-ui text-xs block mt-1"
            style={{ color: hasZodiac && !form.birthday ? "var(--accent-ink)" : "var(--ink-soft)", opacity: hasZodiac && !form.birthday ? 1 : 0.8 }}
          >
            {(() => {
              if (hasZodiac && !form.birthday) {
                return "You have the Zodiac topic. Add your birthday or that section gets skipped each week.";
              }
              const summary = demographicSummary(form.birthday);
              return summary
                ? `${summary}. Tunes the letter and unlocks the Zodiac topic. Optional.`
                : "Tunes the letter to your generation and unlocks the Zodiac topic. Optional.";
            })()}
          </span>
        </label>
        <div>
          <span className="alpha-ui text-xs block mb-2" style={{ color: "var(--ink-soft)" }}>
            Gender
          </span>
          <div className="flex flex-wrap gap-2">
            {(["male", "female"] as const).map((g) => {
              const active = form.gender === g;
              return (
                <button
                  key={g}
                  type="button"
                  disabled={!loaded || busy}
                  onClick={() => {
                    setForm((f) => ({ ...f, gender: f.gender === g ? "" : g }));
                    if (msg) setMsg(null);
                  }}
                  className="alpha-ui text-sm px-4 py-1.5 rounded-full border transition"
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
          <span className="alpha-ui text-xs block mt-1" style={{ color: "var(--ink-soft)", opacity: 0.8 }}>
            Optional. Lets the letter talk to you naturally. Leave both off to keep it unset.
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
        />
        <Field
          label="What you're working on"
          value={form.projectBlurb}
          onChange={(v) => set("projectBlurb", v)}
          placeholder="scaling our agency to 5 people this year"
          hint="Optional."
          multiline
          disabled={!loaded || busy}
        />
        <Field
          label="One fun thing"
          value={form.funBlurb}
          onChange={(v) => set("funBlurb", v)}
          placeholder="Florida pollinator gardening"
          hint="Optional. We'll find one fun item for you most weeks."
          multiline
          disabled={!loaded || busy}
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
          style={{ color: msg.kind === "err" ? "var(--accent-ink)" : "var(--ink-soft)" }}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const shared = {
    value,
    placeholder,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    className:
      "w-full alpha-ui text-base bg-transparent border-b pt-2 pb-2 focus:outline-none focus:border-current placeholder:opacity-40",
    style: { color: "var(--ink)", borderColor: "var(--rule)" } as React.CSSProperties,
  };
  return (
    <label className="block">
      <span className="alpha-ui text-xs block mb-1" style={{ color: "var(--ink-soft)" }}>
        {label}
      </span>
      {multiline ? (
        <textarea {...shared} rows={2} className={`${shared.className} resize-none`} />
      ) : (
        <input {...shared} type="text" />
      )}
      {hint && (
        <span className="alpha-ui text-xs block mt-1" style={{ color: "var(--ink-soft)", opacity: 0.8 }}>
          {hint}
        </span>
      )}
    </label>
  );
}
