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
}

const EMPTY: OnboardingState = {};

function read(): OnboardingState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : EMPTY;
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
    const next = { ...read(), ...patch };
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
