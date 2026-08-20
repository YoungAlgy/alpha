"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { THEMES, SWATCHES, coerceThemeId } from "@/lib/themes";
import { chime, confirm } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { setTheme } from "@/lib/theme";
import type { ThemeId } from "@/lib/types";

// Theme preview swatches live in lib/themes.ts (SWATCHES) so they stay in sync
// with the THEMES list and globals.css. Don't re-add a local copy here.

export default function ThemePage() {
  const router = useRouter();
  const { state, loaded } = useOnboarding();
  const [picked, setPicked] = useState<ThemeId>("forest");
  const [signedIn, setSignedIn] = useState(false);
  // alpha-drift-r19-01 (found+fixed 2026-08-07): the signed-in hydrate below
  // is a real network round trip with no loading gate anywhere in the
  // render -- Continue's submit() ran unconditionally, so a signed-in
  // reader who clicks it before that round trip resolves gets `picked`
  // still at its "forest" default AND `signedIn` still false, silently
  // overwriting their real saved theme (of ~9 options) with the default and
  // routing them into onboarding's /name step instead of back to /settings.
  // Starts true only when there's no hydrate to wait for at all
  // (supabaseConfigured() false — this is a pure onboarding-localStorage
  // flow with nothing async to race).
  const [themeHydrated, setThemeHydrated] = useState(!supabaseConfigured());
  // alpha-drift-r54-03 (2026-08-20, accessibility-resweep-newer-code-round-2):
  // pickTheme() applies a tap immediately and unconditionally (localStorage,
  // DOM data-theme, an async DB write) with no gate on themeHydrated. The
  // signed-in hydrate effect below is a separate, independent network round
  // trip already in flight from mount -- if it resolves AFTER a user's tap,
  // its own unconditional setPicked(dbTheme) silently reverted the tapped
  // selection back to the stale saved theme in React state (even though the
  // page had already visually repainted to the new pick), and a subsequent
  // Continue click would re-persist the stale reverted value. Set true the
  // first time the user taps a tile; the hydrate effect then skips its own
  // setPicked() once this is set, so a live tap always wins over a
  // same-mount hydrate response that merely started before it.
  const userPickedRef = useRef(false);

  useEffect(() => {
    if (loaded && state.theme) {
      const safe = coerceThemeId(state.theme);
      if (safe) setPicked(safe);
    }
  }, [loaded, state.theme]);

  // Detect whether this is a signed-in user editing their theme (vs a new
  // user going through onboarding) — they should return to /settings on submit.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (cancelled) return;
        if (!session) return;
        setSignedIn(true);
        // Note: intentionally set BEFORE the row fetch below, not after —
        // signedIn's only job here is choosing submit()'s redirect target
        // (/settings vs /name), and that decision is already correct the
        // instant we know a session exists, independent of whether the
        // theme row fetch that follows succeeds.
        // Hydrate `picked` from the DB (the source of truth) for a signed-in
        // reader. Without this, a returning subscriber on a fresh device —
        // where localStorage is empty so `picked` is still the "forest"
        // default — would CLOBBER their real saved theme back to the default
        // the moment they tap a tile or Continue (pickTheme/submit call
        // setTheme(picked)). Same empty/default-overwrites-real-DB class as
        // the user-sync.ts fix; this closes the sibling write-path.
        // alpha-drift-r62-06: this destructure used to discard `error` --
        // supabase-js resolves rather than throws on a query error, so the
        // catch below (whose own comment claims "logged, not silent") was
        // structurally blind to the exact failure mode it exists to catch.
        // Logged only -- doesn't itself stop the clobber described above,
        // just makes a silent one visible.
        const { data: row, error: rowErr } = await sb
          .from("users")
          .select("theme")
          .eq("id", session.user.id)
          .maybeSingle();
        if (rowErr) console.warn("[theme] signed-in hydrate row fetch failed:", rowErr.message);
        if (cancelled) return;
        const dbTheme = row?.theme as ThemeId | null | undefined;
        // alpha-drift-r54-03: don't let a late-resolving hydrate revert a
        // pick the user already made this session -- see userPickedRef's
        // own comment.
        if (dbTheme && dbTheme in SWATCHES && !userPickedRef.current) setPicked(dbTheme);
      } catch (e) {
        // Logged, not silent: this hydrate exists specifically to stop a
        // returning subscriber's real saved theme from getting clobbered
        // back to "forest" (see the comment above) -- a swallowed failure
        // here lets that exact regression resurface with no trace.
        console.warn("[theme] signed-in hydrate failed:", e instanceof Error ? e.message : e);
      } finally {
        // Unconditional: reached whether a session existed, the row fetch
        // succeeded, or it threw -- every one of those is "we now know
        // everything we're going to know," so Continue is safe from here.
        if (!cancelled) setThemeHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function pickTheme(id: ThemeId) {
    userPickedRef.current = true;
    setPicked(id);
    // Apply + persist (account + localStorage) + broadcast immediately, so the
    // pick sticks the moment you tap it — no "Continue" required to save.
    setTheme(id);
    chime();
  }

  function hoverTheme() {
    // Soft hover audio preview — same chime as select, just quieter via tone.
    chime();
  }

  function submit() {
    // themeHydrated gate: see its own comment on the state declaration
    // above (alpha-drift-r19-01) -- without it this could fire with
    // `picked`/`signedIn` still at their pre-hydrate defaults.
    if (!themeHydrated) return;
    confirm();
    // Guarantee the final pick is saved (idempotent if pickTheme already did).
    setTheme(picked);
    // Signed-in user editing settings → back to /settings. New user in the
    // onboarding funnel → continue to /name.
    router.push((signedIn ? "/settings" : "/name") as never);
  }

  const firstName = state.firstName || "friend";

  return (
    <StepShell stepIndex={2} prevPath={signedIn ? "settings" : "welcome"}>
      <div className="space-y-8">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            Pick the look that feels like you.
          </h1>
          <p
            className="alpha-ui text-sm md:text-base"
            style={{ color: "var(--ink-soft)" }}
          >
            Same content, your vibe. Change anytime.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {THEMES.map((t) => {
            const sw = SWATCHES[t.id];
            const isPicked = picked === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={isPicked}
                aria-label={`${t.label} theme${isPicked ? ", selected" : ""}`}
                onClick={() => pickTheme(t.id)}
                onMouseEnter={() => isPicked || hoverTheme()}
                className="text-left rounded-lg transition-all overflow-hidden theme-tile"
                style={{
                  border: `2px solid ${isPicked ? "var(--accent)" : "var(--rule)"}`,
                  background: sw.paper,
                  aspectRatio: "4 / 5",
                  cursor: "pointer",
                  boxShadow: isPicked
                    ? `0 8px 24px ${sw.accent}40`
                    : undefined,
                  transform: isPicked ? "translateY(-2px)" : undefined,
                }}
              >
                {/* Purely decorative letter-preview mockup — the button's own
                    aria-label above is the real accessible name, so this
                    entire block (fake date/greeting/body copy/swatch dots)
                    is hidden from screen readers instead of being read as a
                    wall of text on every one of the ~9 theme options. */}
                <div className="h-full p-3 flex flex-col" aria-hidden="true">
                  <div
                    className="text-[7px] tracking-[0.16em] mb-1.5"
                    style={{ color: sw.ink, opacity: 0.45 }}
                  >
                    SUNDAY · MAY 17
                  </div>
                  <div
                    className="text-[15px] font-bold mb-1"
                    style={{
                      color: sw.ink,
                      fontFamily:
                        t.id === "arcade"
                          ? "var(--font-pixelify)"
                          : "var(--font-display)",
                      letterSpacing: "-0.01em",
                      lineHeight: 1.1,
                    }}
                  >
                    Hi {firstName},
                  </div>
                  <div
                    className="text-[7.5px] leading-snug mt-0.5 line-clamp-2"
                    style={{ color: sw.ink, opacity: 0.65 }}
                  >
                    Two things pulling at me today. The recruiting signals feel unusually live right now…
                  </div>
                  <div
                    className="my-2"
                    style={{
                      height: 1,
                      background: sw.ink,
                      opacity: 0.15,
                    }}
                  />
                  <div
                    className="text-[9px] font-bold"
                    style={{
                      color: sw.ink,
                      fontFamily:
                        t.id === "arcade"
                          ? "var(--font-pixelify)"
                          : "var(--font-display)",
                    }}
                  >
                    Healthcare recruiting
                  </div>
                  <div
                    className="text-[7px] mt-1 leading-snug line-clamp-2"
                    style={{ color: sw.ink, opacity: 0.7 }}
                  >
                    Florida L&D supervisor postings are up 3x…
                  </div>
                  <div className="flex-1" />
                  <div className="flex items-end justify-between mt-2">
                    <div
                      className="text-[10px] font-semibold"
                      style={{ color: sw.ink }}
                    >
                      {t.label}
                    </div>
                    <div className="flex gap-0.5">
                      <span style={{ background: sw.paper, width: 7, height: 7, borderRadius: 2, border: `1px solid ${sw.ink}33` }} />
                      <span style={{ background: sw.ink, width: 7, height: 7, borderRadius: 2 }} />
                      <span style={{ background: sw.accent, width: 7, height: 7, borderRadius: 2 }} />
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-4 pt-4">
          <span
            className="alpha-ui text-sm"
            style={{ color: "var(--ink-soft)" }}
          >
            Picked: <span style={{ color: "var(--ink)" }}>{THEMES.find(t => t.id === picked)?.label}</span>
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={!themeHydrated}
            className="alpha-button"
            style={{ opacity: themeHydrated ? 1 : 0.5, cursor: themeHydrated ? "pointer" : "not-allowed" }}
          >
            Continue →
          </button>
        </div>
      </div>
    </StepShell>
  );
}
