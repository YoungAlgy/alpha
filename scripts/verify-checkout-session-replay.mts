// Fully local checks for checkout Session creation replay. Secrets are injected
// test strings. No env file, provider, database, or network call is made.
import { readFileSync } from "node:fs";
import {
  decryptCheckoutSessionEmail,
  encryptCheckoutSessionEmail,
} from "../lib/checkout-session-email.ts";
import {
  CHECKOUT_SESSION_PARAMS_VERSION,
  alphaCheckoutSessionCreateParams,
  alphaCheckoutSessionIdempotencyKey,
  checkoutSessionMatchesPersistedRequest,
} from "../lib/checkout-session-params.ts";
import {
  definitiveExpiredCreateRejection,
  reconcileStaleCheckoutSessionCreations,
} from "../lib/checkout-creation-recovery.ts";
import { alphaAccessMode } from "../lib/access-mode.ts";
import {
  countDeadLetteredCheckoutProfiles,
  finalizeStaleCheckoutFulfillments,
  scrubTerminalCheckoutTombstones,
} from "../lib/checkout-profile-retention.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed += 1;
  else failed += 1;
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function sqlFunctionBody(sql: string, functionName: string): string {
  const start = sql.indexOf(
    `create or replace function public.${functionName}`
  );
  if (start < 0) throw new Error(`missing SQL function ${functionName}`);
  const bodyStart = sql.indexOf("as $$", start);
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error(`malformed SQL function ${functionName}`);
  }
  return sql.slice(bodyStart + 5, bodyEnd);
}

const profileId = "11111111-1111-4111-8111-111111111111";
const email = "reader@example.com";
const secret = "local-test-checkout-root-secret-a";

console.log("(1) exact Session email encryption is authenticated and domain-bound");
const first = encryptCheckoutSessionEmail(email, profileId, secret);
const second = encryptCheckoutSessionEmail(email, profileId, secret);
check(
  "(1a) a versioned ciphertext round-trips",
  first.startsWith("v1.") &&
    decryptCheckoutSessionEmail(first, profileId, secret) === email
);
check("(1b) fresh random nonces produce different envelopes", first !== second);

const parts = first.split(".");
const tamperedPayload = Buffer.from(parts[2], "base64url");
tamperedPayload[0] ^= 1;
const tampered = [
  parts[0],
  parts[1],
  tamperedPayload.toString("base64url"),
  parts[3],
].join(".");
check(
  "(1c) ciphertext tampering fails authentication",
  throws(() => decryptCheckoutSessionEmail(tampered, profileId, secret))
);
check(
  "(1d) the wrong root secret cannot decrypt",
  throws(() =>
    decryptCheckoutSessionEmail(
      first,
      profileId,
      "local-test-checkout-root-secret-b"
    )
  )
);
check(
  "(1e) ciphertext cannot move to another profile",
  throws(() =>
    decryptCheckoutSessionEmail(
      first,
      "22222222-2222-4222-8222-222222222222",
      secret
    )
  )
);
check(
  "(1f) plaintext must already be normalized",
  throws(() =>
    encryptCheckoutSessionEmail("Reader@Example.com", profileId, secret)
  )
);

console.log("(2) stable persisted inputs reproduce the exact Stripe request");
const expiresAtEpochSeconds = 1_800_000_000;
const paramsInput = {
  profileId,
  customerEmail: email,
  origin: "https://alpha.everyday.report",
  priceId: "price_alpha_test",
  expiresAtEpochSeconds,
  paramsVersion: CHECKOUT_SESSION_PARAMS_VERSION,
};
const paramsA = alphaCheckoutSessionCreateParams(paramsInput);
const paramsB = alphaCheckoutSessionCreateParams({ ...paramsInput });
check(
  "(2a) identical persisted inputs build byte-equivalent parameters",
  JSON.stringify(paramsA) === JSON.stringify(paramsB)
);
check(
  "(2b) the idempotency key depends only on the durable profile id",
  alphaCheckoutSessionIdempotencyKey(profileId) ===
    `alpha-checkout-${profileId}`
);
check(
  "(2c) a replayed Session must match owner metadata, email, and exact expiry",
  checkoutSessionMatchesPersistedRequest(
    {
      id: "cs_test",
      mode: "subscription",
      metadata: { alpha_profile_id: profileId },
      expires_at: expiresAtEpochSeconds,
      customer_email: email,
    } as never,
    { profileId, customerEmail: email, expiresAtEpochSeconds }
  )
);
check(
  "(2d) a changed expiry is rejected",
  !checkoutSessionMatchesPersistedRequest(
    {
      id: "cs_test",
      mode: "subscription",
      metadata: { alpha_profile_id: profileId },
      expires_at: expiresAtEpochSeconds + 1,
      customer_email: email,
    } as never,
    { profileId, customerEmail: email, expiresAtEpochSeconds }
  )
);

