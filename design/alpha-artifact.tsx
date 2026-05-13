// ────────────────────────────────────────────────────────────────
// Alpha — design artifact for claude.ai/design iteration
// Self-contained React + Tailwind. No external deps.
// Toggle: Landing ⇄ Sample letter.
// Digest reads as a friendly Sunday letter (NOT a newspaper).
// Brand: Soft Nostalgic. 10 user-switchable themes on the letter.
// ────────────────────────────────────────────────────────────────

import React, { useState } from "react";

type ThemeId =
  | "soft" | "linen" | "ink" | "cottage" | "arcade"
  | "marina" | "midnight" | "forest" | "mono" | "sunset";

const THEMES: { id: ThemeId; label: string; blurb: string; swatches: [string, string, string] }[] = [
  { id: "soft",     label: "Soft",     blurb: "Butter cream and sage. The Alpha default.",       swatches: ["#FBF6EC", "#3A2E26", "#F4A57D"] },
  { id: "linen",    label: "Linen",    blurb: "Warm minimal. Cream paper, terracotta accent.",    swatches: ["#FAF6EE", "#1A1A1A", "#C75D3F"] },
  { id: "ink",      label: "Ink",      blurb: "High contrast. Black, white, one red.",            swatches: ["#FFFFFF", "#000000", "#B3162F"] },
  { id: "cottage",  label: "Cottage",  blurb: "Botanical garden. Sage on cream.",                 swatches: ["#ECEEDA", "#3D3528", "#A86B4F"] },
  { id: "arcade",   label: "Arcade",   blurb: "Pixel newsstand. Kirby would subscribe.",          swatches: ["#FFF8E7", "#2D1E47", "#FF6B9D"] },
  { id: "marina",   label: "Marina",   blurb: "Coastal soft. Sand and sky.",                       swatches: ["#F4ECD8", "#2D3A4A", "#E89B6A"] },
  { id: "midnight", label: "Midnight", blurb: "For night readers. Carbon and moonlight.",         swatches: ["#0F1419", "#E8D5A8", "#7BA7D9"] },
  { id: "forest",   label: "Forest",   blurb: "Woodsy quiet. Deep green and gold.",                swatches: ["#F4EFE0", "#1F3D2E", "#C9A961"] },
  { id: "mono",     label: "Mono",     blurb: "Pure minimalism. One red dot.",                     swatches: ["#FFFFFF", "#000000", "#FF0000"] },
  { id: "sunset",   label: "Sunset",   blurb: "Golden hour. Peach, ember, plum.",                  swatches: ["#FAEBD7", "#5E3B5A", "#E87C3E"] },
];

