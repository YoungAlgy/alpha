"use client";

import { useEffect, useState, useCallback } from "react";
import type { TopicId, ThemeId } from "./types";
import { syncUserProfile } from "./user-sync";

const STORAGE_KEY = "alpha-onboarding";

export interface OnboardingState {
  firstName?: string;
  city?: string;
  jobBlurb?: string;
  projectBlurb?: string;
  funBlurb?: string;
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setState(read());
    setLoaded(true);
  }, []);

  const update = useCallback((patch: Partial<OnboardingState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      write(next);
      // Fire-and-forget Supabase sync if user is authed. Errors are swallowed
      // inside syncUserProfile — never blocks the UI.
      syncUserProfile(next);
      return next;
    });
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
  { path: "email", label: "Email" },
  { path: "checkout", label: "Subscribe" },
] as const;

export function nextStep(currentPath: string): string {
  const idx = ONBOARDING_STEPS.findIndex((s) => s.path === currentPath);
  if (idx === -1 || idx === ONBOARDING_STEPS.length - 1) return "checkout";
  return ONBOARDING_STEPS[idx + 1].path;
}
