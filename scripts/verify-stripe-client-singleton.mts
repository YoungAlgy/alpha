// Verifies the two guarantees lib/stripe.ts's getStripeClient() comment
// promises but nothing else in the suite checks: (1) it throws when
// STRIPE_SECRET_KEY is missing/empty instead of silently building a client
// that only fails on its first real API call, and (2) repeat callers get
// back the SAME instance rather than each constructing their own `new
// Stripe(...)`. That second guarantee already broke once in the same
// session that added it -- the new cancelStripeSubscriptionsBeforeDelete
// helper briefly built its own separate client instead of importing the
// singleton, leaving 2 construction sites instead of 1, caught only by a
// human re-reading the diff (commit 9ef559a: "Neither tsc nor eslint catch
// either class of mistake"). Each throw/reuse check below runs in its own
// tsx subprocess so the module-level `_stripe` cache from one check can't
// leak into and invalidate the next. Part (4) re-detects that exact
// regression shape via a repo-wide grep for a second construction site.
// Run: npx tsx scripts/verify-stripe-client-singleton.mts
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// file:// URL, not a bare path -- the generated check runs from a scratch
// temp dir, so a relative "./lib/stripe.ts" specifier would resolve against
// the wrong directory.
const stripeModuleUrl = JSON.stringify(pathToFileURL(join(repoRoot, "lib/stripe.ts")).href);

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// Invoke tsx's own cli.mjs directly through `node`, rather than `npx tsx` --
// npx resolves through cmd.exe on Windows (shell: true), and shell-mode
// argv isn't escaped, so it's both fragile for a script containing
// quotes/parens and a real injection foot-gun.
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

// Runs `code` in a fresh tsx subprocess (fresh module registry, so
// lib/stripe.ts's module-level _stripe always starts null) with
// STRIPE_SECRET_KEY set to `key` (or unset if omitted). Returns trimmed
// stdout.
function runIsolated(key: string | undefined, code: string): string {
  const env = { ...process.env };
  if (key === undefined) {
    delete env.STRIPE_SECRET_KEY;
  } else {
    env.STRIPE_SECRET_KEY = key;
  }
  const dir = mkdtempSync(join(tmpdir(), "verify-stripe-singleton-"));
  const file = join(dir, "check.mts");
  try {
    writeFileSync(file, code);
    return execFileSync(process.execPath, [tsxCli, file], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (1) Missing key -> throws.
console.log("(1) missing STRIPE_SECRET_KEY");
const r1 = runIsolated(
  undefined,
  `import(${stripeModuleUrl}).then(m => { try { m.getStripeClient(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + e.message); } })`
);
check(`throws when STRIPE_SECRET_KEY is unset (got "${r1}")`, r1.startsWith("THREW:"));

// (2) Whitespace-only key -> also throws (trims to empty).
console.log("(2) whitespace-only STRIPE_SECRET_KEY");
const r2 = runIsolated(
  "   ",
  `import(${stripeModuleUrl}).then(m => { try { m.getStripeClient(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + e.message); } })`
);
check(`throws when STRIPE_SECRET_KEY is whitespace-only (got "${r2}")`, r2.startsWith("THREW:"));

// (3) Singleton reuse -- two calls return the identical instance.
console.log("(3) singleton reuse");
const r3 = runIsolated(
  "sk_test_verify_singleton_fake_key",
  `import(${stripeModuleUrl}).then(m => { const a = m.getStripeClient(); const b = m.getStripeClient(); console.log(a === b ? "SAME" : "DIFFERENT"); })`
);
check(`second call returns the SAME instance, not a new Stripe(...) (got "${r3}")`, r3 === "SAME");

// (4) Regression-shape guard -- no OTHER file in the repo constructs its own
// `new Stripe(` client. This is the exact mistake the singleton exists to
// prevent, and it already recurred once (see header) before this check
// existed.
console.log("(4) no parallel `new Stripe(` construction sites");
let hits: string[] = [];
try {
  const out = execFileSync("git", ["grep", "--untracked", "-n", "new Stripe(", "--", "*.ts", "*.tsx"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  hits = out.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("lib/stripe.ts:"));
} catch (e) {
  // git grep exits 1 with empty stdout when there are zero matches at all --
  // not an error here, just means nothing to filter.
  if (!(e && typeof e === "object" && "status" in e && e.status === 1)) throw e;
}
if (hits.length > 0) console.log(hits.map((l) => `    ${l}`).join("\n"));
check("only lib/stripe.ts constructs `new Stripe(`", hits.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("STRIPE CLIENT SINGLETON VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL STRIPE CLIENT SINGLETON ASSERTIONS PASS");
