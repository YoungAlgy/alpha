// Offline source-extraction proof that invite mode stops billing routes before
// they can read credentials, authenticate, or construct provider clients.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { alphaAccessMode, isInviteOnly } from "../lib/access-mode.ts";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

function firstInviteGuard(route: string, nextStatement: string): string {
  const start = route.indexOf("if (isInviteOnly(true))");
  const end = route.indexOf(nextStatement, start);
  assert.ok(start >= 0, "invite guard must exist");
  assert.ok(end > start, "invite guard must precede its next route statement");
  return route.slice(start, end);
}

type GuardResponse = { body: unknown; status: number; headers: unknown };

async function executeGuard(guard: string): Promise<GuardResponse> {
  let modeChecks = 0;
  const NextResponse = {
    json(body: unknown, init?: { status?: number; headers?: unknown }) {
      return {
        body,
        status: init?.status ?? 200,
        headers: init?.headers ?? null,
      };
    },
  };
  const run = new Function(
    "isInviteOnly",
    "NextResponse",
    `return (async () => { ${guard} })();`
  ) as (
    inviteOnly: (server: boolean) => boolean,
    response: typeof NextResponse
  ) => Promise<GuardResponse>;
  const result = await run((server) => {
    modeChecks += 1;
    assert.equal(server, true);
    return true;
  }, NextResponse);
  assert.equal(modeChecks, 1, "guard must decide invite mode exactly once");
  return result;
}

const checkout = source("../app/api/stripe/checkout/route.ts");
const quantity = source("../app/api/stripe/update-quantity/route.ts");
const portal = source("../app/api/stripe/portal/route.ts");

const checkoutGuard = firstInviteGuard(
  checkout,
  "if (checkoutMode(process.env.ALPHA_CHECKOUT_MODE)"
);
const quantityGuard = firstInviteGuard(quantity, "const secret = process.env.STRIPE_SECRET_KEY");
const portalGuard = firstInviteGuard(portal, "const secret = process.env.STRIPE_SECRET_KEY");

assert.ok(
  checkout.indexOf("if (isInviteOnly(true))") < checkout.indexOf("stripe.checkout.sessions.create"),
  "checkout must reject invite mode before Stripe session creation"
);
assert.ok(
  quantity.indexOf("if (isInviteOnly(true))") < quantity.indexOf("stripe.subscriptions.update"),
  "quantity changes must reject invite mode before Stripe subscription mutation"
);
assert.ok(
  portal.indexOf("if (isInviteOnly(true))") < portal.indexOf("stripe.billingPortal.sessions.create"),
  "portal must reject invite mode before Stripe portal-session creation"
);
assert.ok(
  portal.indexOf("if (isInviteOnly(true))") < portal.indexOf("const sb = await supabaseServerClient()"),
  "portal must reject invite mode before authentication work"
);

const oldPublic = process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
const oldServer = process.env.ALPHA_ACCESS_MODE;
try {
  process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE = "paid";
  process.env.ALPHA_ACCESS_MODE = "paid";
  assert.equal(alphaAccessMode(), "invite");
  assert.equal(alphaAccessMode(true), "invite");
  assert.equal(isInviteOnly(), true);
  assert.equal(isInviteOnly(true), true);
} finally {
  if (oldPublic === undefined) delete process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
  else process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE = oldPublic;
  if (oldServer === undefined) delete process.env.ALPHA_ACCESS_MODE;
  else process.env.ALPHA_ACCESS_MODE = oldServer;
}

const checkoutResult = await executeGuard(checkoutGuard);
assert.equal(checkoutResult.status, 410);
assert.deepEqual(checkoutResult.body, {
  error: "invite_only",
  message: "Alpha is invite-only right now. Request access from the sign-up flow.",
});

const quantityResult = await executeGuard(quantityGuard);
assert.equal(quantityResult.status, 410);
assert.match(
  (quantityResult.body as { error: string }).error,
  /Paid plan changes are closed/
);

const portalResult = await executeGuard(portalGuard);
assert.equal(portalResult.status, 410);
assert.deepEqual(portalResult.body, {
  error: "Alpha is invite-only. Billing changes are closed.",
});

console.log("PASS verify-no-charge-access (offline, 4 checks)");
