"use client";

import { useEffect } from "react";
import { coerceThemeId } from "@/lib/themes";
import type { ThemeId } from "@/lib/types";

const ONBOARDING_KEY = "alpha-onboarding";
const FALLBACK_KEY = "alpha-theme";

// Inlined instead of importing supabaseConfigured from lib/supabase/client.ts:
// that module's top-level `import { createBrowserClient } from "@supabase/ssr"`
// pulls the ENTIRE @supabase/supabase-js surface (GoTrueClient, RealtimeClient,
// ~240KB) into whatever imports ANY export from it, even a 3-line env-var
// check. ThemeApplier is the one component mounted unconditionally on every
// route including static marketing/legal pages, so it was the single largest
// JS chunk in the whole build. supabaseClient() itself is still dynamically
// imported below, only when this check passes.
function isSupabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (!!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

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
      if (!isSupabaseConfigured()) return;
      try {
        const { supabaseClient } = await import("@/lib/supabase/client");
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("users")
          .select("theme, email")
          .eq("id", user.id)
          .maybeSingle();
        const dbTheme = coerceThemeId(data?.theme);
        if (dbTheme) set(dbTheme);
        // Self-heal the email mirror app-wide. After a confirmed email change the
        // auth email leads public.users.email (what the cron sends to); this is
        // the cheapest always-signed-in hook (the getUser + users read already
        // happen here for theme), so any return visit catches the mirror up, not
        // just /settings. No-op on every normal load (they already match).
        const authLc = user.email?.trim().toLowerCase();
        if (authLc && (data?.email ?? "").toLowerCase() !== authLc) {
          fetch("/api/account/email/reconcile", { method: "POST" }).catch(() => {});
        }
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
