"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { THEMES } from "@/lib/themes";
import { chime, confirm } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import type { ThemeId } from "@/lib/types";

// Display-only swatch for each theme. Matches the palette in globals.css.
const SWATCHES: Record<ThemeId, { paper: string; ink: string; accent: string }> = {
  soft: { paper: "#FBF6EC", ink: "#3A2E26", accent: "#F4A57D" },
  linen: { paper: "#FAF6EE", ink: "#1A1A1A", accent: "#C75D3F" },
  ink: { paper: "#FFFFFF", ink: "#000000", accent: "#B3162F" },
  cottage: { paper: "#ECEEDA", ink: "#3D3528", accent: "#A86B4F" },
  arcade: { paper: "#FFF8E7", ink: "#2D1E47", accent: "#FF6B9D" },
  marina: { paper: "#F4ECD8", ink: "#2D3A4A", accent: "#E89B6A" },
  midnight: { paper: "#0F1419", ink: "#E8D5A8", accent: "#7BA7D9" },
  forest: { paper: "#F4EFE0", ink: "#1F3D2E", accent: "#C9A961" },
  mono: { paper: "#FFFFFF", ink: "#000000", accent: "#FF0000" },
  sunset: { paper: "#FAEBD7", ink: "#5E3B5A", accent: "#E87C3E" },
};

export default function ThemePage() {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();
  const [picked, setPicked] = useState<ThemeId>("forest");
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    if (loaded && state.theme) setPicked(state.theme);
  }, [loaded, state.theme]);

  // Detect whether this is a signed-in user editing their theme (vs a new
  // user going through onboarding) — they should return to /settings on submit.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (session) setSignedIn(true);
      } catch {
        // ignore
      }
    })();
  }, []);

  function pickTheme(id: ThemeId) {
    setPicked(id);
    chime();
    // Broadcast so ThemeApplier re-paints the page immediately.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("alpha-theme-change", { detail: { theme: id } })
      );
    }
  }

  function hoverTheme() {
    // Soft hover audio preview — same chime as select, just quieter via tone.
    chime();
  }

  async function submit() {
    confirm();
    update({ theme: picked });
    // Signed-in user editing settings → persist to DB and return to /settings.
    // New user in onboarding funnel → continue to /fun.
    if (signedIn && supabaseConfigured()) {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user) {
          await sb.from("users").update({ theme: picked }).eq("id", user.id);
        }
      } catch {
        // best-effort — onboarding-state update already happened
      }
      router.push("/settings" as never);
      return;
    }
    router.push("/name" as never);
  }

  const firstName = state.firstName || "friend";

  return (
    <StepShell stepIndex={2} prevPath="welcome">
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
                <div className="h-full p-3 flex flex-col">
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
                    Two things pulling at me this week. The recruiting signals feel unusually live right now…
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
          <button type="button" onClick={submit} className="alpha-button">
            Continue →
          </button>
        </div>
      </div>
    </StepShell>
  );
}
