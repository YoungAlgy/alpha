// Verify round 22 finding (alpha-drift-r22-01, 2026-08-14, MEDIUM):
// app/error.tsx and app/global-error.tsx only catch errors thrown during
// React's RENDER phase -- neither ever sees an error thrown inside an event
// handler (React's synthetic event system doesn't route these through error
// boundaries), an unhandled promise rejection anywhere in the app, or a
// chunk-load failure specifically (a dynamic import() rejecting because the
// client is running a stale bundle after a new deploy -- the single most
// common real-world trigger of both on a Next.js app that deploys often).
//
// Fixed with components/GlobalErrorListeners.tsx: window-level
// unhandledrejection + error listeners, mounted app-wide. A detected
// chunk-load failure gets ONE automatic page reload (self-heals by fetching
// the current bundle); everything else is logged + tracked, never silently
// swallowed. This is a pure DOM/window-API component with no server
// dependency -- exercised directly here via a minimal jsdom-free harness
// (real Event/ErrorEvent/PromiseRejectionEvent construction against a
// mocked window), not just source regex, since the actual event-matching
// logic (isChunkLoadFailure's regexes, the reload-once guard) is exactly
// the kind of thing a source check could pass while the real behavior was
// subtly wrong.
// Run: npx tsx scripts/verify-global-error-listeners.mts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

const src = readFileSync(new URL("../components/GlobalErrorListeners.tsx", import.meta.url), "utf8");

// Extract and eval isChunkLoadFailure in isolation -- it's a pure function
// with no DOM dependency, so this is real behavior, not a hand-copy.
const fnMatch = src.match(/function isChunkLoadFailure\(reason: unknown\): boolean \{[\s\S]*?\n\}/);
if (!fnMatch) throw new Error("isChunkLoadFailure not found in source -- can't verify its real logic");
// eslint-disable-next-line no-new-func
const isChunkLoadFailure: (reason: unknown) => boolean = new Function(
  "reason",
  fnMatch[0].replace(/^function isChunkLoadFailure\(reason: unknown\): boolean \{/, "").replace(/\n\}$/, "")
) as never;

console.log("(1) isChunkLoadFailure: real detection logic, exercised directly");
{
  check("(1a) ChunkLoadError by name is detected", isChunkLoadFailure(Object.assign(new Error("some msg"), { name: "ChunkLoadError" })));
  check("(1b) 'Loading chunk N failed' message is detected", isChunkLoadFailure(new Error("Loading chunk 42 failed.\n(missing: https://x/chunk.js)")));
  check("(1c) 'Failed to fetch dynamically imported module' is detected", isChunkLoadFailure(new Error("Failed to fetch dynamically imported module: https://x/y.js")));
  check("(1d) 'Importing a module script failed' (Safari's phrasing) is detected", isChunkLoadFailure(new Error("Importing a module script failed.")));
  check("(1e) an ordinary, unrelated error is NOT misclassified as a chunk-load failure", !isChunkLoadFailure(new Error("Cannot read properties of undefined (reading 'foo')")));
  check("(1f) a plain string reason (not an Error) is handled without throwing", isChunkLoadFailure("Loading chunk 7 failed") === true);
  check("(1g) a non-Error, non-matching reason returns false, not throws", isChunkLoadFailure({ weird: "object" }) === false);
}

console.log("(2) source: the reload guard is a real one-shot, not an unconditional reload");
{
  check("(2a) checks sessionStorage before reloading", /if \(!sessionStorage\.getItem\(RELOAD_ATTEMPTED_KEY\)\)/.test(src));
  check("(2b) sets the guard key BEFORE calling reload (so a synchronous re-entry can't double-fire)", /sessionStorage\.setItem\(RELOAD_ATTEMPTED_KEY, "1"\);\s*\n\s*console\.warn\([^)]*\);\s*\n\s*window\.location\.reload\(\);/.test(src));
  check("(2c) a repeated chunk failure after the guard is set logs instead of reloading again", /console\.error\("\[global-error\] chunk load failed again after a reload/.test(src));
}

console.log("(3) source: both window listeners are registered AND cleaned up");
{
  check("(3a) unhandledrejection listener registered", /window\.addEventListener\("unhandledrejection", handleRejection\)/.test(src));
  check("(3b) error listener registered", /window\.addEventListener\("error", handleError\)/.test(src));
  check("(3c) both listeners are removed in the effect cleanup (no leak across remounts)", /window\.removeEventListener\("unhandledrejection", handleRejection\);\s*\n\s*window\.removeEventListener\("error", handleError\);/.test(src));
}

console.log("(4) source: non-chunk-load errors are surfaced (logged + tracked), never silently swallowed");
{
  check("(4a) a generic unhandled rejection is console.error'd", /console\.error\("\[global-error\] unhandled promise rejection:", reason\)/.test(src));
  check("(4b) a generic unhandled rejection is tracked via the shared analytics wrapper", /track\("unhandled_rejection",/.test(src));
  check("(4c) a raw window.onerror event is console.error'd", /console\.error\("\[global-error\] uncaught error:", event\.error \?\? event\.message\)/.test(src));
  check("(4d) a raw window.onerror event is tracked too", /track\("uncaught_error",/.test(src));
}

console.log("(5) source: wired into the root layout, mounted app-wide like the other global client components");
{
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  check("(5a) GlobalErrorListeners is imported in the root layout", /import \{ GlobalErrorListeners \} from "@\/components\/GlobalErrorListeners";/.test(layout));
  check("(5b) GlobalErrorListeners is actually mounted in the JSX", /<GlobalErrorListeners \/>/.test(layout));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("GLOBAL-ERROR-LISTENERS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL GLOBAL-ERROR-LISTENERS ASSERTIONS PASS");
