"use client";

import { useEffect, useState } from "react";
import { THEMES } from "@/lib/themes";
import type { ThemeId } from "@/lib/types";

const STORAGE_KEY = "alpha-theme";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState<ThemeId>("forest");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const saved = (typeof window !== "undefined" &&
      (localStorage.getItem(STORAGE_KEY) as ThemeId | null)) ||
      "forest";
    setActive(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);

  function pick(id: ThemeId) {
    setActive(id);
    document.documentElement.setAttribute("data-theme", id);
    localStorage.setItem(STORAGE_KEY, id);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
