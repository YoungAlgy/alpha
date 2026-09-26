// Round 80 umbrella verification. Local source and migration assertions only.
// It loads no environment file, spawns no child script, and contacts nothing.
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed++;
  else failed++;
}
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const checkoutPage = read("../app/checkout/page.tsx");
const checkoutRoute = read("../app/api/stripe/checkout/route.ts");
const checkoutSessionParams = read("../lib/checkout-session-params.ts");
const checkoutProfileRetention = read("../lib/checkout-profile-retention.ts");
const checkoutRecovery = read("../lib/checkout-recovery.ts");
const generateRoute = read("../app/api/generate/route.ts");
const writingPage = read("../app/writing/page.tsx");
const stripeWebhook = read("../app/api/stripe/webhook/route.ts");
const checkoutWebhookBranch = stripeWebhook.slice(
  stripeWebhook.indexOf('case "checkout.session.completed"'),
  stripeWebhook.indexOf('case "customer.subscription.created"')
);
const subscriptionWebhookBranch = stripeWebhook.slice(
  stripeWebhook.indexOf('case "customer.subscription.created"'),
  stripeWebhook.indexOf('case "customer.subscription.deleted"')
);
const deletedSubscriptionBranch = stripeWebhook.slice(
  stripeWebhook.indexOf('case "customer.subscription.deleted"'),
  stripeWebhook.indexOf('case "invoice.payment_failed"')
);
const resendWebhook = read("../app/api/webhooks/resend/route.ts");
const persist = read("../lib/engine/persist.ts");
const cron = read("../app/api/cron/weekly-send/route.ts");
const sourceResolver = read("../lib/engine/source-resolver.ts");
const assemble = read("../lib/engine/assemble.ts");
const topicBlurb = read("../lib/engine/topic-blurb.ts");
const preflight = read("./verify-send-preflight.mjs");
const dailyWorkflow = read("../.github/workflows/daily-send.yml");
const watchdog = read("../.github/workflows/letter-watchdog.yml");
const checkoutMigration = read(
  "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql"
);
const webhookLeaseMigration = read(
  "../supabase/migrations/20260827010000_stripe_webhook_event_leases.sql"
);
const suppressionPendingMigration = read(
  "../supabase/migrations/20260827020000_delivery_suppression_pending.sql"
);
const stripeCancel = read("../lib/stripe-cancel.ts");
const updateQuantity = read("../app/api/stripe/update-quantity/route.ts");

