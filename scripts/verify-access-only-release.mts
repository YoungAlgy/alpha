// Offline source and behavior verification for the access-only release gate
// and production smoke contract. No environment file, network, or app runtime
// is loaded.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const gate = read("./verify-deploy-release.mjs");
// Predicate extraction must work in both Windows and Unix checkouts.
const smoke = read("./smoke-test-deploy.mjs").replace(/\r\n/g, "\n");
const accessPolicy = read("../lib/access-mode.ts").replace(/\r\n/g, "\n");
const deliveryPolicy = read("../lib/subscriber-delivery-policy.ts").replace(/\r\n/g, "\n");
const suppressionPolicy = read("../lib/suppression-recovery-policy.ts").replace(/\r\n/g, "\n");
const workflow = read("../.github/workflows/daily-send.yml").replace(/\r\n/g, "\n");
const portalRoute = read("../app/api/stripe/portal/route.ts");
const quantityRoute = read("../app/api/stripe/update-quantity/route.ts");
const checkoutRoute = read("../app/api/stripe/checkout/route.ts");

for (const [source, hash] of [
  [accessPolicy, "b9f13a9d129a7884f92f9d3c88f012db0936faaffdcaf1e73cd52ea02768c542"],
  [deliveryPolicy, "0d1acbb374dff7018f7d535e4c2d81b8a694cc207e3bace270e8357bd0da56b6"],
  [suppressionPolicy, "d8bdbbb14f0e258fc3d4c58af3c2742ad7671fe663e1556bd8655cbb468ad04b"],
] as const) {
  assert.equal(createHash("sha256").update(source).digest("hex"), hash);
  assert.ok(gate.includes(hash), `release gate must pin ${hash}`);
}
assert.match(gate, /expectedCheckoutMode !== "paused"/);
assert.match(gate, /dailySendManualOnly/);
assert.match(workflow, /^  send:\n(?:^ {4}.*\n)*?^ {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}$/m);

const executableGate = gate.replace(/^import .*;\r?\n/gm, "");
function runGate(overrides: Partial<Record<string, string>> = {}): number {
  let exitCode = 0;
  const stopped = new Error("gate stopped");
  const files: Record<string, string> = {
    "lib/access-mode.ts": accessPolicy,
    "lib/subscriber-delivery-policy.ts": deliveryPolicy,
    "lib/suppression-recovery-policy.ts": suppressionPolicy,
    ".github/workflows/daily-send.yml": workflow,
    "wrangler.jsonc": '{"vars":{"ALPHA_CHECKOUT_MODE":"paused"}}',
    ...overrides,
  };
  try {
    vm.runInNewContext(executableGate, {
      createHash,
      readFileSync(path: string) {
        if (!(path in files)) throw new Error(`unexpected file ${path}`);
        return files[path];
      },
      execFileSync(_command: string, args: string[]) {
        if (args.join(" ") === "rev-parse HEAD") return "a".repeat(40);
        if (args.join(" ") === "status --porcelain") return "";
        throw new Error("unexpected command");
      },
      console: { error() {}, log() {} },
      process: {
        env: {
          NEXT_PUBLIC_ALPHA_RELEASE_SHA: "a".repeat(40),
          ALPHA_EXPECTED_RELEASE_SHA: "a".repeat(40),
          ALPHA_EXPECTED_CHECKOUT_MODE: "paused",
        },
        exit(code: number) {
          exitCode = code;
          throw stopped;
        },
      },
    });
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return exitCode;
}

assert.equal(runGate(), 0);
for (const [path, source] of [
  ["lib/access-mode.ts", `${accessPolicy}\n// drift`],
  ["lib/subscriber-delivery-policy.ts", deliveryPolicy.replace("SUBSCRIBER_LETTERS_ENABLED: boolean = true", "SUBSCRIBER_LETTERS_ENABLED: boolean = false")],
  ["lib/suppression-recovery-policy.ts", suppressionPolicy.replace("false", "true")],
  [".github/workflows/daily-send.yml", workflow.replace("if: ${{ github.event_name == 'workflow_dispatch' }}", "if: ${{ true }}")],
] as const) {
  assert.equal(runGate({ [path]: source }), 1, `${path} drift must reject release`);
}

// Extract and execute the exact pure predicates used by the smoke checks.
const predicateSource = smoke.match(
  /function manualDeliveryHealthMatches[\s\S]*?\n}\n\nfunction noChargeResponseMatches[\s\S]*?\n}/
)?.[0];
assert.ok(predicateSource, "smoke predicates must remain source-extractable");
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(`${predicateSource}\nthis.health = manualDeliveryHealthMatches; this.noCharge = noChargeResponseMatches;`, sandbox);
const health = sandbox.health as (body: unknown) => boolean;
const noCharge = sandbox.noCharge as (status: number, body: unknown, cache: string, error: string) => boolean;
assert.equal(health({ accessMode: "invite", subscriberDeliveryMode: "open" }), true);
assert.equal(health({ accessMode: "paid", subscriberDeliveryMode: "open" }), false);
assert.equal(health({ accessMode: "invite", subscriberDeliveryMode: "paused" }), false);
assert.equal(noCharge(410, { error: "invite_only" }, "no-store", "invite_only"), true);
assert.equal(noCharge(503, { error: "invite_only" }, "no-store", "invite_only"), false);
assert.equal(noCharge(410, { error: "wrong" }, "no-store", "invite_only"), false);
assert.equal(noCharge(410, { error: "invite_only" }, "public", "invite_only"), false);

