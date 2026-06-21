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
  // Preserved app looks. Each is the real palette of a Toggle or Ava app, from the
  // ones we sunset and the ones we merged, translated to a readable letter theme so
  // the look lives on here even after the app is gone. Harvested 2026-06-21.
  {
    id: "beacon",
    label: "Beacon Indigo",
    blurb: "Beacon's clean slate surface with its indigo accent and an amber beam for highlights.",
    fonts: { display: "var(--font-fraunces)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "grown-nearby",
    label: "Grown Nearby",
    blurb: "Warm cream paper, herb-green accent, a ripe-tomato pop. Reads like a farmers-market chalkboard.",
    fonts: { display: "var(--font-newsreader)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "freejob",
    label: "Free Job Post",
    blurb: "Clean white page, navy headlines, that bright Ava green. The look freejobpost runs now.",
    fonts: { display: "var(--font-inter)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "freeresume",
    label: "Free Resume",
    blurb: "Ava Health's clean navy and green on white, straight off the freeresumepost build.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "job-terminal",
    label: "Job Terminal",
    blurb: "Creamy white with a hot-pink anchor and a cyan kicker, lifted from the job-search dashboard.",
    fonts: { display: "var(--font-dm-sans)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "trading-terminal",
    label: "Trading Terminal",
    blurb: "Dark CRT terminal vibe. Near-black phosphor screen, neon cyan accent, text you can actually read.",
    fonts: { display: "var(--font-pixelify)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "downs",
    label: "Downs Almanac",
    blurb: "Parchment and walnut with brass gold and saloon red, like an old racing almanac from a tack room.",
    fonts: { display: "var(--font-playfair)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "fishing",
    label: "Fishing",
    blurb: "A vintage tide-almanac look. Warm cream paper, deep forest green, one muted gold, faint paper grain.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "mitchmark",
    label: "Mitchmark",
    blurb: "Nautical compass brand. Navy wordmark and cream face with a coral needle, set on warm parchment.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "studio",
    label: "Studio",
    blurb: "The music Studio's gold direction. Flat near-black with one warm amber gold, a console at night.",
    fonts: { display: "var(--font-dm-sans)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "pirate",
    label: "Pirate",
    blurb: "The old youngalgy nautical look. Weathered near-black, parchment text, oxblood and aged gold.",
    fonts: { display: "var(--font-playfair)", body: "var(--font-source-serif)", ui: "var(--font-inter)" },
  },
  {
    id: "miami",
    label: "Miami",
    blurb: "The old youngalgy Miami look. Near-black obsidian, hot neon pink, a cyan kicker. Bright and a little loud.",
    fonts: { display: "var(--font-bebas)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "toggletown",
    label: "Toggle Town",
    blurb: "The light Toggle Town look. Cream paper, forest-green ink, champagne gold.",
    fonts: { display: "var(--font-source-serif)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
  {
    id: "casino",
    label: "Casino",
    blurb: "One dark house. Obsidian page, warm cream type, champagne gold leads, a cool aqua thread for numbers.",
    fonts: { display: "var(--font-playfair)", body: "var(--font-newsreader)", ui: "var(--font-inter)" },
  },
];

export const THEME_BY_ID: Record<ThemeId, Theme> = Object.fromEntries(
  THEMES.map((t) => [t.id, t])
) as Record<ThemeId, Theme>;

// Display-only 3-color swatch per theme for the picker tiles + checkout preview.
// Single-sourced here (was copy-pasted into theme/page + checkout/page, which is
// exactly how a theme tile drifts and previews wrong). paper = --paper, ink =
// --ink, accent = --accent from the matching block in app/globals.css.
export const SWATCHES: Record<ThemeId, { paper: string; ink: string; accent: string }> = {
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
  mitch: { paper: "#0A0A0B", ink: "#ECE6D8", accent: "#D4B373" },
  beacon: { paper: "#FAFAFA", ink: "#0B0D12", accent: "#4F46E5" },
  "grown-nearby": { paper: "#FBF6EC", ink: "#2A2620", accent: "#2E6B43" },
  freejob: { paper: "#FFFFFF", ink: "#003D5C", accent: "#7FBC00" },
  freeresume: { paper: "#FFFFFF", ink: "#003D5C", accent: "#7FBC00" },
  "job-terminal": { paper: "#FCFCFC", ink: "#1B1221", accent: "#EE2B93" },
  "trading-terminal": { paper: "#080A11", ink: "#D6E8E6", accent: "#00E0E0" },
  downs: { paper: "#F4E8C1", ink: "#3A2818", accent: "#C19A44" },
  fishing: { paper: "#F4EFE0", ink: "#1F3D2E", accent: "#C9A961" },
  mitchmark: { paper: "#F5EFE6", ink: "#081828", accent: "#E2603F" },
  studio: { paper: "#0E0F13", ink: "#E8EAF0", accent: "#E0A33E" },
  pirate: { paper: "#0F0A08", ink: "#F0E6D2", accent: "#7A1F1F" },
  miami: { paper: "#0A0A0F", ink: "#F2EFE8", accent: "#FF2E93" },
  toggletown: { paper: "#F4EFE0", ink: "#1F3D2E", accent: "#C9A961" },
  casino: { paper: "#0A0A0A", ink: "#F5EFE6", accent: "#D4B373" },
};

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
