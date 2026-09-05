// Local pure/stub verification for the temporary pre-Round-80 checkout bridge.
// It loads no environment file and contacts no external service.
import type Stripe from "stripe";
import {
  legacyCheckoutRootCutoffUnix,
  legacyCheckoutMetadata,
  resolveLegacyCheckoutMetadata,
} from "../lib/legacy-checkout.ts";

type SessionOverrides = Partial<Stripe.Checkout.Session> & {
  metadata?: Record<string, string> | null;
};
const ROOT_CUTOFF_UNIX = Date.parse("2026-09-04T00:00:00.000Z") / 1000;

function session(overrides: SessionOverrides = {}): Stripe.Checkout.Session {
  return {
    id: "cs_legacy_root",
    object: "checkout.session",
    created: ROOT_CUTOFF_UNIX - 60,
    mode: "subscription",
    status: "expired",
    recovered_from: null,
    metadata: {
      alpha_first_name: "Alex",
      alpha_city: "Tampa",
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

console.log("(1) direct legacy metadata has a fixed shape and deploy-bound cutoff");
const valid = legacyCheckoutMetadata(session(), ROOT_CUTOFF_UNIX);
check("(1a) accepts the two known Alpha metadata fields", valid?.firstName === "Alex" && valid.city === "Tampa");
check("(1b) trims the known fields", legacyCheckoutMetadata(session({ metadata: { alpha_first_name: "  Alex  ", alpha_city: "  Tampa  " } }), ROOT_CUTOFF_UNIX)?.city === "Tampa");
check("(1c) rejects a staged-profile id", legacyCheckoutMetadata(session({ metadata: { alpha_profile_id: "bad", alpha_first_name: "Alex" } }), ROOT_CUTOFF_UNIX) === null);
check("(1d) rejects a blank first name", legacyCheckoutMetadata(session({ metadata: { alpha_first_name: " " } }), ROOT_CUTOFF_UNIX) === null);
check("(1e) rejects a root created at the cutoff", legacyCheckoutMetadata(session({ created: ROOT_CUTOFF_UNIX }), ROOT_CUTOFF_UNIX) === null);
check("(1f) rejects a non-subscription Session", legacyCheckoutMetadata(session({ mode: "payment" }), ROOT_CUTOFF_UNIX) === null);
check("(1g) rejects a root that was itself recovered", legacyCheckoutMetadata(session({ recovered_from: "cs_parent" }), ROOT_CUTOFF_UNIX) === null);
check("(1h) parses the configured production timestamp", legacyCheckoutRootCutoffUnix("2026-09-04T00:00:00.000Z") === ROOT_CUTOFF_UNIX);
let missingCutoffFails = false;
try {
  legacyCheckoutRootCutoffUnix("");
} catch {
  missingCutoffFails = true;
}
check("(1i) missing production cutoff fails closed", missingCutoffFails);

console.log("(2) recovered Sessions must point directly to the exact expired root");
const root = session();
const recovered = session({
  id: "cs_recovered",
  status: "complete",
  recovered_from: root.id,
});
const stripeStub = {
  checkout: {
    sessions: {
      retrieve: async (id: string) => {
        if (id !== root.id) throw new Error("unexpected Session id");
        return root;
      },
    },
  },
} as unknown as Stripe;
check("(2a) accepts one exact recovery hop", (await resolveLegacyCheckoutMetadata(stripeStub, recovered, ROOT_CUTOFF_UNIX))?.firstName === "Alex");
check("(2b) rejects a metadata mismatch", await resolveLegacyCheckoutMetadata(stripeStub, session({ id: "cs_bad", recovered_from: root.id, metadata: { alpha_first_name: "Mallory", alpha_city: "Tampa" } }), ROOT_CUTOFF_UNIX) === null);
const openRoot = session({ status: "open" });
const openRootStripe = { checkout: { sessions: { retrieve: async () => openRoot } } } as unknown as Stripe;
check("(2c) rejects recovery from a root that is not expired", await resolveLegacyCheckoutMetadata(openRootStripe, recovered, ROOT_CUTOFF_UNIX) === null);
const nestedRoot = session({ recovered_from: "cs_older" });
const nestedStripe = { checkout: { sessions: { retrieve: async () => nestedRoot } } } as unknown as Stripe;
check("(2d) rejects a recovery chain longer than one hop", await resolveLegacyCheckoutMetadata(nestedStripe, recovered, ROOT_CUTOFF_UNIX) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("R80 LEGACY CHECKOUT ASSERTIONS PASS");