const THEME_CSS = `
[data-theme="soft"]     { --paper:#FBF6EC; --paper-deep:#F2EBDA; --ink:#3A2E26; --ink-soft:#6B5448; --rule:#E5DBC6; --accent:#F4A57D; --accent-ink:#C7724A; --font-display:'Fraunces',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'DM Sans',system-ui,sans-serif; --radius:14px; }
[data-theme="linen"]    { --paper:#FAF6EE; --paper-deep:#F1EADB; --ink:#1A1A1A; --ink-soft:#5C544A; --rule:#E5DDCB; --accent:#C75D3F; --accent-ink:#A24527; --font-display:'Source Serif 4',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'Inter',system-ui,sans-serif; --radius:4px; }
[data-theme="ink"]      { --paper:#FFFFFF; --paper-deep:#F5F5F0; --ink:#000000; --ink-soft:#555555; --rule:#DDDDDD; --accent:#B3162F; --accent-ink:#B3162F; --font-display:'Source Serif 4',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'Inter',system-ui,sans-serif; --radius:0; }
[data-theme="cottage"]  { --paper:#ECEEDA; --paper-deep:#D4DCC4; --ink:#3D3528; --ink-soft:#6B5F4A; --rule:#C7D0B5; --accent:#A86B4F; --accent-ink:#8B5238; --font-display:'Fraunces',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'DM Sans',system-ui,sans-serif; --radius:12px; }
[data-theme="arcade"]   { --paper:#FFF8E7; --paper-deep:#FFEBC2; --ink:#2D1E47; --ink-soft:#5C4480; --rule:#FFB8DD; --accent:#FF6B9D; --accent-ink:#E04481; --font-display:'Pixelify Sans',monospace; --font-body:'Newsreader',Georgia,serif; --font-ui:'DM Sans',system-ui,sans-serif; --radius:4px; }
[data-theme="marina"]   { --paper:#F4ECD8; --paper-deep:#E8DCBE; --ink:#2D3A4A; --ink-soft:#5B6A7D; --rule:#C8D5DF; --accent:#E89B6A; --accent-ink:#C77C4A; --font-display:'Fraunces',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'DM Sans',system-ui,sans-serif; --radius:18px; }
[data-theme="midnight"] { --paper:#0F1419; --paper-deep:#1A2028; --ink:#E8D5A8; --ink-soft:#9DA8B5; --rule:#2A323D; --accent:#7BA7D9; --accent-ink:#A9C7E8; --font-display:'Source Serif 4',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'Inter',system-ui,sans-serif; --radius:6px; }
[data-theme="forest"]   { --paper:#F4EFE0; --paper-deep:#E5DEC8; --ink:#1F3D2E; --ink-soft:#4A5F50; --rule:#C8D0BC; --accent:#C9A961; --accent-ink:#A88947; --font-display:'Source Serif 4',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'Inter',system-ui,sans-serif; --radius:6px; }
[data-theme="mono"]     { --paper:#FFFFFF; --paper-deep:#F5F5F5; --ink:#000000; --ink-soft:#707070; --rule:#E5E5E5; --accent:#FF0000; --accent-ink:#FF0000; --font-display:'Inter',system-ui,sans-serif; --font-body:'Inter',system-ui,sans-serif; --font-ui:'Inter',system-ui,sans-serif; --radius:2px; }
[data-theme="sunset"]   { --paper:#FAEBD7; --paper-deep:#F5D9B5; --ink:#5E3B5A; --ink-soft:#8C6587; --rule:#E8C8AA; --accent:#E87C3E; --accent-ink:#C8612A; --font-display:'Fraunces',Georgia,serif; --font-body:'Newsreader',Georgia,serif; --font-ui:'DM Sans',system-ui,sans-serif; --radius:16px; }

.alpha-root    { background: var(--paper); color: var(--ink); min-height: 100vh; }
.alpha-display { font-family: var(--font-display); letter-spacing: -0.01em; }
.alpha-body    { font-family: var(--font-body); }
.alpha-ui      { font-family: var(--font-ui); }
.alpha-mono    { font-family: ui-monospace,'SF Mono',Menlo,monospace; font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; color: var(--ink-soft); }
.alpha-btn     { font-family: var(--font-ui); font-weight: 600; background: var(--ink); color: var(--paper); border-radius: var(--radius); padding: 0.95rem 1.75rem; display: inline-flex; align-items: center; gap: .5rem; transition: transform 120ms ease, box-shadow 120ms ease; cursor: pointer; border: none; }
.alpha-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
`;

const FONT_LINK =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..800;1,9..144,400..800&family=Newsreader:ital,wght@0,400..700;1,400..700&family=DM+Sans:wght@400..700&family=Source+Serif+4:ital,wght@0,400..700;1,400..700&family=Inter:wght@400..700&family=Pixelify+Sans:wght@400..700&display=swap";

