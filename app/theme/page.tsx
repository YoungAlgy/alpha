"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { THEMES } from "@/lib/themes";
import { chime, confirm } from "@/lib/audio";
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

  useEffect(() => {
    if (loaded && state.theme) setPicked(state.theme);
  }, [loaded, state.theme]);

  function pickTheme(id: ThemeId) {
    setPicked(id);
    chime();
  }

  function submit() {
    confirm();
    update({ theme: picked });
    router.push("/fun" as never);
  }

  const firstName = state.firstName || "Ally";

  return (
    <StepShell stepIndex={7} prevPath="topics">
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
                className="text-left rounded-lg transition-all overflow-hidden"
                style={{
                  border: `2px solid ${isPicked ? "var(--accent)" : "var(--rule)"}`,
                  background: sw.paper,
                  aspectRatio: "4 / 5",
                  cursor: "pointer",
                  boxShadow: isPicked ? "0 6px 16px rgba(0,0,0,0.10)" : undefined,
                }}
              >
                <div className="h-full p-3 flex flex-col justify-between">
                  <div>
                    <div className="text-[8px] tracking-widest" style={{ color: sw.ink, opacity: 0.5 }}>
                      SUNDAY · MAY 17
                    </div>
                    <div
                      className="text-base font-bold mt-2"
                      style={{
                        color: sw.ink,
                        fontFamily: t.id === "arcade" ? "var(--font-pixelify)" : "var(--font-display)",
                      }}
                    >
                      Hi {firstName},
                    </div>
                    <div
                      className="text-[8px] leading-snug mt-1"
                      style={{ color: sw.ink, opacity: 0.7 }}
                    >
                      Two things pulling at me this week — the recruiting...
                    </div>
                  </div>
                  <div className="flex items-end justify-between">
                    <div className="text-[10px] font-bold" style={{ color: sw.ink }}>
                      {t.label}
                    </div>
                    <div className="flex gap-0.5">
                      <span style={{ background: sw.paper, width: 6, height: 6, borderRadius: 1, border: `1px solid ${sw.ink}33` }} />
                      <span style={{ background: sw.ink, width: 6, height: 6, borderRadius: 1 }} />
                      <span style={{ background: sw.accent, width: 6, height: 6, borderRadius: 1 }} />
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