console.log("(3) only signed terminal provider evidence can retire an unbound replay");
check(
  "(3a) exact structured expires_at rejection is accepted",
  definitiveExpiredCreateRejection({
    type: "StripeInvalidRequestError",
    statusCode: 400,
    param: "expires_at",
    requestId: "req_local_test_1",
  })?.requestId === "req_local_test_1"
);
for (const candidate of [
  { type: "StripeInvalidRequestError", statusCode: 400, param: "expires_at" },
  {
    type: "StripeInvalidRequestError",
    statusCode: 500,
    param: "expires_at",
    requestId: "req_wrong_status",
  },
  {
    type: "StripeInvalidRequestError",
    statusCode: 400,
    param: "customer_email",
    requestId: "req_wrong_param",
  },
  {
    type: "StripeInvalidRequestError",
    statusCode: 400,
    param: "expires_at",
    requestId: "not_a_provider_request",
  },
]) {
  check(
    "(3b) ambiguous rejection remains unresolved",
    definitiveExpiredCreateRejection(candidate) === null
  );
}

console.log("(4) route and migration keep the replay parameters durable");
const route = readFileSync(
  new URL("../app/api/stripe/checkout/route.ts", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260827000000_checkout_fulfillment_claims.sql",
    import.meta.url
  ),
  "utf8"
);
const recovery = readFileSync(
  new URL("../lib/checkout-creation-recovery.ts", import.meta.url),
  "utf8"
);
const maintenance = readFileSync(
  new URL("../app/api/cron/maintenance/route.ts", import.meta.url),
  "utf8"
);
check(
  "(4a) Session expiry and the shorter Alpha business deadline are separate",
  migration.includes("interval '23 hours'") &&
    migration.includes("interval '31 minutes'") &&
    route.includes("stripe_session_business_expires_at")
);
check(
  "(4b) exact encrypted email clears on Session bind and terminal proof",
  /bind_checkout_session[\s\S]*stripe_session_customer_email_ciphertext = null/.test(
    migration
  ) &&
    /settle_checkout_session_creation_replay[\s\S]*stripe_session_customer_email_ciphertext = null/.test(
      migration
    )
);
check(
  "(4c) stale creation uses a bounded durable replay lease",
  migration.includes("claim_checkout_session_creation_replay") &&
    migration.includes("session_creation_replay_lease_expires_at") &&
    migration.includes("p_lease_seconds is null")
);
check(
  "(4d) checkout and recovery share one stable idempotency-key helper",
  route.includes("alphaCheckoutSessionIdempotencyKey") &&
    route.includes("alphaCheckoutSessionCreateParams")
);
check(
  "(4e) a failed oldest replay receives a five-minute creation lease backoff",
  /release_checkout_session_creation_replay[\s\S]*session_creation_lease_expires_at = now\(\) \+ interval '5 minutes'/.test(
    migration
  ) &&
    recovery.includes('"list_stale_checkout_session_creations"')
);

