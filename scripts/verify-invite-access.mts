// Fully local invite-only access guard. Reads source and exercises pure mode
// helpers only. No environment files, network calls, provider clients, or
// database access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { alphaAccessMode } from "../lib/access-mode.ts";
import { hasReaderAccess } from "../lib/access.ts";
import { hardProductFailures } from "../lib/health-status.ts";
import {
  authOwnsAccessRequestEmail,
  normalizeAccessRequestEmail,
} from "../lib/access-request-ownership.ts";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const oldPublicMode = process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
const oldServerMode = process.env.ALPHA_ACCESS_MODE;
try {
  delete process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
  delete process.env.ALPHA_ACCESS_MODE;
  assert.equal(alphaAccessMode(), "invite");
  assert.equal(alphaAccessMode(true), "invite");

  process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE = "paid";
  assert.equal(alphaAccessMode(), "invite");
  assert.equal(alphaAccessMode(true), "invite");

  delete process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
  process.env.ALPHA_ACCESS_MODE = "paid";
  assert.equal(alphaAccessMode(), "invite");
  assert.equal(alphaAccessMode(true), "invite");

  process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE = "paid";
  assert.equal(alphaAccessMode(), "invite");
  assert.equal(alphaAccessMode(true), "invite");

  const allChecks = {
    anthropic: true,
    resend: true,
    stripe: false,
    stripeWebhook: false,
    checkoutBinding: false,
    unsubscribe: true,
    legacyCheckoutCutoff: false,
    supabase: true,
  } as const;
  assert.deepEqual(hardProductFailures(allChecks, "invite"), []);
  assert.deepEqual(hardProductFailures(allChecks, "paid"), [
    "stripe",
    "stripeWebhook",
    "checkoutBinding",
    "legacyCheckoutCutoff",
  ]);
} finally {
  if (oldPublicMode === undefined) delete process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
  else process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE = oldPublicMode;
  if (oldServerMode === undefined) delete process.env.ALPHA_ACCESS_MODE;
  else process.env.ALPHA_ACCESS_MODE = oldServerMode;
}

assert.equal(normalizeAccessRequestEmail("  Reader@Example.COM  "), "reader@example.com");
assert.equal(normalizeAccessRequestEmail("   "), null);
assert.equal(normalizeAccessRequestEmail(undefined), null);
assert.equal(
  authOwnsAccessRequestEmail(" Reader@Example.COM ", "reader@example.com"),
  true
);
assert.equal(
  authOwnsAccessRequestEmail("reader+other@example.com", "reader@example.com"),
  false
);
assert.equal(authOwnsAccessRequestEmail(null, "reader@example.com"), false);

const accessRoute = source("../app/api/access/request/route.ts");
assert.match(accessRoute, /access_requested_at/);
assert.match(accessRoute, /supabaseServerClient/);
assert.match(accessRoute, /await authClient\.auth\.getUser\(\)/);
assert.match(accessRoute, /!signedInUser\.email_confirmed_at/);
assert.match(
  accessRoute,
  /authOwnsAccessRequestEmail\(signedInUser\.email, email\)/
);
assert.match(
  accessRoute,
  /error: "identity_verification_required"[\s\S]*?status: 401/
);
assert.match(
  accessRoute,
  /error: "authenticated_email_mismatch"[\s\S]*?status: 403/
);
assert.match(accessRoute, /const userId = signedInUser\.id/);
assert.doesNotMatch(accessRoute, /generateLink|auth\.admin|action_link|email_otp|hashed_token/);
assert.match(
  accessRoute,
  /mediaType !== "application\/json"[\s\S]*?status: 415/
);

