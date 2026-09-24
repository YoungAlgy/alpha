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
  // alpha-drift-r37-01 (2026-08-14, self-audit): this used to be a whole-
  // blob `savedAt` stamped on EVERY write regardless of which field the
  // patch touched -- so any unrelated update() call (saving topics,
  // birthday, whatever) silently refreshed a stale email's timestamp back
  // to "fresh," as long as some field got touched inside each rolling 24h
  // window. That defeated the whole point of the staleness check: a
  // stranger's abandoned email could stay "not stale" indefinitely on a
  // shared computer where a SECOND visitor's own onboarding activity (never
  // touching email themselves) kept resetting the clock. Narrowed to a
  // field-specific timestamp, stamped only when a patch actually sets/
  // changes email -- see update() below.
  emailSavedAt?: number;
  // Orders local, same-tab fallback, and in-memory copies after a storage failure.
  draftSavedAt?: number;
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

const STORAGE_ERROR = "Progress could not be saved in this browser. Keep this page open and try again.";
let memoryDraft: OnboardingState | undefined;
let memoryKind: "failed-write" | "failed-reset" | undefined;
let memoryExpectedLocal = false;
let memoryExpectedSession = false;

function readStore(store: "localStorage" | "sessionStorage"): { draft?: OnboardingState; failed: boolean } {
  try {
    const raw = window[store].getItem(STORAGE_KEY);
    if (!raw) return { failed: false };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { failed: true };
    return { draft: parsed as OnboardingState, failed: false };
  } catch {
    return { failed: true };
  }
}

function readRaw(): { draft: OnboardingState; storageError: boolean } {
  if (typeof window === "undefined") return { draft: EMPTY, storageError: false };
  const local = readStore("localStorage");
  const session = readStore("sessionStorage");
  // An external cleanup may remove a previously readable persisted draft.
  // Do not let a failed-write memory copy bring it back on the next mount.
  if (memoryKind === "failed-write" && (
    (memoryExpectedLocal && !local.failed && !local.draft) ||
    (memoryExpectedSession && !session.failed && !session.draft)
  )) {
    memoryDraft = undefined;
    memoryKind = undefined;
  }
  // Local wins ties to retain the existing cross-tab behavior. A newer
  // session copy wins when local writes failed after an older local save.
  const candidates = [local.draft, session.draft, memoryDraft];
  const draft = candidates.reduce<OnboardingState | undefined>((newest, candidate) => {
    if (!candidate) return newest;
    return !newest || (candidate.draftSavedAt ?? 0) > (newest.draftSavedAt ?? 0)
      ? candidate
      : newest;
  }, undefined) ?? EMPTY;
  return { draft, storageError: (local.failed && session.failed) || memoryKind === "failed-reset" };
}

function usableState(raw: OnboardingState): OnboardingState {
  if (raw.email && (!raw.emailSavedAt || Date.now() - raw.emailSavedAt > EMAIL_STALE_AFTER_MS)) {
    const { email: _stale, ...rest } = raw;
    void _stale;
    return rest;
  }
  return raw;
}

function write(s: OnboardingState): boolean {
  if (typeof window === "undefined") {
    memoryDraft = s;
    memoryKind = "failed-write";
    return false;
  }
  const serialized = JSON.stringify(s);
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* An older fallback cannot outrank this save. */ }
    memoryDraft = undefined;
    memoryKind = undefined;
    return true;
  } catch {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, serialized);
      memoryDraft = undefined;
      memoryKind = undefined;
      return true;
    } catch {
      memoryDraft = s;
      memoryKind = "failed-write";
      memoryExpectedLocal = !!readStore("localStorage").draft;
      memoryExpectedSession = !!readStore("sessionStorage").draft;
      return false;
    }
  }
}

function clearStoredDraft(): boolean {
  const resetAt = Math.max(Date.now(), (readRaw().draft.draftSavedAt ?? 0) + 1);
  if (typeof window === "undefined") {
    memoryDraft = undefined;
    memoryKind = undefined;
    return false;
  }
  let failed = false;
  const empty = JSON.stringify({ draftSavedAt: resetAt });
  for (const store of ["localStorage", "sessionStorage"] as const) {
    try {
      window[store].removeItem(STORAGE_KEY);
    } catch {
      // A denied removal may still permit overwriting the private draft.
      try { window[store].setItem(STORAGE_KEY, empty); } catch { failed = true; }
    }
  }
  memoryDraft = failed ? { draftSavedAt: resetAt } : undefined;
  memoryKind = failed ? "failed-reset" : undefined;
  return !failed;
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(EMPTY);
  const [emailDraft, setEmailDraft] = useState<string | undefined>(undefined);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Hydrate the browser-only store after the initial server/client render.
    const stored = readRaw();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(usableState(stored.draft));
    setEmailDraft(typeof stored.draft.email === "string" ? stored.draft.email : undefined);
    setStorageError(stored.storageError ? STORAGE_ERROR : null);
    setLoaded(true);
    const onStorage = (event: StorageEvent) => {
      if ((event.key === STORAGE_KEY && event.newValue === null) || event.key === null) {
        const cleared = clearStoredDraft();
        setState(EMPTY);
        setEmailDraft(undefined);
        setStorageError(cleared ? null : STORAGE_ERROR);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<OnboardingState>): boolean => {
    // Merge onto the freshest localStorage contents, not the in-memory
    // `state` -- another tab may have written since this tab last hydrated,
    // and a merge onto stale in-memory state would silently overwrite
    // whatever that other tab just saved.
    // alpha-drift-r37-01: emailSavedAt is stamped ONLY when this patch
    // actually sets/changes email -- NOT on every write. Stamping it
    // unconditionally (the original r36 approach) meant any unrelated field
    // write (topics, birthday, whatever) silently refreshed a stale
    // stranger's email back to "fresh" as long as something touched the
    // state within each rolling 24h window, defeating the staleness check
    // entirely.
    const current = readRaw().draft;
    const next = {
      ...current,
      ...patch,
      ...("email" in patch ? { emailSavedAt: Date.now() } : {}),
      draftSavedAt: Math.max(Date.now(), (current.draftSavedAt ?? 0) + 1),
    };
    const saved = write(next);
    // Fire-and-forget Supabase sync if user is authed. Errors are swallowed
    // inside syncUserProfile — never blocks the UI. `patch` (this call's
    // own, unmerged intent) is passed alongside `next` (the merged result)
    // so syncUserProfile can tell a field this call actually meant to touch
    // apart from one that's merely present from an earlier, possibly-stale
    // localStorage snapshot -- see alpha-drift-r60-10 on syncUserProfile
    // itself for why that distinction matters for topics specifically.
    if (saved) syncUserProfile(usableState(next), patch);
    setState(usableState(next));
    setEmailDraft(typeof next.email === "string" ? next.email : undefined);
    setStorageError(saved ? null : STORAGE_ERROR);
    return saved;
  }, []);

  const reset = useCallback((): boolean => {
    const cleared = clearStoredDraft();
    setState(EMPTY);
    setEmailDraft(undefined);
    setStorageError(cleared ? null : STORAGE_ERROR);
    return cleared;
  }, []);

  return { state, emailDraft, storageError, update, reset, loaded };
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
