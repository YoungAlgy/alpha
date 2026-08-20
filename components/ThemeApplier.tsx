"use client";

import { useEffect } from "react";
import { coerceThemeId } from "@/lib/themes";
import { themeEditedThisLoad, markThemeEditedThisLoad } from "@/lib/theme-edit-tracker";
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
        // alpha-drift-r55-04 (2026-08-20, hydrate-vs-live-edit-race-audit):
        // this SELECT is a real, unsequenced network round trip started at
        // mount, racing setTheme()'s own independent DB write (lib/
        // theme.ts) whenever a user picks a theme (ThemeSwitcher, or
        // app/theme/page.tsx) before this resolves. Without this check, a
        // hydrate landing after the pick silently reverted <html
        // data-theme> back to the stale pre-pick value, with ThemeSwitcher's
        // own active-theme label left showing the NEW pick (it isn't told
        // about this revert) -- a visibly inconsistent state until the next
        // navigation/reload re-reads the by-then-correct DB row. Same
        // live-edit-wins-over-same-mount-hydrate pattern as app/topics/
        // page.tsx's userEditedRef and app/theme/page.tsx's userPickedRef,
        // via a shared module flag since this and setTheme() are separate
        // component trees.
        if (dbTheme && !themeEditedThisLoad()) set(dbTheme);
        // Self-heal the email mirror app-wide. After a confirmed email change the
        // auth email leads public.users.email (what the cron sends to); this is
        // the cheapest always-signed-in hook (the getUser + users read already
        // happen here for theme), so any return visit catches the mirror up, not
        // just /settings. No-op on every normal load (they already match).
        const authLc = user.email?.trim().toLowerCase();
        if (authLc && (data?.email ?? "").toLowerCase() !== authLc) {
          // alpha-drift-r56-05 (2026-08-20, silent-catch-audit-r2): this is
          // the app's SOLE trigger for reconciling a confirmed new auth
          // email back into public.users.email (weekly-send's actual
          // delivery address) -- app/settings/page.tsx doesn't fire it
          // itself despite EmailChanger.tsx's own comment implying it does.
          // The route's own internal DB failures already page ops via
          // sendOpsAlert, but a failure at THIS layer (network blip, an ad/
          // privacy-blocker rule matching the URL) never reaches the server
          // at all, so that alert path never fires either -- previously
          // silent everywhere. Logged, not silent, matching this file's own
          // theme-hydrate catch below and lib/theme.ts's setTheme() convention.
          fetch("/api/account/email/reconcile", { method: "POST" }).catch((e) =>
            console.warn("[ThemeApplier] email reconcile failed:", e instanceof Error ? e.message : e)
          );
        }
      } catch {
        // ignore — fall back to local
      }
    })();

    function onChange(e: Event) {
      const detail = (e as CustomEvent<{ theme?: ThemeId }>).detail;
      if (detail?.theme) set(detail.theme);
    }
    // alpha-drift-r56-01 (2026-08-20, self-audit-r55): round 55's
    // live-edit-wins-over-hydrate guard only covered a same-tab pick
    // (setTheme() calling markThemeEditedThisLoad() before its own writes).
    // But setTheme() also writes localStorage, which fires this native
    // `storage` event in every OTHER open tab of the same origin -- and
    // this handler applied the cross-tab pick with no call to
    // markThemeEditedThisLoad(), so a tab whose own signed-in hydrate
    // SELECT was still in flight could have it silently reverted once that
    // SELECT resolved with the pre-pick value. Since editedThisLoad is a
    // per-tab module flag (not shared across tabs), a cross-tab pick has to
    // arm THIS tab's own copy explicitly, the same way an in-tab pick does.
    function onStorage(e: StorageEvent) {
      if (e.key === ONBOARDING_KEY || e.key === FALLBACK_KEY) {
        markThemeEditedThisLoad();
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
