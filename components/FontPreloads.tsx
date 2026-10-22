"use client";

import { preload } from "react-dom";

// Exact Latin preloads from the completed Google-font build. Other subsets and
// theme families remain demand-loaded. React owns deduplication across renders.
const FONT_PRELOADS = [
  "/fonts/e4af272ccee01ff0-s.p.woff2", // Inter
  "/fonts/5611c55482296524-s.p.woff2", // Newsreader
  "/fonts/597b6a5d799c44de-s.p.woff2", // Source Serif 4
];

export function FontPreloads() {
  for (const href of FONT_PRELOADS) {
    preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  }
  return null;
}
