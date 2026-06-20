"use client";

import { useEffect } from "react";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { coerceThemeId } from "@/lib/themes";
import type { ThemeId } from "@/lib/types";

const ONBOARDING_KEY = "alpha-onboarding";
const FALLBACK_KEY = "alpha-theme";

// Applies the active theme to <html data-theme="..."> on every page so the
// entire app — not just the rendered letter — reflects the user's pick.
//
// Resolution order:
//   1. Signed-in user's saved theme from public.users (highest authority)
//   2. Onboarding-state localStorage (mid-funnel users who picked but haven't paid)
//   3. Standalone alpha-theme localStorage (legacy ThemeSwitcher writes)
//   4. "forest" default
//
// Picks up changes via a custom event ("alpha-theme-change") so when the user
// changes theme in onboarding or settings, every mounted page re-applies
// without a refresh.
export function ThemeApplier() {
  useEffect(() => {
    let cancelled = false;

    function set(id: ThemeId) {
      if (cancelled) return;
      document.documentElement.setAttribute("data-theme", id);
    }

    function readLocalTheme(): ThemeId | null {
      try {
        const raw = localStorage.getItem(ONBOARDING_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { theme?: ThemeId };
          if (parsed.theme) return parsed.theme;
        }
        const fallback = localStorage.getItem(FALLBACK_KEY) as ThemeId | null;
        if (fallback) return fallback;
      } catch {
        // ignore
      }
      return null;
    }

    // Apply local theme immediately so there's no flash.
    const localTheme = readLocalTheme();
    if (localTheme) set(localTheme);

    // Then check Supabase — overrides local if the server has a different theme.
    (async () => {
      if (!supabaseConfigured()) return;
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("users")
          .select("theme")
          .eq("id", user.id)
          .maybeSingle();
        const dbTheme = coerceThemeId(data?.theme);
        if (dbTheme) set(dbTheme);
      } catch {
        // ignore — fall back to local
      }
    })();

    function onChange(e: Event) {
      const detail = (e as CustomEvent<{ theme?: ThemeId }>).detail;
      if (detail?.theme) set(detail.theme);
    }
    function onStorage(e: StorageEvent) {
      if (e.key === ONBOARDING_KEY || e.key === FALLBACK_KEY) {
        const next = readLocalTheme();
        if (next) set(next);
      }
    }

    window.addEventListener("alpha-theme-change", onChange);
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      window.removeEventListener("alpha-theme-change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return null;
}