console.log("(5) a missed replay window becomes a durable manual review");
check(
  "(5a) the replay claim records a PII-free review before returning missed-window",
  /claim_checkout_session_creation_replay[\s\S]*insert into public\.checkout_creation_reviews[\s\S]*'replay_window_missed'::text/.test(
    migration
  ) &&
    /create table public\.checkout_creation_reviews[\s\S]*profile_id[\s\S]*status[\s\S]*resolved_session_id[\s\S]*proof_reference/.test(
      migration
    )
);
check(
  "(5b) account deletion cannot pass billing clean with a pending creation review",
  /confirm_account_deletion_billing[\s\S]*from public\.checkout_creation_reviews review[\s\S]*review\.status = 'pending'/.test(
    migration
  )
);
check(
  "(5c) operator Session resolution goes through normal bind and terminal settlement",
  recovery.includes("resolveCheckoutCreationReviewWithSession") &&
    recovery.includes('"bind_checkout_session"') &&
    recovery.includes('"settle_checkout_session_expiration"') &&
    recovery.includes('"complete_checkout_creation_review_with_session"')
);
check(
  "(5d) no-create resolution requires a controlled proof reference and clears ciphertext atomically",
  migration.includes(
    "!~ '^(req|evt|case|ticket)_[A-Za-z0-9_-]+$'"
  ) &&
    /resolve_checkout_creation_review_no_create[\s\S]*stripe_session_customer_email_ciphertext = null/.test(
      migration
    ) &&
    recovery.includes("resolveCheckoutCreationReviewNoCreate")
);
check(
  "(5e) only service role can resolve or count the review queue",
  migration.includes(
    "grant execute on function public.complete_checkout_creation_review_with_session(uuid, text)"
  ) &&
    migration.includes(
      "grant execute on function public.resolve_checkout_creation_review_no_create(uuid, text)"
    ) &&
    migration.includes(
      "grant execute on function public.count_pending_checkout_creation_reviews()"
    ) &&
    migration.includes(
      "grant execute on function public.list_stale_checkout_session_creations(timestamptz, integer)"
    )
);
check(
  "(5f) automated and operator binds expire and re-read an exact open Session when deletion already owns the profile",
  recovery.includes("expireDeletionPendingSession") &&
    /bind === "deletion_pending"[\s\S]*expireDeletionPendingSession/.test(
      recovery
    ) &&
    /bindData === "deletion_pending"[\s\S]*expireDeletionPendingSession/.test(
      recovery
    ) &&
    /checkout\.sessions\.expire[\s\S]*checkout\.sessions\.retrieve[\s\S]*verified\.status !== "expired"/.test(
      recovery
  )
);

console.log("(5h) invite mode holds stale creation for operator review before Stripe");
const oldPublicAccessMode = process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
const oldServerAccessMode = process.env.ALPHA_ACCESS_MODE;
function setAccessModeEnvironment(
  publicMode: string | undefined,
  serverMode: string | undefined
) {
  if (publicMode === undefined) {
    delete process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE;
  } else {
    process.env.NEXT_PUBLIC_ALPHA_ACCESS_MODE = publicMode;
  }
  if (serverMode === undefined) {
    delete process.env.ALPHA_ACCESS_MODE;
  } else {
    process.env.ALPHA_ACCESS_MODE = serverMode;
  }
}
try {
  for (const [publicMode, serverMode, expected] of [
    [undefined, undefined, "invite"],
    ["paid", undefined, "invite"],
    [undefined, "paid", "invite"],
    ["paid", "paused", "invite"],
    ["PAID ", " paid", "paid"],
  ] as const) {
    setAccessModeEnvironment(publicMode, serverMode);
    check(
      "(5h-0) server access mode requires both explicit paid opt-ins",
      alphaAccessMode(true) === expected
    );
  }
} finally {
  setAccessModeEnvironment(oldPublicAccessMode, oldServerAccessMode);
}
const inviteRpcCalls: string[] = [];
let inviteStripeCreates = 0;
let inviteRecovery;
try {
  setAccessModeEnvironment(undefined, undefined);
  inviteRecovery = await reconcileStaleCheckoutSessionCreations(
    {
      rpc: async (name: string) => {
        inviteRpcCalls.push(name);
        if (name === "list_stale_checkout_session_creations") {
          return { data: [{ profile_id: profileId }], error: null };
        }
        if (name === "hold_checkout_session_creation_for_invite_review") {
          return { data: "review_required", error: null };
        }
        throw new Error(`unexpected invite recovery RPC: ${name}`);
      },
    } as never,
    {
      nowIso: "2026-08-31T12:00:00.000Z",
      limit: 1,
      stripeClient: {
        checkout: {
          sessions: {
            create: async () => {
              inviteStripeCreates += 1;
              throw new Error("invite recovery reached Stripe");
            },
          },
        },
      } as never,
    }
  );
} finally {
  setAccessModeEnvironment(oldPublicAccessMode, oldServerAccessMode);
}
check(
  "(5h-a) invite recovery calls only local discovery and the durable review hold",
  inviteRpcCalls.join(",") ===
    "list_stale_checkout_session_creations,hold_checkout_session_creation_for_invite_review" &&
    inviteStripeCreates === 0
);
check(
  "(5h-b) invite recovery exposes the held row without claiming or settling it",
  inviteRecovery?.inspected === 1 &&
    inviteRecovery.reviewRequired === 1 &&
    inviteRecovery.claimed === 0 &&
    inviteRecovery.bound === 0 &&
    inviteRecovery.expired === 0 &&
    inviteRecovery.errors.length === 0
);
const inviteHoldBody = sqlFunctionBody(
  migration,
  "hold_checkout_session_creation_for_invite_review"
);
check(
  "(5h-c) the service-only hold locks and rechecks the due row, then writes only a pending review marker",
  inviteHoldBody.includes("for update") &&
    inviteHoldBody.includes("session_creation_lease_expires_at > p_now") &&
    inviteHoldBody.includes("session_creation_replay_lease_expires_at > p_now") &&
    inviteHoldBody.includes("'invite_mode_transition'") &&
    inviteHoldBody.includes("'pending'") &&
    !inviteHoldBody.includes("update public.checkout_profiles") &&
    migration.includes(
      "grant execute on function public.hold_checkout_session_creation_for_invite_review(uuid, timestamptz)"
    )
);
check(
  "(5h-d) a paid replay claim loses the hold race and returns manual review before provider work",
  /claim_checkout_session_creation_replay[\s\S]*checkout_creation_reviews review[\s\S]*review\.status = 'pending'[\s\S]*'manual_review'::text/.test(
    migration
  ) &&
    /claim\.decision === "manual_review"[\s\S]*result\.reviewRequired \+= 1[\s\S]*continue/.test(
      recovery
    )
);
check(
  "(5h-e) maintenance derives invite mode before its service client and reports the review as red",
  maintenance.indexOf("isInviteOnly(true)") >= 0 &&
    maintenance.indexOf("isInviteOnly(true)") <
      maintenance.indexOf("await supabaseServiceClient()") &&
    maintenance.includes("checkoutCreation.reviewRequired > 0") &&
    maintenance.includes("held ${checkoutCreation.reviewRequired} for operator review")
);

