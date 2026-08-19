"use client";

import { useEffect, useRef, useState } from "react";
import { THEMES } from "@/lib/themes";
import { chime, tap } from "@/lib/audio";
import { setTheme, getCurrentTheme } from "@/lib/theme";
import type { ThemeId } from "@/lib/types";

// alpha-drift-r16-01 (found+fixed 2026-08-07): the dropdown is a fixed
// w-64 (256px) panel positioned relative to this component's OWN wrapper,
// which sizes to the toggle button's content width -- it doesn't know
// where on the page that wrapper sits. `right-0` (grow leftward from the
// button) is correct when the wrapper sits near the viewport's RIGHT edge
// (app/inbox/page.tsx and app/inbox/[issueId]/page.tsx: last item in a
// right-aligned `justify-between` header) but wrong when it sits near the
// LEFT edge (app/settings/page.tsx: first item in a left-aligned row
// directly against the page's own padding) -- confirmed live on a real
// mobile viewport that ~30% of the panel, including the leading text of
// every theme's label and blurb, rendered off the left edge of the screen
// with no way to scroll to it. `align` lets each call site say which
// direction has room to grow; defaults to "right" (today's behavior,
// unchanged for both inbox placements) so only Settings needs to opt in.
export function ThemeSwitcher({ compact = false, align = "right" }: { compact?: boolean; align?: "left" | "right" }) {
  const [active, setActive] = useState<ThemeId>("forest");
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus choreography for the dropdown: move focus into the listbox (onto
  // the active option) when it opens, since neither toggleOpen nor pick()
  // moved focus anywhere before this -- a keyboard user had to tab forward
  // from the toggle with no way to jump straight into the option list.
  useEffect(() => {
    if (open) activeOptionRef.current?.focus();
  }, [open]);

  // alpha-drift-r18-01 (found+fixed 2026-08-07): Escape only worked while
  // focus stayed inside the panel (the onKeyDown below is scoped to the
  // panel div) -- a mouse user who opened this, then clicked anywhere else
  // on the page, got a dropdown that stayed open and visually detached from
  // whatever they were now doing, with no way to dismiss it except finding
  // the toggle button again. mousedown (not click) so the dismiss fires
  // before whatever the user clicked on handles its own click.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
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

  // alpha-drift-r27-08 (2026-08-14): the panel's onKeyDown used to intercept
  // ONLY Escape -- there was no Tab handling anywhere in this component (or
  // anywhere in the app), so a keyboard user who Tabbed from the last option
  // moved straight past the listbox into whatever comes next in DOM order,
  // while the panel (open state never flips false) kept rendering on top of
  // the page. The pointerdown-based outside-click dismiss below doesn't fire
  // for keyboard-only Tab-out either, since no click/mousedown occurs. Traps
  // Tab within the panel's own option buttons (its only focusable content):
  // Tab past the last option wraps to the first, Shift+Tab past the first
  // wraps to the last -- the standard listbox/menu focus-trap shape.
  function handlePanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const options = Array.from(panelRef.current.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    if (options.length === 0) return;
    const first = options[0];
    const last = options[options.length - 1];
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  }

  // Backstop for the trap above: if focus ever ends up outside the wrapper
  // while open anyway (a path the Tab-trap doesn't cover, e.g. a
  // programmatic focus change elsewhere on the page), close rather than
  // leave a stale panel floating over content the user's focus has already
  // left. Doesn't refocus the toggle -- unlike close() (an explicit
  // Escape/pick dismissal, where returning focus to the trigger is the
  // expected behavior), focus here is already moving somewhere else;
  // stealing it back would fight whatever just happened.
  //
  // alpha-drift-r28-01 (2026-08-15, self-audit): this used to also close on
  // `!next` (relatedTarget === null), on the assumption a null relatedTarget
  // meant focus left the wrapper entirely. Confirmed live in real Chrome
  // that's WRONG: relatedTarget is ALSO null whenever a mousedown lands on
  // any non-focusable element, even one squarely inside the wrapper (e.g.
  // the panel's own "CHOOSE A THEME" label div, which has no tabIndex) --
  // clicking it blurs the active option with relatedTarget null, so this
  // backstop was closing the dropdown on a plain click INSIDE the still-open
  // panel, contradicting the pointerdown outside-click handler below (which
  // correctly leaves it open for that exact click, since e.target is
  // contained in the wrapper). Tab can only blur onto another FOCUSABLE
  // element, so a legitimate Tab-escaping-the-trap case always has a real,
  // non-null relatedTarget -- there's no genuine "focus left the widget"
  // scenario this fix needs the null case to catch. Only closes now when
  // relatedTarget is a real Node outside the wrapper.
  function handleWrapperBlur(e: React.FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && !wrapperRef.current?.contains(next)) {
      setOpen(false);
    }
  }

  return (
    <div className="relative min-w-0 max-w-[13rem]" ref={wrapperRef} onBlur={open ? handleWrapperBlur : undefined}>
      {/* alpha-drift-r35-01 (2026-08-14, self-audit): r34-01 (below, kept for
          history) put min-w-0/overflow-hidden/text-ellipsis on the BUTTON,
          but the button was never the actual flex item -- THIS wrapper div
          is (it's the direct child of each call site's "flex items-center
          gap-2" row). min-width:0 on a plain block child does nothing; the
          wrapper just grew to the button's full natural width regardless,
          so the whole header ROW overflowed sideways on real 320-375px
          phones instead of the button wrapping -- worse than the original
          bug. Verified live in real Chrome, byte-for-byte replica of the
          real nested DOM at 320/375px with the app's actual longest labels
          ("Greenhouse" measures wider than "Neon Nights" with the real
          Inter font/classes): min-w-0 + max-w-[13rem] belongs on THIS
          wrapper (the real flex item), with the button below now w-full so
          it exactly fills whatever width flexbox resolves the wrapper to.
          That alone still wasn't enough -- min-w-0 also had to reach the
          call sites' own "flex items-center gap-2" container (added there,
          see app/inbox/page.tsx and app/inbox/[issueId]/page.tsx), since a
          flex item's shrink floor is governed by its own ancestor chain,
          not just this one link in it. Confirmed responsive, not just a
          fixed truncation: at 375px+ the fullest real label renders
          untruncated; only at genuinely tight widths (~320px) does it
          truncate, and the header row never overflows at any width tested.
          app/settings/page.tsx's ThemeSwitcher row already has its own
          flex-wrap and doesn't need this -- wrapping to a new line there is
          fine (it's page body, not a cramped sticky header). */}
      {/* alpha-drift-r34-01 (2026-08-14, superseded by r35-01 above): the
          original attempt -- kept only so a future round can see what was
          tried and why it looked right in isolation but wasn't. */}
      <button
        ref={toggleRef}
        type="button"
        onClick={toggleOpen}
        className="alpha-ui text-sm font-medium px-3 py-2.5 rounded-full border whitespace-nowrap overflow-hidden text-ellipsis w-full"
        style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {compact ? "Theme" : `Theme: ${labelFor(active)}`}
      </button>
      {open && (
        <div
          ref={panelRef}
          className={`absolute ${align === "left" ? "left-0" : "right-0"} mt-2 w-64 z-50 alpha-card overflow-hidden`}
          style={{ background: "var(--paper)" }}
          onKeyDown={handlePanelKeyDown}
        >
          <div id="theme-switcher-label" className="alpha-mono px-4 py-3 border-b" style={{ borderColor: "var(--rule)" }}>
            CHOOSE A THEME
          </div>
          <ul role="listbox" aria-labelledby="theme-switcher-label" className="max-h-80 overflow-auto">
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
