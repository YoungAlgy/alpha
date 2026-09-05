// Static wiring guard for the current release hold. Manual provider
// suppression removal remains schema-visible for compatibility, but the
// server action is disabled before any service/provider dependency is touched.
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "OK " : "XX "}${label}`);
  if (condition) pass += 1;
  else fail += 1;
};

const routeSrc = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
const policySrc = readFileSync(new URL("../lib/suppression-recovery-policy.ts", import.meta.url), "utf8");
const emailSrc = readFileSync(new URL("../lib/email.ts", import.meta.url), "utf8");
const helperPath = new URL("../lib/suppression-recovery.ts", import.meta.url);
const helperSrc = readFileSync(helperPath, "utf8");
const uiSrc = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
const postStart = routeSrc.indexOf("export async function POST");
const postSrc = postStart > -1 ? routeSrc.slice(postStart) : "";
const disabledAt = postSrc.indexOf("manual_recovery_disabled");
const serviceAt = postSrc.indexOf("supabaseServiceClient()");
const policyBoolean = /export\s+const\s+\w*(?:suppression|recovery)\w*\s*=\s*false\s*;/i;

console.log("(1) release policy: manual provider suppression removal is disabled");
check("the action schema remains compatible with clear_suppression", /z\.enum\(\[[^\]]*"clear_suppression"[^\]]*\]\)/.test(routeSrc));
check("the policy module exports a false suppression/recovery switch", policyBoolean.test(policySrc));
check("the route imports the policy module", routeSrc.includes("suppression-recovery-policy"));
check("the route exposes the stable manual_recovery_disabled response", routeSrc.includes("manual_recovery_disabled"));
check("the disabled response is after auth, rate-limit, and body validation", disabledAt > postSrc.indexOf("requireAdmin()") && disabledAt > postSrc.indexOf("rateLimit(") && disabledAt > postSrc.indexOf("ActionBodySchema.parse"));
check("the disabled response is before service-client creation", disabledAt > -1 && serviceAt > disabledAt);
check("the route has no provider or recovery helper import", !/from ["']@\/lib\/(?:email|suppression-recovery)["']/.test(routeSrc));
check("the route has no direct provider-clear call", !routeSrc.includes("removeResendSuppression("));

console.log("(2) helper/email guard: the provider clear cannot be enabled through a stale caller");
check("email imports the shared suppression-recovery policy", emailSrc.includes("suppression-recovery-policy"));
check("email references the shared disabled policy", emailSrc.includes("MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED"));
check("the recovery helper imports the shared suppression-recovery policy", helperSrc.includes("suppression-recovery-policy"));
check("the recovery helper references the shared disabled policy", helperSrc.includes("MANUAL_PROVIDER_SUPPRESSION_REMOVAL_ENABLED"));

console.log("(3) admin UI: the hold is visible and the clear action is absent");
check("the UI no longer dispatches clear_suppression", !uiSrc.includes('"clear_suppression"'));
check("the UI no longer renders a clear_suppression action type", !/clear_suppression/.test(uiSrc));
check("the UI explains that manual delivery recovery is disabled", uiSrc.includes("MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE"));
check("the UI keeps the deletion hold tied to busy or recovery state", /disabled=\{isBusy\s*\|\|\s*recoveryInProgress\}/.test(uiSrc));
check("the UI keeps the deletion-blocked copy", /deletion|account deletion|delivery remains blocked/i.test(uiSrc));
check("the UI keeps the recovery-started-at badge", /recovery_started_at|recovery started|Recovery in progress/i.test(uiSrc));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CLEAR-SUPPRESSION-ACTION VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CLEAR-SUPPRESSION-ACTION ASSERTIONS PASS");
