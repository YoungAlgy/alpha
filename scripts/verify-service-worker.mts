// Verify round 22 finding (alpha-drift-r22-01, 2026-08-14, MEDIUM):
// public/manifest.json declares display:"standalone" (an installable app)
// and components/InstallPrompt.tsx actively invites readers to add it to
// their home screen, but no service worker existed anywhere -- a
// standalone-mode PWA with a flaky connection just showed the platform's
// bare, unbranded network-error page.
//
// Fixed with a DELIBERATELY minimal, non-caching service worker
// (public/sw.js): it precaches exactly one static file (offline.html) and
// intercepts ONLY navigation requests, falling back to that page on a
// failed network fetch. Every other request type (API calls, JS/CSS,
// images) is left completely untouched -- this app's core promise is a
// genuinely fresh letter every day, so a real caching strategy here would
// risk silently serving stale content, which is a materially worse outcome
// than the missing-offline-page gap this fix closes.
//
// Registration is a tiny client component (source-level check only --
// jsdom/no real browser here to register a service worker against); the
// SW's own logic is checked directly since public/sw.js runs unbundled,
// unminified, exactly as shipped.
// Run: npx tsx scripts/verify-service-worker.mts
import { readFileSync, existsSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) public/sw.js exists and is well-formed");
{
  const swPath = new URL("../public/sw.js", import.meta.url);
  check("(1a) public/sw.js exists", existsSync(swPath));
  const sw = readFileSync(swPath, "utf8");
  check("(1b) precaches offline.html on install", /caches\.open\(CACHE_NAME\)\.then\(\(cache\) => cache\.add\(OFFLINE_URL\)\)/.test(sw));
  check("(1c) OFFLINE_URL points at the real file", /const OFFLINE_URL = "\/offline\.html";/.test(sw));
  check("(1d) old-cache cleanup on activate (a future content change can't leak old caches forever)", /caches\.keys\(\)\.then\(\(keys\) =>/.test(sw));

  console.log("(2) the fetch handler ONLY intercepts navigation requests -- the core safety property of this fix");
  check("(2a) mode !== 'navigate' returns early, before any respondWith", /if \(event\.request\.mode !== "navigate"\) return;/.test(sw));
  // The early-return must appear BEFORE respondWith in source order, or a
  // non-navigation request could still fall through to interception.
  const modeCheckIdx = sw.indexOf('if (event.request.mode !== "navigate") return;');
  const respondWithIdx = sw.indexOf("event.respondWith(");
  check("(2b) the navigate-only guard is positioned before respondWith(), not after", modeCheckIdx > -1 && respondWithIdx > -1 && modeCheckIdx < respondWithIdx);

  console.log("(3) no runtime CACHING of live responses -- this SW must never be able to serve stale app content");
  // The only two cache.* writes anywhere in the file should be the one-time
  // install-time precache and the activate-time cleanup delete -- never a
  // cache.put() of a live fetch() response, which is what would introduce
  // staleness risk.
  check("(3a) zero cache.put( calls anywhere in the file", !/cache\.put\(/.test(sw));
  check("(3b) exactly one cache.add( call (the one-time offline.html precache)", (sw.match(/cache\.add\(/g) ?? []).length === 1);
  check("(3c) the fetch handler's network path has no cache write on success, only a catch-fallback on failure", /fetch\(event\.request\)\.catch\(\(\) =>/.test(sw));
}

console.log("(4) public/offline.html exists and is self-contained (no external asset/font/API dependency that could itself fail while offline)");
{
  const htmlPath = new URL("../public/offline.html", import.meta.url);
  check("(4a) public/offline.html exists", existsSync(htmlPath));
  const html = readFileSync(htmlPath, "utf8");
  check("(4b) no external stylesheet/script/font links (must render with zero network access)", !/<link[^>]+href="https?:\/\//.test(html) && !/<script[^>]+src="https?:\/\//.test(html));
  check("(4c) marked noindex (this is a fallback shell, not a real indexable page)", /<meta name="robots" content="noindex" \/>/.test(html));
  check("(4d) offers a real way to retry, not a dead end", /onclick="location\.reload\(\)"/.test(html));
}

console.log("(5) registration is wired into the root layout, mounted app-wide like ThemeApplier");
{
  const regPath = new URL("../components/ServiceWorkerRegister.tsx", import.meta.url);
  check("(5a) components/ServiceWorkerRegister.tsx exists", existsSync(regPath));
  const reg = readFileSync(regPath, "utf8");
  check("(5b) registers exactly /sw.js", /navigator\.serviceWorker\.register\("\/sw\.js"\)/.test(reg));
  check("(5c) feature-detects serviceWorker support before touching it (older/unsupported browsers must not throw)", /if \(!\("serviceWorker" in navigator\)\) return;/.test(reg));
  check("(5d) registration failure is caught, not left to throw unhandled", /\.catch\(\(\) => \{/.test(reg));

  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  check("(5e) ServiceWorkerRegister is imported in the root layout", /import \{ ServiceWorkerRegister \} from "@\/components\/ServiceWorkerRegister";/.test(layout));
  check("(5f) ServiceWorkerRegister is actually mounted in the JSX (imported but unmounted would be dead code)", /<ServiceWorkerRegister \/>/.test(layout));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SERVICE-WORKER VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SERVICE-WORKER ASSERTIONS PASS");
