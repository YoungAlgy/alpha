"use client";

// alpha-drift-r55-04 (2026-08-20, hydrate-vs-live-edit-race-audit): shared
// module-scoped flag between lib/theme.ts's setTheme() and
// components/ThemeApplier.tsx's signed-in hydrate effect -- the same
// live-edit-wins-over-same-mount-hydrate pattern as app/topics/page.tsx's
// userEditedRef and app/theme/page.tsx's userPickedRef, but those are
// component-local useRefs and ThemeApplier/ThemeSwitcher/lib/theme.ts are
// separate component trees with no shared ref to reach for. Deliberately a
// standalone module with zero other imports: ThemeApplier avoids importing
// anything from lib/theme.ts or lib/supabase/client.ts at the top level (see
// ThemeApplier's own comment) because that pulls in the whole Supabase SDK
// for every route -- this file has to stay import-free to not reintroduce
// that bundle-size regression.
let editedThisLoad = false;

export function markThemeEditedThisLoad(): void {
  editedThisLoad = true;
}

export function themeEditedThisLoad(): boolean {
  return editedThisLoad;
}