const SAMPLE = {
  weekOf: "Sunday, May 17, 2026",
  firstName: "Ally",
  editor: "First drop of the new format. Three things this week — healthcare recruiting, sales psychology, and the Florida garden in May. The HCA Gainesville opening is past its 12-day mark and the credentialing wave is starting to show up in job boards. The Sanchez 1/9/90 frame keeps surfacing in operator threads. And the rain pattern this week tells you exactly when to plant. Plays inside.",
  sections: [
    {
      label: "Healthcare Recruiting",
      items: [
        { h: "HCA Gainesville — orbital practices are now hiring", b: "The hospital opened May 5; by week 2 the medical office buildings on the same campus are filing for staff. Three FL-licensed PA postings appeared on the 41st Boulevard cluster this week. The pattern repeats every HCA opening — orbital hires lag the main facility by 14–30 days.", s: "FierceHealthcare · Tampa Bay Business Journal" },
        { h: "OB supervisor rule — quiet demand surge", b: "CMS's new Conditions of Participation (effective Jan 1) requires labor and delivery supervised by a qualified RN, CNM, NP, PA, or physician. Florida hospitals are now filing for L&D supervisor postings at a rate ~3× last year. Nobody is sourcing this category yet.", s: "CMS rule 42 CFR 482.60" },
        { h: "Silver-medalist re-engagement is your highest ROI move", b: "Gem and Hireology both ship 'rediscovery' workflows that surface candidates who applied for a prior role and ghosted. Automating one re-touch on every cold-rejected candidate from the last 6 months returns more than any new sourcing tool you could buy this quarter.", s: "Affolter advisory" },
      ],
    },
    {
      label: "Sales & Persuasion",
      items: [
        { h: "Codie Sanchez — the 1% / 9% / 90% pricing pyramid", b: "The top 1% of buyers shop on pedigree, the next 9% shop on passion, the bottom 90% shop on price. The sweet spot for a new operator isn't the 1% (you can't beat them on resume) and isn't the 90% (race to the bottom). It's the 9% — buyers who pay premium for a compelling story.", s: "Diary of a CEO · May 2026 roundtable" },
        { h: "Jeb Blount — 'pipeline anemia' as the canonical diagnosis", b: "Blount's Fanatical Prospecting is having a renaissance — three operator podcasts cited 'pipeline anemia' this month. The phrase is becoming the standard diagnosis for underperforming sales orgs. Worth using on your own pipeline this Sunday.", s: "Fanatical Prospecting · Sales Gravy" },
        { h: "Name your buyer's segment before they do", b: "If you walk into a discovery call having already labeled the prospect ('you're a Type-B insurance-payer-mix system'), they spend the rest of the call validating or correcting your label. Either way, you control the framing.", s: "" },
      ],
    },
    {
      label: "Florida Gardening",
      items: [
        { h: "Plant asclepias before Friday", b: "The Tuesday-Wednesday dry window followed by sustained Thursday-Sunday rain creates ideal transplant conditions for native milkweed. Asclepias tuberosa and A. incarnata both transplant best when the rain is locked in for 72 hours after planting. Monarchs are mid-season; plants set this week feed October migration.", s: "UF/IFAS Extension Pinellas · NOAA Tampa Bay 7-day" },
        { h: "FL-Friendly Landscaping cost-share — May intake", b: "Pinellas County's FFL cost-share for converting turf to native pollinator garden has a quiet May intake window most homeowners miss. Reimburses up to $500 per converted area. Application is one page.", s: "Pinellas County Extension" },
        { h: "The 30-day mulch test for any new bed", b: "Pine straw vs. eucalyptus mulch is a real argument in Florida gardens. Test in your own yard: split a single bed in half with the two mulches, mark the date, photograph weekly. Thirty days tells you which one your soil actually likes — independent of what every gardening forum claims.", s: "" },
      ],
    },
  ],
};

export default function Alpha() {
  const [view, setView] = useState<"landing" | "letter">("landing");
  const [theme, setTheme] = useState<ThemeId>("forest");
  const [pickerOpen, setPickerOpen] = useState(false);
  const effectiveTheme: ThemeId = view === "landing" ? "forest" : theme;

  return (
    <>
      <link rel="stylesheet" href={FONT_LINK} />
      <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />

      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 bg-white border border-zinc-200 rounded-full shadow-sm px-1 py-1 flex gap-1 text-xs">
        <button onClick={() => setView("landing")} className={`px-3 py-1 rounded-full ${view === "landing" ? "bg-zinc-900 text-white" : "text-zinc-600"}`}>Landing</button>
        <button onClick={() => setView("letter")} className={`px-3 py-1 rounded-full ${view === "letter" ? "bg-zinc-900 text-white" : "text-zinc-600"}`}>Sample letter</button>
      </div>

      <div data-theme={effectiveTheme} className="alpha-root">
        {view === "landing" ? (
          <Landing />
        ) : (
          <Letter theme={theme} onPick={(t) => { setTheme(t); setPickerOpen(false); }} pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} />
        )}
      </div>
    </>
  );
}

