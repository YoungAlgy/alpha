# Alpha Brand Kit

The north star. Alpha's look is the house style. Fishing, Worksites, the Toggle hub,
trading, and youngalgy.com all match this. When in doubt, open Alpha and copy it.

Source of truth in code: `app/globals.css` (tokens + components), `lib/themes.ts`
(theme skins), `app/layout.tsx` (fonts), `public/favicon.svg` + `public/og-image.png`
+ `scripts/gen-og-image.mjs` (logo assets), `~/.claude/CLAUDE.md` (the writing voice).
This doc extracts those into one place. If code and doc ever disagree, the code wins,
then update the doc.

---

## 1. The feeling

Calm, editorial, premium, simple. A personal letter, not a feed. It reads like
something a thoughtful friend made by hand, on warm paper, with one good accent.
Lots of quiet. One idea at a time. Nothing shouts.

If a screen feels busy, loud, or generic-SaaS, it is off-brand. Strip it back.

---

## 2. Logo and wordmark

The mark is a lowercase Greek alpha, **α**. It stands for A for Algy and A for Alpha.
Do not redraw it, restyle it, or swap the glyph. Leave it alone.

- **The glyph:** the character `α` set in Source Serif 4, weight 700, in deep green
  (`--ink` #1F3D2E) on cream (`--paper` #F4EFE0).
- **The wordmark:** `alpha.` all lowercase, with the trailing period rendered in gold
  (`--accent` #C9A961). The gold dot is the signature. It is the period in "alpha."
  and it also sits at the foot of the big α on the social card.
- **Favicon / app icon:** `public/favicon.svg` is the α as text in the same serif.
  `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` are the α glyph plus the gold
  dot on cream.
- **Social card:** `public/og-image.png` (1200x630), regenerated from
  `scripts/gen-og-image.mjs` (sharp + SVG). Big α with the gold foot-dot, the wordmark
  `alpha.`, an italic sub-line, and a mono footer. Re-run the script to change it,
  never hand-edit the PNG.
- **Watermark:** a giant α at `font-size: 50vmin`, `opacity: 0.04`, behind the hero
  (`.alpha-watermark`). Use it sparingly as a faint background flourish.
- **Motion:** the hero wordmark "breathes" with a slow 1.2% scale loop
  (`.alpha-hero`, `alpha-wordmark-breathe`, 4800ms). Optional, signature on landings.

Wordmark rules: always lowercase `alpha.` with the gold period. The brand line is
`alpha. your alpha` (no cadence words baked in). Never "Alpha." in title case as the
logo, never without the dot.

---

## 3. Color

The canonical brand palette is **Forest**: warm cream paper, deep forest green ink,
one muted gold accent. This is the chrome other apps match. (Alpha also ships a
reader-selectable theme system for the letter body, see section 9. The chrome and
identity stay Forest.)

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#F4EFE0` | page background (warm cream) |
| `--paper-deep` | `#E5DEC8` | raised/inset surfaces, chips, kbd |
| `--ink` | `#1F3D2E` | text + primary buttons (deep forest green) |
| `--ink-soft` | `#4A5F50` | secondary text, captions |
| `--rule` | `#C8D0BC` | borders, dividers |
| `--accent` | `#C9A961` | the gold. dots, accent buttons, selection, focus |
| `--accent-ink` | `#A88947` | darker gold for accent text on cream |
| `--accent-2` | `#1F3D2E` | secondary accent (green in Forest) |
| `--callout-bg` | `#C9A9611F` | accent at ~12% alpha, callout fills |
| `--quote-bar` | `#1F3D2E` | blockquote left bar |

Usage rules:
- One accent per surface. Gold carries attention. Green is structure and text.
- Text on a gold/accent fill uses the darker gold (`--accent-ink`), never black.
- Selection is gold on cream (`::selection { background: var(--accent); color: var(--paper) }`).
- Never introduce a second bright color into the chrome. The whole effect is
  cream + green + one gold.

---

## 4. Typography

Three roles, three fonts (all Google Fonts, latin, weights 400 to 700):

| Role | CSS var | Forest font | Use |
|---|---|---|---|
| Display | `--font-display` | **Source Serif 4** | headlines, the wordmark, big numbers |
| Body | `--font-body` | **Newsreader** | the letter / long-form reading |
| UI | `--font-ui` | **Inter** | buttons, labels, nav, app chrome |
| Mono | (stack) | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo` | eyebrow labels, timestamps, kbd |

Helper classes (from `globals.css`):
- `.alpha-display` — display serif, `letter-spacing: -0.01em`. Headlines.
- `.alpha-body` — body serif (Newsreader), `line-height: 1.6`. Reading.
- `.alpha-ui` — UI sans (Inter). Everything interface.
- `.alpha-mono` — uppercase mono caps, `font-size: 0.72rem`, `letter-spacing: 0.12em`,
  color `--ink-soft`. The "eyebrow" label treatment.
- `.alpha-stamp` — italic display serif in `--accent-ink`. Editorial flourish.
- `.alpha-editor-intro::first-letter` — drop cap: 3.2em display serif, gold, floated.

Signature treatments:
- Section eyebrows are small letterspaced mono caps (`HOW IT WORKS`, `THIS ISSUE`),
  not bold headings.
- Sentence case everywhere. Never Title Case, never ALL CAPS except the mono eyebrows.
- Body font features `ss01`, `ss02` are on (`font-feature-settings` on `body`).

---

## 5. Shape and depth

Quiet and flat. Depth is a hint, never a drop-shadow showpiece.

- Radius (Forest): `--radius: 6px` (buttons, inputs, callouts), `--radius-card: 8px` (cards).
- Borders: `1px solid var(--rule)` on cards; `1.5px` for selected/active states in gold.
- Shadow (Forest): `--shadow-card: 0 1px 0 rgba(31,61,46,0.06)`. Barely there.
- Hover lift: `translateY(-1px)` with a soft `0 6px 18px rgba(0,0,0,0.07-0.08)` shadow.
  Cards and buttons rise a hair on hover, nothing more.

---

## 6. Components

Recipes pulled straight from `globals.css`. Reuse these names.

- **Primary button** `.alpha-button`: green (`--ink`) fill, cream text, `--radius`,
  padding `0.875rem 1.5rem`, Inter 600. Hover lifts 1px.
- **Accent button** `.alpha-button-accent`: same shape, gold (`--accent`) fill. The
  one "do this" action per screen.
- **Card** `.alpha-card`: cream fill, `1px --rule` border, `--radius-card`, `--shadow-card`.
- **Topic / selectable card** `.topic-card`: transparent until picked, then
  `--callout-bg` fill + `1.5px --accent` border + a soft gold glow
  (`0 4px 14px rgba(201,169,97,0.18)`). The tactile pick pattern.
- **Chip / pill:** `rounded-full`, `1.5px` border, transparent or `--callout-bg` when
  selected, with a gold `✓`. Used for sub-genres and custom topics.
- **Callout box** `.alpha-callout-box`: `--callout-bg` fill, `border-left: 2px --accent`,
  `--radius`. For asides.
- **Callout tag** `.alpha-callout-tag`: tiny letterspaced mono caps in `--accent-ink`,
  bold, `letter-spacing: 0.28em`. The `PLAY · WATCH · APPLY` eyebrow style.
- **Quote** `.alpha-quote`: `border-left: 3px var(--quote-bar)`, italic, `--ink-soft`.
- **Focus rings:** inputs get a gold border + `0 1px 0 var(--accent)`; buttons/links get
  `2px solid var(--accent)` outline, `3px` offset. Accent-colored, on-brand, accessible.
- **Kbd hint** `.alpha-kbd` / `.alpha-kbd-hint`: small mono key chip on `--paper-deep`.

---

## 7. Motion and sound

- **Transitions:** `260ms ease` on background/color/border/shadow across all chrome
  (so theme switches and hovers feel smooth, never snap).
- **Entrances:** `.alpha-step-enter` fades + rises 8px over 380ms (onboarding steps).
- **Breathe:** the hero wordmark scale loop (section 2).
- **Sound (optional, tactile):** `lib/audio.ts` exposes `tap`, `confirm`, `chime`,
  `unselect`, `stepDone`, `fanfare` (Web Audio, gated by a user toggle, off by default
  feel). Soft, short, woody. Use for picks and confirmations, never for ambient noise.

The whole motion language is "settle," not "pop." Small, slow, calm.

---

## 8. Voice (writing)

This is as much the brand as the color. Hard rules, always on for anything a reader,
customer, or the public sees. Canonical copy: `~/.claude/CLAUDE.md`. Enforced in the
generation prompts (`lib/engine/topic-blurb.ts`, `editor-note.ts`).

Write like a plain-spoken person, never like AI:
- Open with the point. Short, plain, declarative sentences. One idea each.
- Everyday words. No thesaurus words (leverage, navigate, elevate, foster, robust,
  seamless, delve, ensure, comprehensive, utilize, landscape, realm).
- No em dashes or en dashes. Use periods and commas. No semicolons.
- Straight quotes only. No curly quotes, no tilde, no symbols people do not type.
- No "X, not Y." No "whether you are X or Y." No rule-of-three, no perfectly balanced lists.
- Honest and matter-of-fact. A little imperfect is fine. Do not over-polish.
- Read it out loud. If it sounds like a real person, it is right.

---

## 9. The theme system (Alpha-specific, optional)

Alpha lets a reader re-skin the letter body via `<html data-theme="...">`. Ten skins
in `lib/themes.ts` (soft, linen, ink, cottage, arcade, marina, midnight, forest, mono,
sunset), each overriding the same token set (palette, fonts, radius, shadow). The
default chrome and identity are **Forest**.

Other apps do NOT need the theme system. They match the **Forest** tokens (sections 3
to 7) as their single house style. Adopt the theming machinery only if an app genuinely
wants reader-selectable skins.

---

## 10. Drop-in starter (for the other apps)

Paste this to match Alpha fast. Forest tokens + the core type/components.

```css
:root {
  --paper: #F4EFE0;
  --paper-deep: #E5DEC8;
  --ink: #1F3D2E;
  --ink-soft: #4A5F50;
  --rule: #C8D0BC;
  --accent: #C9A961;
  --accent-ink: #A88947;
  --callout-bg: #C9A9611F;
  --radius: 6px;
  --radius-card: 8px;
  --shadow-card: 0 1px 0 rgba(31, 61, 46, 0.06);
  /* fonts: load Source Serif 4 (display), Newsreader (body), Inter (ui) */
  --font-display: "Source Serif 4", Georgia, serif;
  --font-body: "Newsreader", Georgia, serif;
  --font-ui: "Inter", system-ui, sans-serif;
}
html, body { background: var(--paper); color: var(--ink); font-family: var(--font-ui), system-ui, sans-serif; }
::selection { background: var(--accent); color: var(--paper); }

.alpha-display { font-family: var(--font-display); letter-spacing: -0.01em; }
.alpha-mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); }
.alpha-card { background: var(--paper); border: 1px solid var(--rule); border-radius: var(--radius-card); box-shadow: var(--shadow-card); }
.alpha-button { font-family: var(--font-ui); font-weight: 600; background: var(--ink); color: var(--paper); border-radius: var(--radius); padding: 0.875rem 1.5rem; }
.alpha-button-accent { background: var(--accent); color: var(--paper); }
```

Fonts via Google Fonts: Source Serif 4, Newsreader, Inter, weights 400 to 700, latin.

---

## 11. How each app applies it

- **youngalgy.com** — Alpha is the in-house standard, so the portfolio should read like
  the same person made it: cream, green, gold, the serif display, sentence case, the
  voice. The α can nod to the portfolio without copying it.
- **Toggle hub** — Alpha is in the everything-bundle and reachable at `toggle.town/news`.
  The hub's listing for Alpha uses the Forest palette and the α mark. Toggle's own
  "endorsed house" chrome should not fight Alpha's; keep Alpha's card on-brand.
- **Fishing (Bay Bite), Worksites, Trading** — adopt the Forest tokens and the
  type/component recipes as the base skin. Keep each app's function, but the surfaces,
  buttons, cards, eyebrows, and voice match Alpha. One gold accent, calm motion,
  plain copy.

Match the feeling first (calm, editorial, one accent, plain voice), then the tokens.