console.log("(6) terminal checkout identity has a finite retention window");
let terminalScrubArgs: Record<string, unknown> | null = null;
const terminalScrub = await scrubTerminalCheckoutTombstones(
  {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      terminalScrubArgs = args;
      return {
        data: [{ profiles_scrubbed: 2, fulfillments_scrubbed: 3 }],
        error: null,
      };
    },
  } as never,
  "2026-08-28T12:00:00.000Z",
  500
);
check(
  "(6a) the service helper bounds each local scrub batch",
  terminalScrub.profilesScrubbed === 2 &&
    terminalScrub.fulfillmentsScrubbed === 3 &&
    terminalScrubArgs?.p_limit === 100
);
check(
  "(6b) terminal profiles clear every stable owner, email, browser, and recurring-billing link after 180 days",
  /scrub_terminal_checkout_tombstones[\s\S]*interval '180 days'[\s\S]*email_hash = null[\s\S]*browser_nonce_hash = null[\s\S]*owner_user_id = null[\s\S]*provisioned_user_id = null[\s\S]*stripe_customer_id = null[\s\S]*stripe_subscription_id = null/.test(
    migration
  )
);
check(
  "(5g) a pending manual review is excluded from automated replay discovery",
  /list_stale_checkout_session_creations[\s\S]*not exists \([\s\S]*checkout_creation_reviews review[\s\S]*review\.status = 'pending'/.test(
    migration
  ) &&
    recovery.includes('"list_stale_checkout_session_creations"') &&
    !/reconcileStaleCheckoutSessionCreations[\s\S]*\.from\("checkout_profiles"\)/.test(
      recovery
    )
);
check(
  "(6c) completed fulfillment keeps only its replay tombstone after the same window",
  /scrub_terminal_checkout_tombstones[\s\S]*f\.status = 'completed'[\s\S]*f\.completed_at <= p_now - interval '180 days'[\s\S]*update public\.checkout_fulfillments[\s\S]*email_hash = null[\s\S]*user_id = null/.test(
    migration
  )
);
check(
  "(6d) the terminal scrub is service-only and remains maintenance-visible",
  migration.includes(
    "grant execute on function public.scrub_terminal_checkout_tombstones(timestamptz, integer)"
  ) &&
    readFileSync(
      new URL(
        "../supabase/migrations/20260827030000_legacy_checkout_fulfillments.sql",
        import.meta.url
      ),
      "utf8"
    ).includes("p.updated_at <= p_now - interval '180 days'")
);

console.log("(7) stale local replay rows close without provider guesses");
let finalizerRpcName = "";
let finalizerArgs: Record<string, unknown> | null = null;
const finalizer = await finalizeStaleCheckoutFulfillments(
  {
    rpc: async (name: string, args: Record<string, unknown>) => {
      finalizerRpcName = name;
      finalizerArgs = args;
      return {
        data: [{ completed_count: 4, aborted_count: 2 }],
        error: null,
      };
    },
  } as never,
  "2026-08-28T12:00:00.000Z",
  500
);
check(
  "(7a) the service helper calls only the local finalizer and bounds its batch",
  finalizerRpcName === "finalize_stale_checkout_fulfillments" &&
    finalizerArgs?.p_now === "2026-08-28T12:00:00.000Z" &&
    finalizerArgs?.p_limit === 100 &&
    finalizer.completed === 4 &&
    finalizer.aborted === 2
);
check(
  "(7b) malformed finalizer counts fail closed",
  await rejects(() =>
    finalizeStaleCheckoutFulfillments({
      rpc: async () => ({
        data: [{ completed_count: null, aborted_count: 0 }],
        error: null,
      }),
    } as never)
  )
);
check(
  "(7c) dead letters are counted through an exact service RPC",
  (await countDeadLetteredCheckoutProfiles({
    rpc: async (name: string) => ({
      data: name === "count_dead_lettered_checkout_profiles" ? 3 : null,
      error: null,
    }),
  } as never)) === 3
);
check(
  "(7d) a null dead-letter count is rejected instead of becoming zero",
  await rejects(() =>
    countDeadLetteredCheckoutProfiles({
      rpc: async () => ({ data: null, error: null }),
    } as never)
  )
);

const finalizerBody = sqlFunctionBody(
  migration,
  "finalize_stale_checkout_fulfillments"
);
const profileLockIndex = finalizerBody.indexOf("into v_profile");
const ownerLockIndex = finalizerBody.indexOf("pg_try_advisory_xact_lock");
const fulfillmentLockIndex = finalizerBody.indexOf("into v_fulfillment");
check(
  "(7e) the finalizer locks profile, owner, then fulfillment and skips a live lease",
  profileLockIndex >= 0 &&
    ownerLockIndex > profileLockIndex &&
    fulfillmentLockIndex > ownerLockIndex &&
    /lease_expires_at > p_now[\s\S]*continue;/.test(finalizerBody)
);
check(
  "(7f) terminal profiles abort and identity-scrub their stale replay row",
  /billing_state in \('ended', 'expired'\)[\s\S]*status = 'aborted'[\s\S]*email_hash = null[\s\S]*user_id = null[\s\S]*identity_scrubbed_at/.test(
    finalizerBody
  )
);
check(
  "(7g) an exact issue completes and identity-scrubs the replay row",
  /i\.user_id = v_profile\.provisioned_user_id[\s\S]*i\.week_of = v_fulfillment\.week_of[\s\S]*status = 'completed'[\s\S]*email_hash = null[\s\S]*user_id = null[\s\S]*identity_scrubbed_at/.test(
    finalizerBody
  )
);
check(
  "(7h) a provisioned replay without an issue waits 24 hours before abort and scrub",
  /v_fulfillment\.created_at <= p_now - interval '24 hours'[\s\S]*status = 'aborted'[\s\S]*email_hash = null[\s\S]*user_id = null[\s\S]*identity_scrubbed_at/.test(
    finalizerBody
  )
);
check(
  "(7i) finalizer, dead-letter count, and exact requeue are service-only",
  /revoke all on function public\.finalize_stale_checkout_fulfillments\(timestamptz, integer\)\s+from public, anon, authenticated/.test(
    migration
  ) &&
    /grant execute on function public\.finalize_stale_checkout_fulfillments\(timestamptz, integer\)\s+to service_role/.test(
      migration
    ) &&
    /revoke all on function public\.count_dead_lettered_checkout_profiles\(\)\s+from public, anon, authenticated/.test(
      migration
    ) &&
    /grant execute on function public\.requeue_checkout_profile_recovery\(uuid\)\s+to service_role/.test(
      migration
    )
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("CHECKOUT SESSION REPLAY VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CHECKOUT SESSION REPLAY ASSERTIONS PASS");