const requiredHealthSource = smoke.match(/function inviteRequiredHealthFailures[\s\S]*?\n}/)?.[0];
assert.ok(requiredHealthSource, "invite health requirements must remain source-extractable");
const requiredHealthSandbox: Record<string, unknown> = {};
vm.runInNewContext(`${requiredHealthSource}\nthis.failures = inviteRequiredHealthFailures;`, requiredHealthSandbox);
const inviteRequiredHealthFailures = requiredHealthSandbox.failures as (body: unknown) => string[];
const inviteHealth = {
  checks: {
    resend: true,
    unsubscribe: true,
    supabase: true,
    stripe: false,
    stripeWebhook: false,
    checkoutBinding: false,
    legacyCheckoutCutoff: false,
  },
  hardFailures: [],
};
assert.equal(inviteRequiredHealthFailures(inviteHealth).length, 0);
for (const name of ["resend", "unsubscribe", "supabase"] as const) {
  const changed = {
    ...inviteHealth,
    checks: { ...inviteHealth.checks, [name]: false },
  };
  assert.equal(inviteRequiredHealthFailures(changed).join(), name, `${name} must block invite launch`);
}
assert.equal(inviteRequiredHealthFailures({ ...inviteHealth, hardFailures: ["supabase"] }).join(), "hardFailures");
assert.equal(inviteRequiredHealthFailures({ ...inviteHealth, hardFailures: null }).join(), "hardFailures");

assert.match(smoke, /EXPECTED_CHECKOUT_MODE !== "paused"/);
assert.match(smoke, /body\?\.accessMode === "invite"/);
assert.match(smoke, /body\?\.subscriberDeliveryMode === "open"/);
assert.match(smoke, /\/api\/stripe\/checkout/);
assert.match(smoke, /\/api\/stripe\/update-quantity/);
assert.match(smoke, /\/api\/stripe\/portal/);
assert.match(smoke, /\/api\/webhooks\/resend/);
assert.match(smoke, /Missing svix headers/);
assert.match(smoke, /billing wind-down warning, not failing/);
assert.match(smoke, /old-key revocation/);
assert.doesNotMatch(smoke, /fetchWithTimeout\(`\$\{BASE_URL\}\/api\/(?:generate|cron)/);

for (const [label, route, exactError] of [
  ["checkout", checkoutRoute, 'error: "invite_only"'],
  ["quantity", quantityRoute, 'Alpha is invite-only now. Paid plan changes are closed. You can still turn off renewal from Settings.'],
  ["portal", portalRoute, 'Alpha is invite-only. Billing changes are closed.'],
] as const) {
  const guard = route.indexOf("if (isInviteOnly(true))");
  const error = route.indexOf(exactError);
  const secret = route.indexOf("process.env.STRIPE_SECRET_KEY");
  const auth = route.indexOf("supabaseServerClient()");
  assert.ok(guard >= 0, `${label} must have the invite-only guard`);
  assert.ok(error > guard, `${label} must return its exact access-only error`);
  assert.ok(secret === -1 || guard < secret, `${label} guard must run before Stripe configuration access`);
  assert.ok(auth === -1 || guard < auth, `${label} guard must run before authentication or database access`);
  assert.match(route.slice(guard, Math.max(secret, auth, route.length)), /status:\s*410/);
  assert.match(route.slice(guard, Math.max(secret, auth, route.length)), /"Cache-Control":\s*"no-store"/);
}

assert.ok(
  smoke.includes('"Alpha is invite-only. Billing changes are closed."'),
  "portal smoke must require the exact route response"
);

console.log("PASS verify-access-only-release (pinned holds, workflow hold, health and no-charge smoke predicates)");
