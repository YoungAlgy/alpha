"use client";

import { useEffect, useRef, useState } from "react";
import { THEMES } from "@/lib/themes";
import { chime, tap } from "@/lib/audio";
import { setTheme, getCurrentTheme } from "@/lib/theme";
import type { ThemeId } from "@/lib/types";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState<ThemeId>("forest");
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);

  // Focus choreography for the dropdown: move focus into the listbox (onto
  // the active option) when it opens, since neither toggleOpen nor pick()
  // moved focus anywhere before this -- a keyboard user had to tab forward
  // from the toggle with no way to jump straight into the option list.
  useEffect(() => {
    if (open) activeOptionRef.current?.focus();
  }, [open]);

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
    // alpha-theme-change is same-tab only. Without a storage listener too, a
    // theme picked in Tab A correctly repaints Tab B's whole page (Theme
    // Applier already listens for storage), but Tab B's OWN switcher button
    // keeps showing the stale label until reload -- mirrors ThemeApplier's
    // own onStorage handler.
    function onStorage() {
      setActive(getCurrentTheme());
    }
    window.addEventListener("alpha-theme-change", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("alpha-theme-change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  function pick(id: ThemeId) {
    setActive(id);
    setTheme(id); // applies + persists everywhere (localStorage + account) + broadcasts
    setOpen(false);
    toggleRef.current?.focus();
    chime();
  }

  function toggleOpen() {
    setOpen((v) => !v);
    tap();
  }

  function close() {
    setOpen(false);
    toggleRef.current?.focus();
  }

  return (
    <div className="relative">
      <button
        ref={toggleRef}
        type="button"
        onClick={toggleOpen}
        className="alpha-ui text-sm font-medium px-3 py-2.5 rounded-full border"
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
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className="alpha-mono px-4 py-3 border-b" style={{ borderColor: "var(--rule)" }}>
            CHOOSE A THEME
          </div>
          <ul role="listbox" className="max-h-80 overflow-auto">
            {THEMES.map((t) => (
              <li key={t.id}>
                <button
                  ref={active === t.id ? activeOptionRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={active === t.id}
                  onClick={() => pick(t.id)}
                  className="w-full text-left px-4 py-3 alpha-ui text-sm hover:opacity-80 transition"
                  style={{
                    background: active === t.id ? "var(--callout-bg)" : "transparent",
                    color: "var(--ink)",
                  }}
                >
                  <div className="font-semibold">
                    {t.label}
                    {active === t.id ? " ✓" : ""}
                  </div>
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