console.log("(1) carried checkout, privacy, and form findings");
check("checkout hides the greeting until saved signup state loads", checkoutPage.includes("if (!loaded || !accountChecked)") && checkoutPage.includes("Checking your saved signup...") && checkoutPage.indexOf("if (!loaded || !accountChecked)") < checkoutPage.indexOf('`Almost there, ${firstName}.`'));
check("checkout response JSON is guarded", /\.json\(\)\s*\n\s*\.catch\(\(\) => \(\{\}/.test(checkoutPage));
const cityPage = read("../app/city/page.tsx");
const profileEditor = read("../components/ProfileEditor.tsx");
const privacyPage = read("../app/privacy/page.tsx");
// Alpha is free now, so the city helpers no longer mention billing at all.
check("live city helpers make no Stripe claim now that Alpha is free", !cityPage.includes("Stripe") && !profileEditor.includes("Stripe") && cityPage.includes("Lets the letter know when something nearby is worth mentioning"));
check(
  "Stripe metadata contains only the opaque profile id",
  checkoutRoute.includes("alphaCheckoutSessionCreateParams({") &&
    /metadata:\s*\{\s*alpha_profile_id: input\.profileId,?\s*\}/.test(
      checkoutSessionParams
    ) &&
    !checkoutSessionParams.includes("alpha_first_name") &&
    !checkoutSessionParams.includes("alpha_city")
);
check(
  "privacy copy matches the minimized Stripe payload",
  privacyPage.includes(
    "Current Alpha checkouts do not copy your profile&apos;s first name, city,"
  ) &&
    privacyPage.includes("opaque checkout reference")
);
const questionStep = read("../components/onboarding/QuestionStep.tsx");
const textarea = questionStep.match(/<textarea[\s\S]*?\/>/)?.[0] ?? "";
const input = questionStep.match(/<input[\s\S]*?\/>/)?.[0] ?? "";
check("required textarea exposes native and ARIA semantics", textarea.includes("required={!optional || undefined}") && textarea.includes("aria-required={!optional || undefined}"));
check("required input exposes native and ARIA semantics", input.includes("required={!optional || undefined}") && input.includes("aria-required={!optional || undefined}"));

console.log("(2) invite checkout guard and retained paid fulfillment");
check("missing Stripe configuration fails generation closed outside development", /NODE_ENV === "development"[\s\S]{0,300}Payment verification is temporarily unavailable/.test(generateRoute));
check("checkout validates mode, the one exact Alpha line item, and live subscription", /session\.mode !== "subscription"/.test(generateRoute) && generateRoute.includes("lineItems.length === 1") && generateRoute.includes("priceId === STRIPE_PRICE_ID") && generateRoute.includes("isLiveForManagement(subscription.status)"));
check("generation binds the current subscription to the same Alpha customer", generateRoute.includes("exactAlphaSubscription") && generateRoute.includes("subscriptionCustomerId !== sessionCustomerId"));
check(
  "invite checkout closes before staging a profile or creating a Stripe Session",
  checkoutRoute.includes("if (isInviteOnly(true))") &&
    checkoutRoute.indexOf("if (isInviteOnly(true))") < checkoutRoute.indexOf('"stage_checkout_profile"') &&
    checkoutRoute.indexOf('"stage_checkout_profile"') < checkoutRoute.indexOf("stripe.checkout.sessions.create") &&
    checkoutSessionParams.includes("alpha_profile_id: input.profileId") &&
    /error: "invite_only"[\s\S]{0,180}status: 410/.test(checkoutRoute)
);
check(
  "expired abandoned checkout profiles are swept",
  checkoutRoute.includes("scrubExpiredCheckoutProfiles(sb)") &&
    checkoutProfileRetention.includes('.eq("billing_state", "open")') &&
    checkoutProfileRetention.includes('.is("stripe_session_id", null)') &&
    checkoutProfileRetention.includes('.lt("expires_at", nowIso)')
);
check("checkout URL is bound to an HttpOnly same-browser nonce", checkoutRoute.includes("browser_nonce_hash") && checkoutRoute.includes("httpOnly: true") && generateRoute.includes("timingSafeEqual(expectedHash, actualHash)"));
check(
  "one open or paid staged intent per email serializes rapid checkout attempts",
  checkoutMigration.includes("checkout_profiles_active_email_idx") &&
    checkoutMigration.includes(
      "where billing_state in ('open', 'creating', 'paid', 'recovering', 'deleting')"
    ) &&
    checkoutRoute.includes("alphaCheckoutSessionIdempotencyKey(stagedProfileId)") &&
    checkoutSessionParams.includes("return `alpha-checkout-${profileId}`") &&
    !checkoutRoute.includes("Math.floor(Date.now() / 30000)")
);
check(
  "retained legacy checkout binds its Session before returning a URL",
  checkoutRoute.indexOf("if (isInviteOnly(true))") < checkoutRoute.indexOf('"bind_checkout_session"') &&
    checkoutRoute.indexOf('"bind_checkout_session"') < checkoutRoute.indexOf("NextResponse.json({ url: session.url })") &&
    checkoutMigration.includes("create or replace function public.bind_checkout_session")
);
check(
  "existing accounts must authenticate before a new checkout can attach",
  checkoutRoute.includes("if (!signedInUser)") &&
    checkoutRoute.includes('error: "identity_verification_required"') &&
    checkoutRoute.includes("if (!signedInUser.email_confirmed_at)") &&
    checkoutRoute.includes('.eq("id", signedInUser.id)') &&
    checkoutRoute.includes("p_owner_user_id: checkoutOwnerUserId")
);
check(
  "anonymous paid checkout never auto-verifies an account token",
  !generateRoute.includes("auth.verifyOtp({") &&
    generateRoute.includes("!sessionUser.email_confirmed_at") &&
    /const signedIn =[\s\S]*paid\.kind === "authenticated"[\s\S]*paid\.kind === "checkout"[\s\S]*paid\.kind === "legacy_authenticated"/.test(
      generateRoute
    )
);
check("first-letter route reads the immutable staged profile", generateRoute.includes("loadStagedCheckoutProfile") && generateRoute.includes('.from("checkout_profiles")'));
check("checkout fulfillment uses an atomic database claim", generateRoute.includes('sb.rpc("claim_checkout_fulfillment"') && checkoutMigration.includes("for update;"));
check("browser and Session binding are checked before the fulfillment lease", generateRoute.indexOf("loadStagedCheckoutProfile(") < generateRoute.indexOf("claimCheckoutFulfillment(paid, weekOf)") && generateRoute.includes("data.stripe_session_id !== sessionId"));
check("checkout issue date is stable across UTC midnight retries", generateRoute.includes("checkoutWeekOf") && generateRoute.includes("new Date(session.created * 1000)"));
check("completed checkout claims require the owning active session for replay", generateRoute.includes("loadCompletedCheckoutIssue") && generateRoute.includes("checkout_already_used"));
check("used checkout links show a sign-in recovery instead of an endless retry", writingPage.includes('failure?.error === "checkout_already_used"') && writingPage.includes('router.push("/signin"'));
check(
  "checkout completion is lease-owner guarded",
  generateRoute.includes('.rpc("complete_checkout_fulfillment"') &&
    generateRoute.includes("p_lease_token: claim.leaseToken") &&
    /complete_checkout_fulfillment[\s\S]*v_fulfillment\.lease_token is distinct from p_lease_token[\s\S]*status = 'completed'[\s\S]*lease_token = p_lease_token/.test(
      checkoutMigration
    )
);
check(
  "a late legacy winner cannot strand a renewable current checkout loser",
  generateRoute.includes("resolveLateCheckoutCompletionConflict") &&
    checkoutRecovery.includes("record_current_checkout_duplicate_refund_review") &&
    checkoutRecovery.includes("currentCheckoutDuplicateCancellationIdempotencyKey") &&
    checkoutMigration.includes("Commit a bounded recovery deadline") &&
    checkoutMigration.includes("v_recovery_mode") &&
    checkoutMigration.includes("abort_current_checkout_duplicate_fulfillment")
);
check("uncertain duplicate-subscription lookup returns 503", /active-subscription pre-check failed, blocking checkout:[\s\S]{0,350}status: 503/.test(checkoutRoute));
const checkoutGuards = read("../lib/checkout-guards.ts");
check("base checkout requires five unique topics", checkoutGuards.includes("body.topics.length === MIN_TOPIC_QUOTA") && checkoutGuards.includes("new Set(body.topics).size === body.topics.length"));
check(
  "blank profiles are no longer excused by workflow coverage",
  !dailyWorkflow.includes("const excused = blankCount +") &&
    dailyWorkflow.includes(
      "const excused=s.skippedAlreadyDelivered+s.unsubscribedMidRunSkips+s.cancelledMidRunSkips+s.suppressedMidRunSkips+s.unenrolledMidRunSkips;"
    ) &&
    dailyWorkflow.includes("if (uncovered!==s.deliveryRetryRequiredTotal) throw new Error('coverage');")
);

console.log("(3) persistence and delivery preserve one usable content identity");
check("persistence reports profile and issue durability separately", persist.includes("profilePersisted: boolean") && persist.includes("issuePersisted: boolean"));
check("generation sends and renders the canonical durable issue", persist.includes("persistedIssue: Issue | null") && generateRoute.includes("persistence?.persistedIssue ?? generatedIssue"));
check("production generation refuses a missing archive write", generateRoute.includes("subscriber profile or issue did not persist"));
check("email delivery requires the persisted issue result", generateRoute.indexOf("subscriber profile or issue did not persist") < generateRoute.indexOf("deliverLetterOnce({"));
check("cron skips content backups after a usable issue exists", cron.includes("if (usableIssue || (persistedRetry && !issueIsReaderVisible(persistedRetry)))") && cron.includes("content backups skipped"));
check("suppression DB write failures return retriable 500", /suppression write failed[\s\S]{0,120}status: 500/.test(resendWebhook));

console.log("(4) provider fallbacks do not depend on one paid subscription");
check("production source resolution has no mock import or call", !/mock-signals|resolveMockSignal|getSignal\s*\(/.test(sourceResolver));
check("production assembly has no filler generator", !/resolveMockSignal|genFiller/.test(assemble));
check("Brave absence or outage can reach alternate search", sourceResolver.includes("shouldTryFallback = !braveConfigured()") && sourceResolver.includes('fallbackReason = "unavailable"'));
check("healthy-empty Brave is distinct from unavailable", sourceResolver.includes('state: "healthy-empty"') && sourceResolver.includes('state: "unavailable"'));
check("permanent Groq 413 skips the outer retry", topicBlurb.includes("status === 413") && topicBlurb.includes("skipping the outer retry"));
check("Anthropic belongs to the generator group instead of fixed hard requirements", preflight.includes('const GENERATOR_KEYS = [') && !/const HARD_REQUIRED = \[[\s\S]*ANTHROPIC_API_KEY/.test(preflight));
check("zero generators enters explicit backup-only mode instead of blocking persisted content", preflight.includes("backup-only mode can still use an already usable persisted issue or bounded prior-issue backup") && !/configuredGenerators\.length === 0[\s\S]{0,300}hardFailures\+\+/.test(preflight));
check("Resend preflight request has a 15-second timeout", preflight.includes("AbortSignal.timeout(15_000)"));
check("watchdog alerts for every positive uncovered count", watchdog.includes('if [ "${UNCOVERED_COUNT}" -gt 0 ]; then'));

console.log("(5) billing and webhook state changes fail closed");
const deleteRoute = read("../app/api/account/delete/route.ts");
check("account deletion stops before auth deletion on uncertain billing state", deleteRoute.indexOf("if (rowErr)") < deleteRoute.indexOf("deleteUser(user.id)") && deleteRoute.includes("Nothing was deleted"));
const adminRoute = read("../app/api/admin/users/route.ts");
check(
  "free-access revoke stamps cancellation and clears request plus invite grants",
  /update\(\{[\s\S]*subscribed_at: null,[\s\S]*access_requested_at: null,[\s\S]*access_granted_at: null,[\s\S]*cancelled_at: revokedAt,[\s\S]*delivery_enrolled: false,[\s\S]*\}\)/.test(
    adminRoute
  )
);
check("checkout webhook requires a live subscription before user creation", stripeWebhook.indexOf("subscriptionLive") < stripeWebhook.indexOf("generateLink({"));
check("checkout webhook requires exact Alpha payment and customer binding", checkoutWebhookBranch.includes("session.mode !== \"subscription\"") && checkoutWebhookBranch.includes("line.quantity === 1") && checkoutWebhookBranch.includes("!isAlphaSubscription(sub)") && !checkoutWebhookBranch.includes("isAlphaSubscription(sub, 1)") && checkoutWebhookBranch.includes("subscriptionCustomerId(sub) !== customerId"));
check("checkout webhook independently verifies immutable line items and staged Session", stripeWebhook.includes("listLineItems(") && stripeWebhook.includes("exactAlphaCheckout") && stripeWebhook.includes('.eq("stripe_session_id", session.id)'));
check(
  "checkout webhook binds the exact paid subscription before provider work",
  checkoutWebhookBranch.includes("stripe_subscription_id: subId") &&
    checkoutWebhookBranch.includes('billing_state: "paid"') &&
    checkoutWebhookBranch.indexOf('billing_state: "paid"') <
      checkoutWebhookBranch.indexOf("generateLink({") &&
    checkoutWebhookBranch.indexOf('.gt("expires_at"') === -1
);
check("paid checkout profile text is scrubbed after canonical user persistence", checkoutWebhookBranch.includes("provisioned_user_id: userId") && checkoutWebhookBranch.includes("email: null") && checkoutWebhookBranch.includes("first_name: null") && checkoutWebhookBranch.includes("topics: null") && checkoutWebhookBranch.includes("checkout profile scrub failed") && checkoutMigration.includes("email_hash") && checkoutMigration.includes("provisioned_user_id"));
check(
  "scrubbed checkout retries recover through the provisioned user id",
  checkoutWebhookBranch.includes("pseudonymousStage") &&
    checkoutWebhookBranch.includes("staged.provisioned_user_id ?? null") &&
    checkoutWebhookBranch.includes("stagedBoundUserId = staged.owner_user_id") &&
    checkoutWebhookBranch.includes("getUserById(") &&
    checkoutWebhookBranch.includes("canonical checkout profile lookup failed")
);
check(
  "a different stored subscription is replaced only after fresh Stripe proof",
  checkoutWebhookBranch.includes("stored subscription verification failed") &&
    checkoutWebhookBranch.includes("priorBindingReplaceable") &&
    checkoutWebhookBranch.includes("isTerminalSubscriptionStatus(priorSubscription.status)") &&
    checkoutWebhookBranch.includes('priorAlphaPresence === "absent"') &&
    checkoutWebhookBranch.includes("priorBindingIsLiveExactAlpha")
);
check("subscription events mutate only the exact stored Customer and Subscription pair", stripeWebhook.includes('.eq("stripe_customer_id", customerId)') && stripeWebhook.includes('.eq("stripe_subscription_id", subscriptionId)') && subscriptionWebhookBranch.includes("endExactSubscriptionBinding(") && subscriptionWebhookBranch.includes("stripe_subscription_id: liveSub.id"));
check("price removal ends the exact Alpha binding and matching intent", subscriptionWebhookBranch.includes("!isAlphaSubscription(liveSub)") && subscriptionWebhookBranch.includes('"Alpha price removal"') && stripeWebhook.includes('billing_state: "ended"'));
check(
  "deleted non-Alpha snapshots are settled only through a prior exact binding",
  deletedSubscriptionBranch.includes("endExactSubscriptionBinding(") &&
    deletedSubscriptionBranch.includes("customerId,") &&
    deletedSubscriptionBranch.includes("sub.id,") &&
    deletedSubscriptionBranch.includes("settleLegacyAlphaEnd(") &&
    !deletedSubscriptionBranch.includes("isAlphaSubscription(sub)")
);
check("live subscription state is revalidated before mirroring access", stripeWebhook.includes("!isAlphaSubscription(liveSub)") && stripeWebhook.includes("live subscription customer differs from signed event") && stripeWebhook.includes("retrying without applying stale state"));
check(
  "disputes resolve an Alpha invoice and cancel and revoke only its exact subscription",
  stripeWebhook.includes("resolveAlphaBillingOrigin") &&
    stripeWebhook.includes("stripe.invoicePayments.list") &&
    stripeWebhook.includes("stripe.subscriptions.cancel(origin.subscriptionId)") &&
    /origin\.subscriptionId,\s*"dispute access revoke"/.test(stripeWebhook) &&
    !stripeWebhook.includes("cancelCustomerSubscriptions(stripe, customerId)")
);
check("checkout webhook hydrates staged topics", stripeWebhook.includes("stagedProfile") && stripeWebhook.includes("checkout_profiles"));
check("paid checkout never clears provider suppression and preserves delivery blocking", !checkoutWebhookBranch.includes("removeResendSuppression(") && checkoutWebhookBranch.includes("preserveSuppressionState: true") && checkoutWebhookBranch.includes("suppressionCleared: false") && stripeWebhook.includes("suppression_cleanup_pending_at") && cron.includes('.is("suppression_cleanup_pending_at", null)') && suppressionPendingMigration.includes("suppression_cleanup_pending_at"));
check("exact Stripe subscription identity is unique and client-protected", suppressionPendingMigration.includes("users_stripe_subscription_id_unique_idx") && suppressionPendingMigration.includes("new.stripe_subscription_id := old.stripe_subscription_id") && stripeWebhook.includes("subscriptionId: subId"));
check("account deletion cancels only one-item Alpha subscriptions with valid quantities", stripeCancel.includes("alphaItems.length === 0") && stripeCancel.includes("sub.items.data.length !== 1") && stripeCancel.includes("(quantity as number) > 5") && stripeCancel.includes("toCancel.map((sub) => stripe.subscriptions.cancel(sub.id))"));
check("account deletion fails closed on pagination or mixed Alpha lines", stripeCancel.includes("if (subs.has_more || !Array.isArray(subs.data))") && stripeCancel.includes("sub.items.has_more") && stripeCancel.includes("contains Alpha in an invalid or mixed line-item shape"));
const executableStripeCancel = stripeCancel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
check(
  "the account-wide Stripe Customer is never automatically deleted",
  stripeCancel.includes("hasNonAlphaSubscriptions") &&
    stripeCancel.includes(
      "Alpha does not delete account-wide Stripe Customers automatically"
    ) &&
    !executableStripeCancel.includes("customers.del(")
);
check("quantity changes use the stored exact Alpha subscription binding", updateQuantity.includes("stripe_subscription_id, topic_quota") && updateQuantity.includes("stripe.subscriptions.retrieve(storedSubscriptionId)") && updateQuantity.includes("!isExactAlphaSubscription(candidate, row.stripe_customer_id)"));
check("quantity legacy lookup is bounded, unique, and compare-and-set persisted", updateQuantity.includes("price: STRIPE_PRICE_ID") && updateQuantity.includes("if (subs.has_more || !Array.isArray(subs.data))") && updateQuantity.includes("if (legacyMatches.length > 1)") && updateQuantity.includes('.is("stripe_subscription_id", null)'));
check("quantity mutation never uses an unverified first item", updateQuantity.includes("!item || !isExactAlphaSubscription(sub, row.stripe_customer_id)") && updateQuantity.includes("{ items: [{ id: item.id, quantity: nextQty }] }") && updateQuantity.includes("!isExactAlphaSubscription(fresh, row.stripe_customer_id)"));
check("Stripe events use processing leases", stripeWebhook.includes("claim_stripe_webhook_event") && webhookLeaseMigration.includes("status in ('processing', 'succeeded')"));
check("an in-progress duplicate receives non-2xx", /claimDecision === "in_progress"[\s\S]{0,180}status: 409/.test(stripeWebhook));
check("only the owning lease can mark a Stripe event succeeded", /status: "succeeded"[\s\S]{0,350}\.eq\("lease_token", webhookLeaseToken\)/.test(stripeWebhook));

const access = read("../lib/access.ts");
const accessMigration = read(
  "../supabase/migrations/20260830000000_invite_access.sql"
);
check(
  "reader access requires a grant stamp plus invite or live paid access",
  /hasReaderAccess[\s\S]*!!subscribedAt[\s\S]*!!accessGrantedAt \|\| hasActiveAccess/.test(
    access
  )
);
check("issue RLS requires subscribed_at", accessMigration.includes("u.subscribed_at is not null"));
check("issue RLS honors a protected invite grant after billing ends", accessMigration.includes("u.access_granted_at is not null"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("ROUND 80 FINDINGS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ROUND 80 FINDINGS ASSERTIONS PASS");
