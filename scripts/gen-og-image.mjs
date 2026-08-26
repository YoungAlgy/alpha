// Generates the social share card at public/og-image.png (1200x630), the image
// shown when alpha.everyday.report is shared. Reproducible from code so it
// stays on-brand and on-cadence. Run: node scripts/gen-og-image.mjs
import sharp from "sharp";

const GREEN = "#1F3D2E"; // --ink
const GOLD = "#C9A961"; // --accent
const CREAM = "#F4EFE0"; // page bg
const SAGE = "#4A5F50"; // muted green (subhead)
const MUTE = "#6B7B70"; // footer
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const MONO = "'Courier New', monospace";

// alpha-drift-r78-02 (2026-08-21, duplicate-code-audit-r27): the mono
// footer used to bake in "YOUNGALGY.COM/ALPHA", the pre-2026-07-03-
// domain-move parent-site address -- stale since the move, this asset
// was never regenerated. Dropped the domain segment entirely rather
// than swapping in the new one (which visibly overruns the card's
// right margin at this font-size/letter-spacing), matching the same
// no-domain footer convention lib/email.ts's wordmarkFooter already
// uses ("alpha. dot A PERSONAL LETTER dot <year>").
const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${CREAM}"/>
  <text x="120" y="450" font-family="${SERIF}" font-weight="700" font-size="420" fill="${GREEN}">&#945;</text>
  <circle cx="395" cy="470" r="26" fill="${GOLD}"/>
  <text x="520" y="345" font-family="${SERIF}" font-weight="700" font-size="150" fill="${GREEN}">alpha<tspan fill="${GOLD}">.</tspan></text>
  <text x="524" y="425" font-family="${SERIF}" font-style="italic" font-size="46" fill="${SAGE}">your alpha.</text>
  <text x="524" y="545" font-family="${MONO}" font-size="22" letter-spacing="3" fill="${MUTE}">A PERSONAL LETTER</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile("public/og-image.png");
console.log("wrote public/og-image.png (1200x630)");
