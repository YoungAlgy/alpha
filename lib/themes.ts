import type { Theme, ThemeId } from "./types";

export const THEMES: Theme[] = [
  {
    id: "soft",
    label: "Soft",
    blurb: "Butter cream and sage. The Alpha default.",
    fonts: { display: "var(--font-fraunces)", body: "var(--font-newsreader)", ui: "var(--font-dm-sans)" },
  },
  {
    id: "linen",
    label: "Linen",
    blurb: "Warm minimal. Cream paper, ink black, terracotta.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "ink",
    label: "Ink",
    blurb: "High contrast. Black, white, one red.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "cottage",
    label: "Cottage",
    blurb: "Botanical garden. Sage on cream.",
    fonts: { display: "var(--font-fraunces)", body: "var(--font-newsreader)", ui: "var(--font-dm-sans)" },
  },
  {
    id: "arcade",
    label: "Arcade",
    blurb: "Pixel newsstand. Kirby would subscribe.",
    fonts: { display: "var(--font-pixelify)", body: "var(--font-newsreader)", ui: "var(--font-dm-sans)" },
  },
  {
    id: "marina",
    label: "Marina",
    blurb: "Coastal soft. Sand and sky.",
    fonts: { display: "var(--font-fraunces)", body: "var(--font-newsreader)", ui: "var(--font-dm-sans)" },
  },
  {
    id: "midnight",
    label: "Midnight",
    blurb: "For night readers. Carbon and moonlight.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "forest",
    label: "Forest",
    blurb: "Woodsy quiet. Deep green and gold.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "mono",
    label: "Mono",
    blurb: "Pure minimalism. One red dot.",
    fonts: { display: "var(--font-inter)", body: "var(--font-inter)", ui: "var(--font-inter)" },
  },
  {
    id: "sunset",
    label: "Sunset",
    blurb: "Golden hour. Peach, ember, plum.",
    fonts: { display: "var(--font-fraunces)", body: "var(--font-newsreader)", ui: "var(--font-dm-sans)" },
  },
  {
    id: "mitch",
    label: "Money Mitch",
    blurb: "Black and champagne gold. The Money Mitch look.",
    fonts: { display: "var(--font-playfair)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
];

export const THEME_BY_ID: Record<ThemeId, Theme> = Object.fromEntries(
  THEMES.map((t) => [t.id, t])
) as Record<ThemeId, Theme>;

// The single allow-list check for a theme value coming from an untrusted source
// (a DB row, localStorage, a query param). Returns the ThemeId only if it's a
// real, catalogued theme, else null. Source every "apply the saved theme" gate
// from THIS — never a hand-maintained list of ids, which silently goes stale the
// next time a theme is added (the exact bug that shipped "mitch" as Forest on
// the emailed letter view).
export function coerceThemeId(raw: unknown): ThemeId | null {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(THEME_BY_ID, raw)
    ? (raw as ThemeId)
    : null;
}