const getUserIndex = accessRoute.indexOf("await authClient.auth.getUser()");
const confirmationIndex = accessRoute.indexOf("!signedInUser.email_confirmed_at");
const ownershipIndex = accessRoute.indexOf(
  "authOwnsAccessRequestEmail(signedInUser.email, email)"
);
const serviceClientIndex = accessRoute.indexOf("sb = await supabaseServiceClient()");
const accessMarkerIndex = accessRoute.indexOf("access_requested_at: now");
assert.ok(getUserIndex >= 0);
assert.ok(confirmationIndex > getUserIndex);
assert.ok(ownershipIndex > confirmationIndex);
assert.ok(serviceClientIndex > ownershipIndex);
assert.ok(accessMarkerIndex > serviceClientIndex);
const profileWriteBlock = accessRoute.slice(
  accessRoute.indexOf("const profile = {"),
  accessRoute.indexOf("return NextResponse.json({ ok: true, requestedAt: now })")
);
assert.doesNotMatch(
  profileWriteBlock.slice(0, profileWriteBlock.indexOf("const { data: existing")),
  /subscribed_at|cancelled_at|stripe_customer_id|access_granted_at/
);
assert.match(
  profileWriteBlock,
  /if \(existing\)[\s\S]*?\.update\(profile\)\.eq\("id", userId\)[\s\S]*?\.eq\("updated_at", existing\.updated_at\)[\s\S]*?\.insert\(\{ id: userId, \.\.\.profile \}\)/
);
const requestStoredIndex = accessRoute.indexOf("if (result.error || !result.data)");
const requestAlertIndex = accessRoute.indexOf("sendOpsWebhookAlert(");
const requestSuccessIndex = accessRoute.indexOf(
  "return NextResponse.json({ ok: true, requestedAt: now })"
);
assert.match(accessRoute, /import \{ NextResponse, after \} from "next\/server"/);
assert.match(accessRoute, /import \{ sendOpsWebhookAlert \} from "@\/lib\/email"/);
assert.ok(requestAlertIndex > requestStoredIndex);
assert.ok(requestSuccessIndex > requestAlertIndex);
const requestAlertBlock = accessRoute.slice(requestAlertIndex, requestSuccessIndex);
assert.match(requestAlertBlock, /"alpha: access request pending"/);
assert.match(requestAlertBlock, /Review the Accounts panel/);
assert.doesNotMatch(requestAlertBlock, /email|userId|firstName|profile|\$\{/);
const optionalAlert = accessRoute.slice(
  accessRoute.indexOf("  try {", accessRoute.indexOf("// The database row is the source of truth.")),
  requestSuccessIndex
);
assert.match(optionalAlert, /try \{\s*after\(\(\) =>/);
assert.match(optionalAlert, /\} catch \{\s*console\.warn\("\[access\/request\] optional ops alert could not be scheduled"\);\s*\}/);
// Run only this source-extracted registration block with inert injected
// dependencies. Neither Next nor an actual webhook/provider is imported.
const registerOptionalAlert = new Function("after", "sendOpsWebhookAlert", "console", optionalAlert);
let alertCalls = 0;
let warningCalls = 0;
const alertWarnings = { warn: () => { warningCalls += 1; } };
assert.doesNotThrow(() => registerOptionalAlert(
  () => { throw new Error("local test: missing background scheduler"); },
  () => { alertCalls += 1; },
  alertWarnings
));
assert.equal(alertCalls, 0, "no alert starts if registration fails");
assert.equal(warningCalls, 1, "registration failure remains visible without failing the request");
const deferredAlerts: Array<() => void> = [];
registerOptionalAlert(
  (callback: () => void) => { deferredAlerts.push(callback); },
  () => { alertCalls += 1; },
  alertWarnings
);
assert.equal(deferredAlerts.length, 1);
assert.equal(alertCalls, 0, "optional alert waits until the scheduler runs it");
deferredAlerts[0]();
assert.equal(alertCalls, 1);
const csrfGuard = source("../lib/csrf-guard.ts");
assert.match(csrfGuard, /["']\/api\/access\/request["']/);

assert.match(source("../app/api/stripe/checkout/route.ts"), /isInviteOnly\(true\)/);
assert.match(
  source("../app/api/stripe/update-quantity/route.ts"),
  /isInviteOnly\(true\)[\s\S]*Paid plan changes are closed/
);
const checkoutPage = source("../app/checkout/page.tsx");
assert.match(checkoutPage, /Request access/);
assert.match(
  checkoutPage,
  /res\.status === 401 && data\.error === "identity_verification_required"[\s\S]*?rememberCheckoutSignIn\(\)[\s\S]*?setSignInRequired\(true\)/
);
assert.match(
  checkoutPage,
  /sessionStorage\.setItem\("alpha-signin-return", "\/checkout"\)/
);
assert.match(
  checkoutPage,
  /localStorage\.setItem\("alpha-signin-email", state\.email \|\| ""\)/
);
assert.match(
  checkoutPage,
  /Confirm this email before requesting access[\s\S]*?router\.push\("\/signin" as never\)/
);
assert.match(
  checkoutPage,
  /const accessSignInHeadingRef = useRef<HTMLParagraphElement>\(null\)[\s\S]*?if \(signInRequired\) accessSignInHeadingRef\.current\?\.focus\(\)/
);

const signinPage = source("../app/signin/page.tsx");
assert.match(signinPage, /return path === "\/checkout" \? path : null/);
assert.match(
  signinPage,
  /signInWithOtp\([\s\S]*?shouldCreateUser: true[\s\S]*?verifyOtp\([\s\S]*?takeSignInReturnPath\(\) \|\| "\/inbox"/
);
const adminPage = source("../app/settings/accounts/page.tsx");
const adminRoute = source("../app/api/admin/users/route.ts");
assert.match(adminPage, /Approve access/);
assert.match(adminPage, /account\.grantAction/);
assert.doesNotMatch(adminPage, /Keep invite access|Invited, billing ended|This does not cancel Stripe billing/);
assert.match(adminPage, /pendingRequests: number/);
assert.match(adminPage, /params\.set\("pending", "1"\)/);
assert.match(adminPage, /"deny_access"[\s\S]*?Deny request/);
assert.match(adminRoute, /grant_invite/);
assert.match(adminRoute, /revoke_invite/);
assert.match(adminRoute, /"deny_access"/);
assert.match(adminRoute, /pendingRequests: 0/);
assert.match(
  adminRoute,
  /if \(r\.access_requested_at && !r\.access_granted_at\) stats\.pendingRequests\+\+/
);

const pendingQueueBlock = adminRoute.slice(
  adminRoute.indexOf('} else if (pending === "1") {'),
  adminRoute.indexOf("} else if (before) {")
);
assert.match(pendingQueueBlock, /\.not\("access_requested_at", "is", null\)/);
assert.match(pendingQueueBlock, /\.is\("access_granted_at", null\)/);
assert.match(
  pendingQueueBlock,
  /\.order\("access_requested_at", \{ ascending: false \}\)/
);

const denyAccessBlock = adminRoute.slice(
  adminRoute.indexOf('if (body.action === "deny_access")'),
  adminRoute.indexOf(
    'if (body.action === "grant_invite" || body.action === "revoke_invite")'
  )
);
assert.match(
  denyAccessBlock,
  /\.update\(\{ access_requested_at: null \}\)[\s\S]*?\.eq\("access_requested_at", existing\.access_requested_at\)[\s\S]*?\.is\("access_granted_at", null\)/
);

const inviteDecisionBlock = adminRoute.slice(
  adminRoute.indexOf(
    'if (body.action === "grant_invite" || body.action === "revoke_invite")'
  ),
  adminRoute.indexOf('if (body.action === "grant_free")')
);
assert.match(
  inviteDecisionBlock,
  /\.update\(\{ access_requested_at: null \}\)[\s\S]*?alreadyGranted/
);
assert.match(
  inviteDecisionBlock,
  /\.update\(\{ access_requested_at: null, access_granted_at: grantedAt \}\)/
);
assert.match(
  inviteDecisionBlock,
  /\.update\(\{ access_requested_at: null, access_granted_at: null, delivery_enrolled: false \}\)/
);

const grantFreeStart = adminRoute.indexOf('if (body.action === "grant_free")');
const revokeFreeStart = adminRoute.indexOf('if (body.action === "revoke_free")');
// Manual suppression removal now stops near the top of the handler. It is no
// longer a trailing branch and cannot delimit revoke_free. End at the final
// unknown-action response, and reject missing or reordered source boundaries.
const unknownActionStart = adminRoute.indexOf(
  'return NextResponse.json({ error: "Unknown action" }',
  revokeFreeStart
);
assert.ok(grantFreeStart >= 0, "grant_free branch must exist");
assert.ok(revokeFreeStart > grantFreeStart, "revoke_free must follow grant_free");
assert.ok(unknownActionStart > revokeFreeStart, "revoke_free must precede the final response");
const grantFreeBlock = adminRoute.slice(grantFreeStart, revokeFreeStart);
const revokeFreeBlock = adminRoute.slice(revokeFreeStart, unknownActionStart);
assert.match(grantFreeBlock, /\.update\(\{[\s\S]*?access_requested_at: null,/);
assert.match(revokeFreeBlock, /\.update\(\{[\s\S]*?access_requested_at: null,/);
assert.match(
  adminRoute,
  /if \(!existing\.subscribed_at\)[\s\S]*no local access stamp/
);
assert.match(
  adminRoute,
  /\.update\(\{ access_requested_at: null, access_granted_at: grantedAt \}\)[\s\S]*\.eq\("subscribed_at", existing\.subscribed_at\)[\s\S]*access_requested_at[\s\S]*\.is\("access_granted_at", null\)/
);

const endedAt = "2026-08-29T00:00:00.000Z";
const now = new Date("2026-08-30T00:00:00.000Z");
assert.equal(hasReaderAccess("2026-01-01T00:00:00.000Z", endedAt, null, now), false);
assert.equal(
  hasReaderAccess(
    "2026-01-01T00:00:00.000Z",
    endedAt,
    "2026-08-28T00:00:00.000Z",
    now
  ),
  true
);
assert.equal(
  hasReaderAccess(null, endedAt, "2026-08-28T00:00:00.000Z", now),
  false
);

const inviteMigration = source(
  "../supabase/migrations/20260830000000_invite_access.sql"
);
assert.match(inviteMigration, /access_granted_at/);
assert.match(
  inviteMigration,
  /new\.access_requested_at := old\.access_requested_at;[\s\S]*new\.access_granted_at := old\.access_granted_at;/
);
assert.match(
  inviteMigration,
  /u\.access_granted_at is not null[\s\S]*u\.cancelled_at is null[\s\S]*u\.cancelled_at > now\(\)/
);
assert.match(
  inviteMigration,
  /watchdog_delivery_check\(cutoff timestamptz\)[\s\S]*u\.access_granted_at is not null[\s\S]*active_subscriber_count/
);
assert.equal(
  (inviteMigration.match(/u\.suppression_cleanup_pending_at is null/g) ?? [])
    .length,
  2
);

const weeklySend = source("../app/api/cron/weekly-send/route.ts");
assert.match(weeklySend, /access_granted_at\.not\.is\.null/);
assert.match(weeklySend, /hasReaderAccess/);

const generateRoute = source("../app/api/generate/route.ts");
assert.match(
  generateRoute,
  /code: isInviteOnly\(true\) \? "invite_access_required" : "payment_required"/
);
assert.match(
  generateRoute,
  /isInviteOnly\(true\)[\s\S]*?"Invite access is required before generating a letter\."[\s\S]*?"Payment required\. Subscribe to receive your letter\."/
);

const stripeWebhook = source("../app/api/stripe/webhook/route.ts");
const exactEndBlock = stripeWebhook.slice(
  stripeWebhook.indexOf("const endExactSubscriptionBinding"),
  stripeWebhook.indexOf("const readExactSubscriptionAccess")
);
const legacyEndBlock = stripeWebhook.slice(
  stripeWebhook.indexOf("const settleLegacyAlphaEnd"),
  stripeWebhook.indexOf("const proveMissingPriorSubscriptionIsReplaceable")
);
const disputeCreatedBlock = stripeWebhook.slice(
  stripeWebhook.indexOf('case "charge.dispute.created"'),
  stripeWebhook.indexOf('case "charge.dispute.closed"')
);
const disputeClosedBlock = stripeWebhook.slice(
  stripeWebhook.indexOf('case "charge.dispute.closed"'),
  stripeWebhook.indexOf('case "charge.refunded"')
);
assert.match(
  exactEndBlock,
  /\.update\(\{ cancelled_at: endedAt \}\)[\s\S]*\.select\("id, subscribed_at, cancelled_at, access_granted_at"\)/
);
assert.doesNotMatch(exactEndBlock, /access_granted_at\s*:/);
assert.match(
  legacyEndBlock,
  /\.select\("id, subscribed_at, cancelled_at, access_granted_at"\)/
);
assert.doesNotMatch(legacyEndBlock, /access_granted_at\s*:/);
assert.match(
  disputeCreatedBlock,
  /disputeAccess\.inviteAccessRemains[\s\S]*billing ended, invite access remains[\s\S]*Permanent invite reader access remains unchanged/
);
assert.match(
  disputeCreatedBlock,
  /else if \(disputeAccess\.readerAccessRemains\)[\s\S]*reader access remains[\s\S]*else \{[\s\S]*reader access revoked/
);
assert.match(
  disputeClosedBlock,
  /readExactSubscriptionAccess\([\s\S]*closedAccess\.inviteAccessRemains[\s\S]*Permanent invite reader access remains unchanged/
);
assert.match(
  disputeClosedBlock,
  /else if \(closedAccess\.users > 0\)[\s\S]*reader access was revoked/
);
assert.doesNotMatch(
  disputeClosedBlock,
  /Access was revoked when it opened/
);

console.log("PASS verify-invite-access (offline)");
