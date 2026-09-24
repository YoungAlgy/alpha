// Deterministic, local-only verification for Round 80 delivery/access fixes.
// This script reads source files and exercises the pure checkout mutation
// helper. It never loads .env.local and never contacts a provider or database.
import { readFileSync } from "node:fs";
import { checkoutUserMutation } from "../lib/webhook-user-mutation.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "OK " : "XX "} ${label}`);
  if (condition) passed++;
  else failed++;
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

type RevokeRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  access_requested_at: string | null;
  subscribed_at: string | null;
  access_granted_at: string | null;
  cancelled_at: string | null;
};

function isRevokeRowField(field: string): field is keyof RevokeRow {
  return (
    field === "stripe_customer_id" ||
    field === "stripe_subscription_id" ||
    field === "access_requested_at" ||
    field === "subscribed_at" ||
    field === "access_granted_at" ||
    field === "cancelled_at"
  );
}

function revokeSupabaseDouble(
  row: RevokeRow,
  changesBeforeWrite: Partial<RevokeRow> | null = null
) {
  const currentRow: RevokeRow = { ...row };
  let writeStarted = false;
  const writeFilters: Array<{ field: keyof RevokeRow; value: string | null }> = [];
  let writes = 0;
  const chain = {
    select: (fields: string) => {
      void fields;
      if (!writeStarted) return chain;
      if (changesBeforeWrite) Object.assign(currentRow, changesBeforeWrite);
      const matched = writeFilters.every(
        ({ field, value }) => currentRow[field] === value
      );
      if (!matched) {
        return Promise.resolve({ data: [], error: null });
      }
      writes++;
      return Promise.resolve({ data: [{ id: "reader" }], error: null });
    },
    eq: (field: string, value: unknown) => {
      if (writeStarted && field !== "id") {
        if (!isRevokeRowField(field) || (value !== null && typeof value !== "string")) {
          throw new Error(`unexpected revoke compare-and-swap filter: ${field}`);
        }
        writeFilters.push({
          field,
          value,
        });
      }
      return chain;
    },
    is: (field: string, value: unknown) => {
      if (writeStarted && field !== "id") {
        if (!isRevokeRowField(field) || (value !== null && typeof value !== "string")) {
          throw new Error(`unexpected revoke compare-and-swap filter: ${field}`);
        }
        writeFilters.push({
          field,
          value,
        });
      }
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
    update: (patch: Record<string, unknown>) => {
      void patch;
      writeStarted = true;
      return chain;
    },
  };
  return {
    sb: {
      from: (table: string) => {
        void table;
        return chain;
      },
    },
    get writes() {
      return writes;
    },
  };
}

console.log("(1) free-access revocation closes send and archive access atomically");
{
  const src = read("../app/api/admin/users/route.ts");
  const start = src.indexOf('if (body.action === "revoke_free")');
  const end = src.indexOf("return NextResponse.json({ ok: true });", start);
  const branch = src.slice(start, end);
  check("revoke branch stamps an explicit revocation time", /const revokedAt = new Date\(\)\.toISOString\(\);/.test(branch));
  check(
    "one UPDATE clears subscribed_at, the pending request, invite access, and sets cancelled_at",
    /\.update\(\{[\s\S]*?subscribed_at:\s*null,[\s\S]*?access_requested_at:\s*null,[\s\S]*?access_granted_at:\s*null,[\s\S]*?cancelled_at:\s*revokedAt,[\s\S]*?\}\)/.test(
      branch
    )
  );
  check(
    "free revoke reads and compare-and-swaps each access and billing field it clears",
    /stripe_customer_id, stripe_subscription_id, access_requested_at, subscribed_at, access_granted_at, cancelled_at/.test(branch) &&
      /!isFreeGrantEligible\(row\.stripe_customer_id\) \|\| row\.stripe_subscription_id/.test(branch) &&
      /\.is\("stripe_customer_id", null\)[\s\S]*?\.is\("stripe_subscription_id", null\)/.test(branch) &&
      /row\.access_requested_at[\s\S]*?row\.subscribed_at[\s\S]*?row\.access_granted_at[\s\S]*?row\.cancelled_at/.test(branch)
  );

  // Execute the current route branch in an isolated function with a tiny
  // PostgREST-chain double. This tests the real branch expression and its
  // chained write filters without importing route dependencies or loading env.
  const branchEnd = src.indexOf('\n\n  return NextResponse.json({ error: "Unknown action"', start);
  const executableBranch = src.slice(start, branchEnd);
  const runRevoke = new Function(
    "body",
    "sb",
    "NextResponse",
    "isFreeGrantEligible",
    `return (async () => { ${executableBranch} })();`
  ) as (
    body: { action: string; userId: string },
    sb: ReturnType<typeof revokeSupabaseDouble>["sb"],
    NextResponse: { json: (body: unknown, init?: { status?: number }) => unknown },
    isFreeGrantEligible: (customerId: string | null | undefined) => boolean
  ) => Promise<{ body: unknown; status: number }>;
  const response = {
    json: (body: unknown, init: { status?: number } = {}) => ({
      body,
      status: init.status ?? 200,
    }),
  };
  const existingSubscription = revokeSupabaseDouble({
    stripe_customer_id: null,
    stripe_subscription_id: "sub_existing",
    access_requested_at: null,
    subscribed_at: null,
    access_granted_at: null,
    cancelled_at: null,
  });
  const existingSubscriptionResult = await runRevoke(
    { action: "revoke_free", userId: "reader-1" },
    existingSubscription.sb,
    response,
    (customerId) => !customerId
  );
  check(
    "behavioral: existing Subscription ID returns 400 before any UPDATE",
    existingSubscriptionResult.status === 400 && existingSubscription.writes === 0
  );

  const attachedMidFlight = revokeSupabaseDouble({
    stripe_customer_id: null,
    stripe_subscription_id: null,
    access_requested_at: null,
    subscribed_at: null,
    access_granted_at: null,
    cancelled_at: null,
  }, { stripe_subscription_id: "sub_arrived" });
  const attachedMidFlightResult = await runRevoke(
    { action: "revoke_free", userId: "reader-2" },
    attachedMidFlight.sb,
    response,
    (customerId) => !customerId
  );
  check(
    "behavioral: Subscription ID attached after read returns 409 with no applied write",
    attachedMidFlightResult.status === 409 && attachedMidFlight.writes === 0
  );

  // Vary each overwritten field separately. A simultaneous three-field change
  // could pass with only one of the required guards actually present.
  for (const field of ["access_requested_at", "subscribed_at", "access_granted_at", "cancelled_at"] as const) {
    for (const before of [null, "2026-09-04T12:00:00.000Z"]) {
      const concurrentAccessChange = revokeSupabaseDouble({
        stripe_customer_id: null,
        stripe_subscription_id: null,
        access_requested_at: before,
        subscribed_at: before,
        access_granted_at: before,
        cancelled_at: before,
      }, { [field]: "2026-09-05T12:00:00.000Z" });
      const result = await runRevoke(
        { action: "revoke_free", userId: "reader-3" },
        concurrentAccessChange.sb, response, (customerId) => !customerId
      );
      check(
        `behavioral: changed ${field} from ${before === null ? "null" : "existing clock"} returns 409 without an applied write`,
        result.status === 409 && concurrentAccessChange.writes === 0
      );
    }
  }

  const unchanged = revokeSupabaseDouble({
    stripe_customer_id: null,
    stripe_subscription_id: null,
    access_requested_at: null,
    subscribed_at: null,
    access_granted_at: null,
    cancelled_at: null,
  });
  const unchangedResult = await runRevoke(
    { action: "revoke_free", userId: "reader-4" },
    unchanged.sb,
    response,
    (customerId) => !customerId
  );
  check(
    "behavioral: unchanged eligible row is revoked once",
    unchangedResult.status === 200 && unchanged.writes === 1
  );
}

console.log("(1b) free-access approval is separate from explicit delivery recovery");
{
  const src = read("../app/api/admin/users/route.ts");
  const start = src.indexOf('if (body.action === "grant_free")');
  const end = src.indexOf('if (body.action === "revoke_free")', start);
  const branch = src.slice(start, end);
  const updateIdx = branch.indexOf(".update({");
  check("canonical stored email is required before free approval", /const normalizedEmail = existing\.email\?\.toLowerCase\(\)\.trim\(\);/.test(branch) && /normalizedEmail !== existing\.email/.test(branch));
  check("free approval makes no provider suppression call", !branch.includes("removeResendSuppression("));
  check("free approval preserves every delivery-policy field", updateIdx > -1 && !/\.update\(\{[\s\S]*?unsubscribed_at:\s*null/.test(branch) && !/\.update\(\{[\s\S]*?bounced_at:\s*null/.test(branch) && !/\.update\(\{[\s\S]*?complained_at:\s*null/.test(branch) && !/\.update\(\{[\s\S]*?suppression_cleanup_pending_at:/.test(branch) && !/\.update\(\{[\s\S]*?delivery_suppression_cleared_at:/.test(branch));
  check("the access write still binds email, both Stripe fields, and the delivery snapshots", /\.eq\("email", existing\.email\)[\s\S]*?\.is\("stripe_customer_id", null\)[\s\S]*?\.is\("stripe_subscription_id", null\)/.test(branch) && /grant = existing\.unsubscribed_at/.test(branch) && /grant = existing\.bounced_at/.test(branch) && /grant = existing\.complained_at/.test(branch) && /grant = existing\.suppression_cleanup_pending_at/.test(branch) && /grant = existing\.delivery_suppression_cleared_at/.test(branch));
}

console.log("(2) Resend suppression audit and user mutation share one retriable transaction");
{
  const src = read("../app/api/webhooks/resend/route.ts");
  const migration = read("../supabase/migrations/20260830050000_resend_suppression_causality.sql");
  const timestampIdx = src.indexOf("parseResendEventCreatedAt(event.created_at)");
  const rpcIdx = src.indexOf('"record_resend_suppression_event"');
  const failureIdx = src.indexOf("suppression transaction failed");
  check("signed event.created_at is validated before the database call", timestampIdx > -1 && timestampIdx < rpcIdx && /event timestamp invalid[\s\S]*?status: 500/.test(src));
  check("handler delegates audit and suppression to the atomic RPC", rpcIdx > -1 && !src.includes('.from("resend_webhook_events")'));
  check("RPC receives exact message ID, event type, signed time, and normalized recipients", /p_email_id: emailId,\s*p_event_type: event\.type,\s*p_event_at: eventAt,\s*p_recipients: recipients/.test(src));
  check(
    "invalid or failed RPC output reaches the ops alert and HTTP 500 path",
    /recordError \|\|[\s\S]*?"applied",[\s\S]*?"causally_ignored",[\s\S]*?"pending_owner",[\s\S]*?"manual_review",[\s\S]*?"legacy_review",[\s\S]*?\.includes\(status\)[\s\S]*?sendOpsWebhookAlert\([\s\S]*?suppression write failed[\s\S]*?status: 500/.test(
      src
    ) && failureIdx > rpcIdx
  );
  check("database function inserts the dedup audit row and mutates users in one invocation", /create or replace function public\.record_resend_suppression_event\([\s\S]*?insert into public\.resend_webhook_events[\s\S]*?on conflict \(email_id, type\) do nothing;[\s\S]*?apply_resend_suppression_to_user\(/.test(migration));
  check("a duplicate audit key still reaches the monotonic user update", /on conflict \(email_id, type\) do nothing;[\s\S]*?for update;[\s\S]*?apply_resend_suppression_to_user\(/.test(migration) && !/on conflict \(email_id, type\) do nothing;[\s\S]{0,180}return/.test(migration));
  check(
    "finalized attempt or one-snapshot legacy issue ownership binds a message to its actual user",
    /from public\.resend_delivery_attempts[\s\S]*?where resend_message_id = p_email_id;[\s\S]*?v_target_user_id := v_attempt_user_id;/.test(
      migration
    ) &&
      /select\s+count\(\*\)::integer,\s+\(array_agg\(user_id\)\)\[1\],[\s\S]*?from public\.issues\s+where resend_message_id = p_email_id;[\s\S]*?v_target_user_id := v_issue_user_id;/.test(
        migration
      ) &&
      /apply_resend_suppression_to_user\([\s\S]*?v_target_user_id,[\s\S]*?v_existing_hashes/.test(
        migration
      )
  );
  check("post-clear replays are blocked by the protected causal watermark", /v_user\.delivery_suppression_cleared_at is not null[\s\S]*?v_user\.delivery_suppression_cleared_at > p_event_at/.test(migration));
  check("the suppression RPC is callable only by service_role", /revoke all on function public\.record_resend_suppression_event\(text, text, timestamptz, text\[\]\)[\s\S]*?from public, anon, authenticated;[\s\S]*?grant execute on function public\.record_resend_suppression_event\(text, text, timestamptz, text\[\]\)[\s\S]*?to service_role;/.test(migration));
}

console.log("(3) self-delete stops before auth deletion when billing lookup is uncertain");
{
  const src = read("../app/api/account/delete/route.ts");
  const rowErrorIdx = src.indexOf("if (rowErr)");
  const missingRowIdx = src.indexOf("if (!row)", rowErrorIdx);
  const deleteIdx = src.indexOf("await svc.auth.admin.deleteUser(user.id)");
  check("query-error guard exists before deleteUser", rowErrorIdx > -1 && rowErrorIdx < deleteIdx);
  check("missing-row drift guard exists before deleteUser", missingRowIdx > rowErrorIdx && missingRowIdx < deleteIdx);
  check("both guards state that nothing was deleted", (src.match(/Nothing was deleted/g) ?? []).length >= 2);
}

console.log("(4) checkout access and suppression mutations fail closed");
{
  const base = {
    userId: "u-r80",
    email: "reader@example.com",
    firstName: "Reader",
    city: "Tampa, FL",
    customerId: "cus_r80",
    subscriptionId: "sub_r80",
    priorBindingReplaceable: false,
    nowIso: "2026-08-27T12:00:00.000Z",
    checkoutStartedAtIso: "2026-08-27T11:00:00.000Z",
    subscriptionLive: true,
    suppressionCleared: true,
  };
  const live = checkoutUserMutation(null, base);
  check("verified live checkout may insert active access", live.kind === "insert" && live.row.subscribed_at === base.nowIso);
  const ended = checkoutUserMutation(null, { ...base, subscriptionLive: false });
  check("ended checkout cannot insert active access", ended.kind === "skip" && ended.reason === "subscription-not-live");
  const suppressionFailed = checkoutUserMutation(
    { subscribed_at: "2026-08-01T00:00:00.000Z", cancelled_at: null },
    { ...base, suppressionCleared: false }
  );
  check(
    "failed provider cleanup preserves access behind a pending-delivery marker",
    suppressionFailed.kind === "update" &&
      suppressionFailed.patch.suppression_cleanup_pending_at === base.nowIso &&
      !("bounced_at" in suppressionFailed.patch) &&
      !("complained_at" in suppressionFailed.patch)
  );
  const existingCheckoutUserWithDeliveryMetadata = {
    subscribed_at: "2026-08-01T00:00:00.000Z",
    cancelled_at: null,
    unsubscribed_at: "2026-08-02T00:00:00.000Z",
    bounced_at: "2026-08-03T00:00:00.000Z",
    complained_at: "2026-08-04T00:00:00.000Z",
    suppression_cleanup_pending_at: "2026-08-05T00:00:00.000Z",
    delivery_suppression_cleared_at: "2026-08-06T00:00:00.000Z",
  };
  const checkoutPreserved = checkoutUserMutation(
    existingCheckoutUserWithDeliveryMetadata,
    { ...base, suppressionCleared: false, preserveSuppressionState: true }
  );
  check(
    "paid checkout preserves every delivery-suppression field",
    checkoutPreserved.kind === "update" &&
      !("bounced_at" in checkoutPreserved.patch) &&
      !("complained_at" in checkoutPreserved.patch) &&
      !("suppression_cleanup_pending_at" in checkoutPreserved.patch) &&
      !("delivery_suppression_cleared_at" in checkoutPreserved.patch)
  );
  check(
    "paid checkout still clears an older explicit unsubscribe",
    checkoutPreserved.kind === "update" &&
      checkoutPreserved.patch.unsubscribed_at === null
  );
  const newerUnsubscribe = checkoutUserMutation(
    {
      subscribed_at: "2026-08-01T00:00:00.000Z",
      cancelled_at: null,
      unsubscribed_at: "2026-08-27T11:01:00.000Z",
    },
    { ...base, suppressionCleared: false, preserveSuppressionState: true }
  );
  check(
    "a direct unsubscribe after checkout remains effective despite paid re-consent",
    newerUnsubscribe.kind === "update" &&
      !("unsubscribed_at" in newerUnsubscribe.patch)
  );
  const cleanPreserved = checkoutUserMutation(null, {
    ...base,
    suppressionCleared: false,
    preserveSuppressionState: true,
  });
  check(
    "preservation mode creates no synthetic pending marker for a clean account",
    cleanPreserved.kind === "insert" &&
      cleanPreserved.row.suppression_cleanup_pending_at === null
  );

  const route = read("../app/api/stripe/webhook/route.ts");
  const mutationIdx = route.indexOf("const mut = checkoutUserMutation(");
  check("paid checkout has no automatic provider suppression removal", !route.includes("removeResendSuppression(accountEmail)"));
  check("paid checkout opts into suppression-state preservation", /preserveSuppressionState:\s*true/.test(route) && mutationIdx > -1);
  check("paid checkout has no provider-cleanup failure gate", !route.includes("could not clear Resend suppression for checkout email"));
  check("subscription retrieval failure is routed to the webhook 500 path", /could not verify checkout subscription as live/.test(route));
  check("checkout still records its mutation timestamp for access and CAS", /nowIso: checkoutMutationAt/.test(route) && /suppression_cleanup_pending_at/.test(route));
}

console.log("(5) active billing identifiers have database shape guards");
{
  const migration = read(
    "../supabase/migrations/20260827020000_delivery_suppression_pending.sql"
  );
  check(
    "Stripe Customer IDs require the canonical provider prefix and no whitespace",
    /users_stripe_customer_id_format_check[\s\S]*?stripe_customer_id ~ '\^cus_\[A-Za-z0-9\]\+\$'/.test(
      migration
    )
  );
  check(
    "Stripe Subscription IDs require the canonical provider prefix and no whitespace",
    /users_stripe_subscription_id_format_check[\s\S]*?stripe_subscription_id ~ '\^sub_\[A-Za-z0-9\]\+\$'/.test(
      migration
    )
  );
  check(
    "a Subscription binding always requires its Customer owner",
    /users_stripe_subscription_requires_customer_check[\s\S]*?stripe_subscription_id is null or stripe_customer_id is not null/.test(
      migration
    )
  );
}

console.log("(6) weekly delivery re-proves the subscriber access grant");
{
  const route = read("../app/api/cron/weekly-send/route.ts");
  check(
    "weekly send imports the shared grant-plus-window predicate",
    /import \{ hasReaderAccess \} from "@\/lib\/access";/.test(route)
  );
  check(
    "the fresh user read includes enrollment, current email plus paid and invite access markers",
    /\.select\(\s*"email, delivery_enrolled, subscribed_at, access_granted_at, unsubscribed_at, cancelled_at, bounced_at, complained_at, suppression_cleanup_pending_at"\s*\)/.test(
      route
    )
  );
  check(
    "a read error or missing user fails closed before the claim",
    /if \(freshUserErr \|\| !freshUser\) \{[\s\S]*?eligibilityRecheckFailures\+\+;[\s\S]*?return "retry-required";/.test(
      route
    )
  );
  check(
    "the fresh row must retain paid or invite reader access",
    /!hasReaderAccess\([\s\S]*freshUser\.access_granted_at/.test(
      route
    )
  );
  check(
    "operator alert says uncertain access was skipped",
    route.includes("Those sends were skipped") && !route.includes("fails open")
  );
  check(
    "the provider receives the current address instead of the page snapshot",
    /currentDeliveryEmail = freshUser\.email\.trim\(\);/.test(route) &&
      /to: currentDeliveryEmail,[\s\S]*?deliveryDate: weekOf,/.test(route) &&
      /recipient: preparedEmail\.recipient,/.test(route) &&
      /send: \(storedRecipient\) =>[\s\S]*?sendPreparedSubscriberEmail\(preparedEmail\)/.test(
        route
      ) &&
      !/to: row\.email,/.test(route)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("ROUND 80 DELIVERY/ACCESS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL ROUND 80 DELIVERY/ACCESS ASSERTIONS PASS");
