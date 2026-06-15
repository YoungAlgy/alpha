"use client";

import { useEffect, useState } from "react";
import { THEMES } from "@/lib/themes";
import { chime, tap } from "@/lib/audio";
import { setTheme, getCurrentTheme } from "@/lib/theme";
import type { ThemeId } from "@/lib/types";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState<ThemeId>("forest");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Read the theme actually applied to the page (ThemeApplier has already
    // resolved the account row for signed-in users) — not a bare localStorage
    // key, which would show "forest" on a fresh device.
    setActive(getCurrentTheme());
    // Keep the label in sync when the theme is changed elsewhere (settings,
    // the /theme picker, another tab).
    function onChange(e: Event) {
      const detail = (e as CustomEvent<{ theme?: ThemeId }>).detail;
      if (detail?.theme) setActive(detail.theme);
    }
    window.addEventListener("alpha-theme-change", onChange);
    return () => window.removeEventListener("alpha-theme-change", onChange);
  }, []);

  function pick(id: ThemeId) {
    setActive(id);
    setTheme(id); // applies + persists everywhere (localStorage + account) + broadcasts
    setOpen(false);
    chime();
  }

  function toggleOpen() {
    setOpen((v) => !v);
    tap();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        className="alpha-ui text-sm font-medium px-3 py-1.5 rounded-full border"
        style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {compact ? "Theme" : `Theme: ${labelFor(active)}`}
      </button>
      {open && (
        <div
          className="absolute right-0 mt-2 w-64 z-50 alpha-card overflow-hidden"
          style={{ background: "var(--paper)" }}
        >
          <div className="alpha-mono px-4 py-3 border-b" style={{ borderColor: "var(--rule)" }}>
            CHOOSE A THEME
          </div>
          <ul role="listbox" className="max-h-80 overflow-auto">
            {THEMES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(t.id)}
                  className="w-full text-left px-4 py-3 alpha-ui text-sm hover:opacity-80 transition"
                  style={{
                    background: active === t.id ? "var(--callout-bg)" : "transparent",
                    color: "var(--ink)",
                  }}
                >
                  <div className="font-semibold">{t.label}</div>
                  <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    {t.blurb}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function labelFor(id: ThemeId): string {
  return THEMES.find((t) => t.id === id)?.label ?? "Forest";
}
