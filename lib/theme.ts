"use client";

import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { coerceThemeId } from "@/lib/themes";
import type { ThemeId } from "@/lib/types";

// The single canonical way to change the theme. Before this existed the theme
// lived in three disconnected stores (the onboarding-state key, a separate
// `alpha-theme` key, and the account row) and nothing kept them in sync — so
// a ThemeSwitcher pick wrote only `alpha-theme`, while ThemeApplier paints from
// the onboarding key and then overrides with the DB (its highest authority).
// Net effect: picks "didn't stick" on reload and settings/switcher disagreed.
//
// setTheme writes ALL of them at once + broadcasts, so every reader agrees and
// the pick survives a reload on any device.

const ONBOARDING_KEY = "alpha-onboarding";
const THEME_KEY = "alpha-theme";

export function setTheme(id: ThemeId): void {
  if (typeof window === "undefined") return;
  const safe = coerceThemeId(id);
  if (!safe) {
    console.error("[setTheme] invalid theme id, ignoring:", id);
    return;
  }
  id = safe;

  // 1. Instant repaint of the current page.
  document.documentElement.setAttribute("data-theme", id);

  // 2. Every local store ThemeApplier / ThemeSwitcher / onboarding might read.
  try {
    localStorage.setItem(THEME_KEY, id);
    const raw = localStorage.getItem(ONBOARDING_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    obj.theme = id;
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(obj));
  } catch {
    // storage unavailable — visual + broadcast still work for this session
  }

  // 3. Live re-paint of every other mounted view (ThemeApplier, settings, …).
  window.dispatchEvent(new CustomEvent("alpha-theme-change", { detail: { theme: id } }));

  // 4. Persist to the account — DB is ThemeApplier's source of truth for a
  //    signed-in user, so WITHOUT this the pick reverts on the next load.
  //    Fire-and-forget; failures fall back to the localStorage copy.
  if (supabaseConfigured()) {
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user) await sb.from("users").update({ theme: id }).eq("id", user.id);
      } catch (e) {
        // Logged, not silent: the DB row is the highest-authority source of
        // truth for a signed-in user (see the comment above) -- a
        // recurring, unlogged write failure here would look like theme
        // changes "work" every session but silently fail to survive a
        // reload or a different device, with nothing pointing at why.
        console.warn("[setTheme] DB persist failed:", e instanceof Error ? e.message : e);
      }
    })();
  }
}

/** The theme currently applied to the page. ThemeApplier has already resolved
 *  the account row → onboarding → fallback chain into <html data-theme>, so
 *  reading that attribute is the most accurate "what theme am I on right now". */
export function getCurrentTheme(): ThemeId {
  if (typeof window !== "undefined") {
    // coerceThemeId, not a raw cast: the DOM attribute and localStorage are
    // both untrusted sources by this file's own standard (see setTheme's
    // identical guard above) — a removed/renamed theme id left over from a
    // stale localStorage write shouldn't flow through as if it were valid.
    const applied = coerceThemeId(document.documentElement.getAttribute("data-theme"));
    if (applied) return applied;
    try {
      const saved = coerceThemeId(localStorage.getItem(THEME_KEY));
      if (saved) return saved;
    } catch {
      // ignore
    }
  }
  return "forest";
}