function Landing() {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 flex items-center justify-between max-w-5xl mx-auto w-full">
        <span className="alpha-display text-2xl font-bold leading-none">
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </span>
        <span className="alpha-ui text-sm cursor-pointer" style={{ color: "var(--ink-soft)" }}>Sign in</span>
      </nav>

      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 pb-12">
        <div className="alpha-mono mb-10" style={{ color: "var(--accent-ink)" }}>A WEEKLY LETTER</div>
        <h1 className="alpha-display text-6xl md:text-8xl font-bold tracking-tight leading-[1.02] max-w-3xl">
          Your weekly{" "}
          <em style={{ color: "var(--accent-ink)", fontStyle: "italic" }}>alpha.</em>
        </h1>
        <p className="alpha-display text-xl md:text-2xl mt-8 max-w-xl leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          Pick five topics. Get a letter every Sunday on what actually matters. Five dollars a month.
        </p>
        <button className="alpha-btn mt-12 text-base">Start for $5 →</button>
        <p className="alpha-ui text-sm mt-4" style={{ color: "var(--ink-soft)" }}>$5/month · cancel anytime</p>
      </section>

      <footer className="px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-3 max-w-5xl mx-auto w-full alpha-mono" style={{ color: "var(--ink-soft)" }}>
        <div>ALPHA · 2026</div>
        <div className="flex gap-6 alpha-ui text-xs"><span>Privacy</span><span>Terms</span><span>Support</span></div>
      </footer>
    </main>
  );
}

function Letter({ theme, onPick, pickerOpen, setPickerOpen }: {
  theme: ThemeId; onPick: (t: ThemeId) => void; pickerOpen: boolean; setPickerOpen: (v: boolean) => void;
}) {
  return (
    <div className="alpha-body" style={{ color: "var(--ink)", lineHeight: 1.6 }}>
      <div className="sticky top-0 z-40" style={{ background: "var(--paper)" }}>
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="alpha-ui text-sm cursor-pointer" style={{ color: "var(--ink-soft)" }}>← Back</span>
          <div className="relative">
            <button onClick={() => setPickerOpen(!pickerOpen)} className="alpha-ui text-sm font-medium px-3 py-1.5 rounded-full border cursor-pointer" style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}>
              Theme: {THEMES.find((t) => t.id === theme)?.label}
            </button>
            {pickerOpen && (
              <div className="absolute right-0 mt-2 w-72 z-50 overflow-hidden" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--radius)" }}>
                <div className="alpha-mono px-4 py-3 border-b" style={{ borderColor: "var(--rule)" }}>CHOOSE A THEME</div>
                <ul className="max-h-80 overflow-auto">
                  {THEMES.map((t) => (
                    <li key={t.id}>
                      <button onClick={() => onPick(t.id)} className="w-full text-left px-4 py-3 alpha-ui text-sm flex items-center gap-3 cursor-pointer" style={{ background: theme === t.id ? "rgba(0,0,0,0.04)" : "transparent", color: "var(--ink)" }}>
                        <span className="flex gap-1">
                          {t.swatches.map((s, i) => <span key={i} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 999, background: s, border: "1px solid rgba(0,0,0,0.1)" }} />)}
                        </span>
                        <span>
                          <span className="font-semibold block">{t.label}</span>
                          <span className="text-xs block" style={{ color: "var(--ink-soft)" }}>{t.blurb}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      <article className="max-w-2xl mx-auto px-6 py-20 md:py-28">
        <div className="alpha-mono mb-14 text-center" style={{ color: "var(--ink-soft)" }}>{SAMPLE.weekOf}</div>
        <h1 className="alpha-display text-4xl md:text-5xl font-bold mb-6 tracking-tight">Hi {SAMPLE.firstName},</h1>
        <p className="alpha-display text-lg md:text-xl leading-relaxed mb-20">{SAMPLE.editor}</p>

        {SAMPLE.sections.map((section, i) => (
          <section key={i} className="mb-16">
            <div className="border-t mb-10" style={{ borderColor: "var(--rule)" }} />
            <h2 className="alpha-display text-3xl md:text-4xl font-bold mb-10 tracking-tight">{section.label}</h2>
            <div className="space-y-12">
              {section.items.map((item, k) => (
                <div key={k}>
                  <h3 className="alpha-display text-xl md:text-2xl font-semibold mb-3 leading-snug">{item.h}</h3>
                  <p className="text-base md:text-lg leading-relaxed">{item.b}</p>
                  {item.s && <div className="alpha-mono mt-4" style={{ color: "var(--ink-soft)" }}>{item.s}</div>}
                </div>
              ))}
            </div>
          </section>
        ))}

        <div className="border-t pt-12 mt-16" style={{ borderColor: "var(--rule)" }}>
          <p className="alpha-display text-xl italic mb-1" style={{ color: "var(--ink-soft)" }}>That's the drop. See you next Sunday.</p>
          <p className="alpha-display text-xl font-semibold">— Alpha</p>
        </div>
      </article>
    </div>
  );
}
