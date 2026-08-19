"use client";

import { useEffect, useState, useCallback } from "react";
import type { TopicId, ThemeId, Gender } from "./types";
import { syncUserProfile } from "./user-sync";

const STORAGE_KEY = "alpha-onboarding";

export interface OnboardingState {
  firstName?: string;
  city?: string;
  jobBlurb?: string;
  projectBlurb?: string;
  funBlurb?: string;
  birthday?: string; // ISO "YYYY-MM-DD"
  gender?: Gender;
  topics?: TopicId[];
  theme?: ThemeId;
  email?: string;
  completedAt?: string;
  paid?: boolean;
  savedAt?: number; // epoch ms of the most recent write -- see read()'s email staleness check below
}

const EMPTY: OnboardingState = {};

// alpha-drift-r36-12 (2026-08-14): email is the one field in this state that
// becomes the account's actual identity -- app/checkout/page.tsx's
// subscribe() POSTs it unchanged as Stripe's customer_email, and Stripe
// LOCKS that field on the hosted checkout page (uneditable). Every other
// field here (name/city/blurbs) only degrades personalization if it's
// stale; a stale email silently checks a stranger out under a stranger's
// identity on a shared/library/kiosk computer whose prior visitor abandoned
// onboarding partway. app/signin/page.tsx already refuses to trust this
// same STORAGE_KEY for its own, lower-stakes REMEMBERED_EMAIL_KEY prefill
// fallback for exactly this reason -- this TTL brings the higher-stakes
// email field here up to that same bar without forcing a full re-onboard
// for the overwhelmingly common case (finishing onboarding started earlier
// the same day).
const EMAIL_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

function read(): OnboardingState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as OnboardingState;
    if (parsed.email && (!parsed.savedAt || Date.now() - parsed.savedAt > EMAIL_STALE_AFTER_MS)) {
      const { email: _stale, ...rest } = parsed;
      return rest;
    }
    return parsed;
  } catch {
    return EMPTY;
  }
}

function write(s: OnboardingState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage blocked/full (Safari private mode, locked-down browser, etc).
    // Fail soft and keep going in-memory for this session rather than
    // throwing inside the setState updater and tripping the error boundary.
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setState(read());
    setLoaded(true);
  }, []);

  const update = useCallback((patch: Partial<OnboardingState>) => {
    // Merge onto the freshest localStorage contents, not the in-memory
    // `state` -- another tab may have written since this tab last hydrated,
    // and a merge onto stale in-memory state would silently overwrite
    // whatever that other tab just saved.
    // alpha-drift-r36-12: savedAt stamped on every write so read()'s email
    // staleness check has a real timestamp to compare against.
    const next = { ...read(), ...patch, savedAt: Date.now() };
    write(next);
    // Fire-and-forget Supabase sync if user is authed. Errors are swallowed
    // inside syncUserProfile — never blocks the UI.
    syncUserProfile(next);
    setState(next);
  }, []);

  const reset = useCallback(() => {
    setState(EMPTY);
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { state, update, reset, loaded };
}

export const ONBOARDING_STEPS = [
  { path: "welcome", label: "Welcome" },
  { path: "theme", label: "Theme" },
  { path: "name", label: "Name" },
  { path: "city", label: "City" },
  { path: "role", label: "Role" },
  { path: "focus", label: "Focus" },
  { path: "topics", label: "Topics" },
  { path: "fun", label: "Fun" },
  { path: "you", label: "About you" },
  { path: "email", label: "Email" },
  { path: "checkout", label: "Subscribe" },
] as const;

export function nextStep(currentPath: string): string {
  const idx = ONBOARDING_STEPS.findIndex((s) => s.path === currentPath);
  if (idx === -1 || idx === ONBOARDING_STEPS.length - 1) return "checkout";
  return ONBOARDING_STEPS[idx + 1].path;
}
