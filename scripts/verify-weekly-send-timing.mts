import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { validateDeliveryIssueWindow } from "../lib/delivery-issue-window.mjs";

// Run the real GET and workflow parser with memory-only boundaries. No product
// module, environment file, Next server, network transport or provider is loaded.
const routeSource = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
const compiled = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const parserMatch = workflowSource.replace(/\r\n/g, "\n").match(
  /PAGE_STATE=\$\(echo "\$\{RESPONSE\}" \| node -e "\n([\s\S]*?)\n\s*"\)/,
);
assert.ok(parserMatch, "actual workflow page parser exists");
const parserSource = parserMatch[1];
const readerId = "a1111111-1111-4111-8111-111111111111";
const afterId = "01111111-1111-4111-8111-111111111111";
const period = "2026-10-03";
const epoch = Date.parse(`${period}T14:17:00Z`);
let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  assertions++;
}

function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function parsePage(page: unknown): string {
  let output = "";
  const stdin = {
    on(event: string, callback: (chunk?: string) => void) {
      if (event === "data") callback(JSON.stringify(page));
      if (event === "end") callback();
      return stdin;
    },
  };
  vm.runInNewContext(parserSource, {
    process: { env: { ALPHA_DELIVERY_ISSUE_DATE: period }, stdin, stdout: { write(value: string) { output += value; } } },
  }, { timeout: 1000 });
  return output;
}

type Options = {
  at?: string;
  window?: Record<string, string>;
  budget?: string;
  setupMs?: number;
  outcome?: "clean" | "accept-during-cursor" | "unresolved" | "accept-before-timeout-catch" | "stored-acceptance";
  cursorFails?: boolean;
  override?: boolean;
  persisted?: boolean;
  lostClaim?: "empty" | "missing";
  reclaimFails?: boolean;
};
type Response = { status: number; body: Record<string, unknown> };

async function invoke(options: Options = {}) {
  let now = options.at ? Date.parse(options.at) : epoch;
  let clientCalls = 0;
  let generationCalls = 0;
  let providerCalls = 0;
  let cursorCalls = 0;
  let deadlineCalls = 0;
  let tail: Promise<unknown> | undefined;
  const deliveryStarted = gate<void>();
  const deliveryResult = gate<{ providerSent: boolean; provider: string; suppressionReviewRequired: boolean }>();
  const cursorStarted = gate<void>();
  const cursorResult = gate<boolean>();
  const afterPromises: Promise<unknown>[] = [];
  const timedOut = options.outcome === "accept-during-cursor" || options.outcome === "unresolved";
  const sections = [{
    topicId: "science", topicLabel: "Science", intro: "Local fixture section",
    items: [{ kind: "read", headline: "Fixture headline", body: "Fixture body" }],
  }];
  const reader = {
    id: readerId, email: "fixture@example.invalid", first_name: "Fixture", city: "",
    job_blurb: null, project_blurb: null, fun_blurb: null, birthday: null,
    gender: null, theme: "forest", topics: ["science"], topic_quota: 1,
  };
  const freshUser = {
    email: reader.email, delivery_enrolled: true, subscribed_at: `${period}T00:00:00Z`,
    access_granted_at: `${period}T00:00:00Z`, unsubscribed_at: null,
    cancelled_at: null, bounced_at: null, complained_at: null,
    suppression_cleanup_pending_at: null, brevo_unsubscribed_at: null,
  };
  const issue = {
    id: `fixture-${period}`, volume: 1, number: 1, weekOf: "October 3, 2026",
    recipientFirstName: "Fixture", recipientCity: "", editorIntro: "Local fixture intro", sections,
  };

  class Clock extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return now; }
  }

  // Supabase's builders are thenable. Every supported query returns local data
  // only, and an unexpected table, method or RPC fails the fixture explicitly.
  function query(table: string) {
    assert.ok(["users", "issues", "weekly_send_delivery_cursors"].includes(table), "allowlisted local table");
    let selected = "";
    let patch: Record<string, unknown> | undefined;
    let upserted = false;
    const builder: Record<string, unknown> = {};
    for (const method of ["eq", "not", "or", "is", "order", "gt", "lt", "gte", "in", "limit", "returns"]) {
      builder[method] = () => builder;
    }
    builder.select = (columns: string) => { selected = columns; return builder; };
    builder.update = (value: Record<string, unknown>) => { patch = value; return builder; };
    builder.upsert = () => { upserted = true; return builder; };
    const result = (single = false) => {
      if (table === "weekly_send_delivery_cursors") return { data: null, error: null };
      if (table === "users") return { data: single ? freshUser : [reader], error: null };
      if (upserted) return { data: null, error: null };
      if (patch) {
        if (patch.delivered_at === null && options.reclaimFails) return {
          data: null, error: { message: "Controlled reclaim failure" },
        };
        return {
          data: patch.delivered_at
            ? options.lostClaim === "missing" ? null : options.lostClaim === "empty" ? [] : [{ user_id: readerId }]
            : [],
          error: null,
        };
      }
      if (selected === "user_id, volume, number, editor_intro, sections") return {
        data: options.persisted === false ? [] : [{
          user_id: readerId, volume: 1, number: 1, editor_intro: issue.editorIntro, sections,
        }], error: null,
      };
      assert.equal(selected, "user_id", "allowlisted issue read");
      return { data: [], error: null };
    };
    builder.maybeSingle = () => Promise.resolve(result(true));
    builder.then = (accept: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(accept, reject);
    return builder;
  }
  const sb = {
    from: query,
    async rpc(name: string) {
      if (name === "prior_provider_issue_counts") return { data: [], error: null };
      assert.equal(name, "advance_weekly_send_cursor", "allowlisted local RPC");
      cursorCalls++;
      if (timedOut) {
        cursorStarted.resolve();
        return { data: await cursorResult.promise, error: null };
      }
      return { data: !options.cursorFails, error: null };
    },
  };
  const zero = () => 0;
  const mocks: Record<string, unknown> = {
    "crypto": { createHash, timingSafeEqual },
    "next/server": {
      NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }) => ({
        status: init?.status ?? 200, body: JSON.parse(JSON.stringify(body)),
      }) },
      after: (promise: Promise<unknown>) => { afterPromises.push(promise); },
    },
    "@/lib/source-attribution": { validatedSourceAttribution: () => true },
    "@/lib/subscriber-delivery-policy": { SUBSCRIBER_LETTERS_ENABLED: true },
    "@/lib/supabase/server": { supabaseServiceClient: async () => { clientCalls++; return sb; } },
    "@/lib/engine/assemble": {
      formatWeekOf: () => issue.weekOf,
      generateIssue: async () => { generationCalls++; return issue; },
    },
    "@/lib/engine/select-sections": { poolCap: () => 25 },
    "@/lib/engine/blurb-cache": { getCachedBlurbs: async () => { throw new Error("Unexpected rescue lookup"); } },
    "@/lib/email": { prepareLetterNotification: () => ({}), sendOpsAlert: async () => undefined },
    "@/lib/brevo-delivery-policy": { BREVO_DELIVERY_SCHEMA_ENABLED: true, BREVO_CANARY_DELIVERY_ENABLED: false },
    "@/lib/brevo-canary-policy": { parseBrevoCanaryRequest: () => ({ kind: "none" }) },
    "@/lib/subscriber-email-delivery": {
      subscriberEmailConfigured: () => true,
      sendPreparedSubscriberLetter: async () => {
        providerCalls++;
        deliveryStarted.resolve();
        if (timedOut) return deliveryResult.promise;
        return { providerSent: options.outcome !== "stored-acceptance", provider: "resend", suppressionReviewRequired: false };
      },
    },
    "@/lib/letter-token": { deliveryLetterUrl: () => "https://example.invalid/fixture" },
    "@/lib/cadence": { currentPeriodIso: () => new Date(now).toISOString().slice(0,10), sinceLastSendWindow: () => "pd", isSendDay: () => true },
    "@/lib/delivery-issue-window.mjs": { validateDeliveryIssueWindow },
    "@/lib/issue-visibility": { issueIsReaderVisible: () => true },
    "@/lib/latest-visible-issue": { latestVisibleIssue: async () => { throw new Error("Unexpected historical lookup"); } },
    "@/lib/brave": { braveRateLimitedCount: zero },
    "@/lib/you-search": { youRateLimitedCount: zero },
    "@/lib/engine/gemini-client": { geminiRateLimitedCount: zero },
    "@/lib/engine/groq-client": { groqRateLimitedCount: zero },
    "@/lib/engine/deepseek-client": { deepseekRateLimitedCount: zero, deepseekCallCount: zero },
    "@/lib/engine/topic-blurb": { topicBlurbPaidCallCount: zero },
    "@/lib/engine/editor-note": { editorNoteAnthropicCallCount: zero },
    "@/lib/engine/paid-call-budget": { paidCallsSinceBaseline: zero },
    "@/lib/paid-call-reservation": { createDailyPaidCallGuard: () => ({
      allow: async () => { throw new Error("Unexpected paid admission"); },
      snapshot: () => ({ used: 0, granted: 0, remaining: 0, exhausted: false, error: null }),
    }) },
    "@/lib/topics": { topicLabel: () => "Science", mapTopicsForUser: (topics: unknown) => topics, GENERIC_FALLBACK_TOPICS: [] },
    "@/lib/with-deadline": { withDeadline: (promise: Promise<unknown>, ms: number, label: string) => {
      if (!label.startsWith("persist+send")) return promise;
      deadlineCalls++;
      equal(ms, 45_000, "delivery wait remains bounded");
      tail = promise;
      if (options.outcome === "accept-before-timeout-catch") {
        now += ms;
        // Model a timer that already rejected the caller while its catch is
        // queued behind settlement. A stale catch must not recreate a retry.
        return promise.then(() => { throw new Error("Controlled expired caller resumes after acceptance"); });
      }
      if (timedOut) {
        now += ms;
        return Promise.reject(new Error("Controlled delivery deadline"));
      }
      return promise;
    } },
    "@/lib/access": { hasReaderAccess: () => true },
    "@/lib/types": { clampQuota: () => 1 },
    "@/lib/demographics": { coerceGender: () => undefined, isValidCalendarDateString: () => true },
    "@/lib/themes": { coerceThemeId: () => "forest" },
    "@/lib/delivery-proof": { RECLAIM_GRANDFATHER_CUTOFF: "2026-08-05T19:10:00Z" },
    "@/lib/checkout-profile-retention": { scrubExpiredCheckoutProfiles: async () => { now += options.setupMs ?? 0; return []; } },
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled, {
    exports, URL, Date: Clock,
    process: { env: { CRON_SECRET: "local-fixture-secret", ALPHA_NO_MODEL_MODE: "1", ALPHA_ALLOW_PAID_AI: "0", ...options.window } },
    console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      if (!Object.hasOwn(mocks, name)) throw new Error("Unexpected runtime import in timing fixture");
      return mocks[name];
    },
    fetch() { throw new Error("Network disabled in timing fixture"); },
  }, { timeout: 1000 });
  const url = `https://example.invalid/api/cron/weekly-send${options.override ? `?afterUserId=${afterId}` : ""}`;
  const request = {
    url,
    headers: { get(name: string) {
      if (name.toLowerCase() === "authorization") return "Bearer local-fixture-secret";
      if (name.toLowerCase() === "x-alpha-page-budget-seconds") return options.budget ?? null;
      throw new Error("Unexpected request header in timing fixture");
    } },
  };
  const responsePromise = (exports.GET as (request: unknown) => Promise<Response>)(request);
  // If the handler rejects before a gate is reached, the bounded case guard
  // reports failure without leaking an unhandled rejection or a VM stack.
  void responsePromise.catch(() => undefined);
  if (timedOut && !options.override) {
    // Both gates come from the real GET's work. The provider accepts only
    // after the cursor RPC began, then the RPC finishes after the delivery tail.
    await cursorStarted.promise;
    await deliveryStarted.promise;
    if (options.outcome === "accept-during-cursor") {
      deliveryResult.resolve({ providerSent: true, provider: "resend", suppressionReviewRequired: false });
      assert.ok(tail, "real delivery tail exists");
      await tail;
    }
    cursorResult.resolve(!options.cursorFails);
  }
  const response = await responsePromise;
  const frozenResponse = JSON.stringify(response.body);
  if (options.outcome === "unresolved") {
    await deliveryStarted.promise;
    deliveryResult.resolve({ providerSent: true, provider: "resend", suppressionReviewRequired: false });
    await tail;
    await Promise.all(afterPromises);
    equal(JSON.stringify(response.body), frozenResponse, "a later acceptance cannot rewrite the returned snapshot");
  } else {
    await Promise.all(afterPromises);
  }
  return { response, clientCalls, generationCalls, providerCalls, cursorCalls, deadlineCalls };
}

const checks: Array<() => Promise<void>> = [];
const runPin = {
  GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule", ALPHA_DELIVERY_CRON: "47 18 * * *",
  ALPHA_DELIVERY_ISSUE_DATE: period, ALPHA_DELIVERY_RUN_STARTED_AT: `${period}T23:59:00.000Z`,
};
checks.push(async () => {
  const result = await invoke({ at: "2026-10-04T00:05:00Z", window: runPin });
  equal(result.response.status, 200, "an active pinned run can finish across midnight");
  equal(result.response.body.weekOf, period, "midnight cannot open a new issue");
  equal(result.response.body.paidCallBudgetDate, "2026-10-04", "paid budget remains on actual request date");
  equal(parsePage(result.response.body).startsWith("OK|"), true, "workflow accepts pinned issue date");
  equal(parsePage({ ...result.response.body, weekOf: "2026-10-04" }), "SHAPE_INVALID", "workflow rejects a different issue date");
});
for (const window of [
  { ...runPin, ALPHA_DELIVERY_ISSUE_DATE: "2026-10-04" },
  { ...runPin, ALPHA_DELIVERY_RUN_STARTED_AT: "2026-10-03T13:00:00.000Z" },
  { ...runPin, ALPHA_DELIVERY_RUN_STARTED_AT: "2026-10-03T22:35:00.000Z" },
  { ...runPin, ALPHA_DELIVERY_RUN_STARTED_AT: "2026-10-04T00:06:00.000Z" },
  { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule" },
]) checks.push(async () => {
  const result = await invoke({ at: "2026-10-04T00:05:00Z", window });
  equal(result.response.status, 503, "invalid, early, missing, future or expired pin fails closed");
  equal(result.clientCalls, 0, "rejected pin stops before database or retention");
  equal(result.generationCalls, 0, "rejected pin cannot generate");
  equal(result.providerCalls, 0, "rejected pin cannot send");
});
checks.push(async () => {
  const curl = workflowSource.split(/\r?\n/).find((line) => line.includes("RAW=$(curl") && line.includes("${PAGE_CURL_TIMEOUT}"));
  equal(typeof curl, "string", "actual bounded page curl exists");
  equal(curl?.includes('--max-time "${PAGE_CURL_TIMEOUT}"'), true, "curl timeout uses the selected page budget");
  equal(curl?.includes('-H "X-Alpha-Page-Budget-Seconds: ${PAGE_CURL_TIMEOUT}"'), true,
    "the same actual curl sends its timeout budget to the authenticated route");
});
checks.push(async () => {
  const result = await invoke({ outcome: "accept-during-cursor" });
  equal(result.response.status, 200, "late acceptance response succeeds");
  equal(result.response.body.sent, 1, "acceptance during cursor RPC is counted");
  equal(result.response.body.deliveryRetryRequiredTotal, 0, "acceptance during cursor RPC removes the retry");
  equal(result.response.body.deliveryCursorState, "advanced", "late acceptance classifies the final cursor state");
  equal(parsePage(result.response.body).startsWith("OK|0|"), true, "actual workflow parser accepts late acceptance");
});
checks.push(async () => {
  const result = await invoke({ outcome: "accept-before-timeout-catch" });
  equal(result.response.body.sent, 1, "acceptance preceding a stale timeout catch is counted once");
  equal(result.response.body.deliveryRetryRequiredTotal, 0, "stale timeout catch cannot recreate a settled retry");
  equal(result.response.body.deliveryPageComplete, true, "settled coverage survives a stale timeout catch");
  equal(result.response.body.deliveryCursorState, "advanced", "stale catch does not misclassify cursor coverage");
  equal(parsePage(result.response.body).startsWith("OK|0|"), true, "actual parser accepts settlement before timeout catch");
});
checks.push(async () => {
  // Contract coverage only. The guarded coordinator may return existing proof
  // without sending. This does not claim a new scheduled production scenario.
  const result = await invoke({ outcome: "stored-acceptance" });
  equal(result.response.body.sent, 0, "stored acceptance is not counted as a new send");
  equal(result.response.body.skippedAlreadyDelivered, 1, "stored acceptance receives exact covered-skip credit");
  equal(result.response.body.deliveryRetryRequiredTotal, 0, "stored acceptance leaves no retry");
  equal(result.response.body.deliveryPageComplete, true, "stored acceptance settles page coverage");
  equal(parsePage(result.response.body).startsWith("OK|0|"), true, "actual parser accepts existing acceptance proof");
});
checks.push(async () => {
  const result = await invoke({ outcome: "unresolved" });
  equal(result.response.body.sent, 0, "unresolved tail is not counted as accepted");
  equal(result.response.body.deliveryRetryRequiredTotal, 1, "unresolved tail stays retry-required");
  equal(result.response.body.deliveryCursorState, "advanced_with_retry", "unresolved tail retains fair progress");
  equal(parsePage(result.response.body).startsWith("OK|1|"), true, "actual parser accepts truthful retry coverage");
});
checks.push(async () => {
  const result = await invoke({ outcome: "accept-during-cursor", cursorFails: true });
  equal(result.response.body.sent, 1, "cursor failure does not erase late provider acceptance");
  equal(result.response.body.deliveryRetryRequiredTotal, 0, "cursor failure does not invent delivery retries");
  equal(result.response.body.deliveryCursorState, "advance_failed", "cursor failure remains explicit");
  equal(result.response.body.deliveryPageBlocked, true, "cursor failure keeps the page blocked");
  equal(parsePage(result.response.body).startsWith("OK|0|"), true, "actual parser accepts covered but cursor-blocked page");
});
checks.push(async () => {
  for (const outcome of ["clean", "unresolved"] as const) {
    const result = await invoke({ override: true, outcome });
    equal(result.cursorCalls, 0, "explicit continuation performs no cursor write");
    equal(result.response.body.deliveryCursorState, "override_read_only", "explicit continuation stays read-only");
    equal(result.response.body.deliveryCursorNext, afterId, "explicit continuation retains the supplied cursor");
    equal(parsePage(result.response.body).startsWith(outcome === "clean" ? "OK|0|" : "OK|1|"), true,
      "actual parser accepts read-only continuation outcomes");
  }
});
checks.push(async () => {
  for (const options of [
    { budget: undefined, setupMs: 96_000 },
    { budget: "1500", setupMs: 96_000 },
    { budget: "500", setupMs: 94_000 },
  ]) {
    const result = await invoke({ ...options, persisted: false });
    equal(result.providerCalls, 1, "full or default page budget permits a clean delivery");
    equal(result.generationCalls, 1, "full or default page budget permits generation");
    equal(result.response.body.sent, 1, "clean delivery is counted once");
    equal(parsePage(result.response.body).startsWith("OK|0|"), true, "actual parser accepts a clean page");
  }
});
checks.push(async () => {
  for (const options of [
    { budget: "500", setupMs: 96_000 },
    { budget: "500", setupMs: 95_000 },
    { budget: "300", setupMs: 0 },
  ]) {
    const result = await invoke({ ...options, persisted: false });
    equal(result.providerCalls, 0, "insufficient or exactly exhausted admission budget defers delivery");
    equal(result.generationCalls, 0, "setup time is included before starting generation");
    equal(result.response.body.deferredTotal, 1, "budget-deferred reader is visible");
    equal(result.response.body.deliveryRetryRequiredTotal, 1, "budget-deferred reader remains retry-required");
    equal(result.cursorCalls, 1, "budget deferral still records inspected scan progress");
    equal(parsePage(result.response.body).startsWith("OK|1|"), true, "actual parser accepts budget deferral");
  }
});
checks.push(async () => {
  for (const budget of ["", " 500", "500 ", "+500", "500.0", "5e2", "500,500", "-1", "299", "1501", "999999999999999999999", "\u0665\u0660\u0660"]) {
    const result = await invoke({ budget });
    equal(result.response.status, 400, "invalid page budget fails before database work");
    equal(result.clientCalls, 0, "invalid page budget never creates the service client");
    equal(result.providerCalls, 0, "invalid page budget never dispatches");
  }
});
checks.push(async () => {
  // A claim held by another process is not acceptance proof. This includes a
  // crashed pre-send claim whose cleanup failed, and a still-running winner.
  // Neither empty nor missing claim data may credit delivery or bypass the lock.
  for (const options of [
    { lostClaim: "empty" as const, reclaimFails: true },
    { lostClaim: "missing" as const, reclaimFails: true },
    { lostClaim: "empty" as const, reclaimFails: false },
  ]) {
    const result = await invoke({ ...options, persisted: false });
    equal(result.response.status, 200, "unproved claim returns truthful page metadata");
    equal(result.providerCalls, 0, "lost claim never calls a provider");
    equal(result.response.body.sent, 0, "lost claim has no new acceptance");
    equal(result.response.body.skippedAlreadyDelivered, 0, "unproved claim receives no delivery credit");
    equal(result.response.body.deliveryRetryRequiredTotal, 1, "unproved claim remains unresolved");
    equal(result.response.body.deliveryPageComplete, false, "unproved claim keeps coverage incomplete");
    equal(result.response.body.deliveryCursorState, "advanced_with_retry", "scan progress retains unresolved coverage");
    equal(parsePage(result.response.body).startsWith("OK|1|"), true, "actual workflow parser retains the unresolved outcome");
  }
});

let failures = 0;
for (let index = 0; index < checks.length; index++) {
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    // A broken route cannot leave a gate pending forever. This timer is only
    // a fixture failure guard. All successful ordering uses controlled promises.
    await Promise.race([
      checks[index](),
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("Offline fixture did not settle")), 2000);
      }),
    ]);
    console.log(`OK weekly-send timing case ${index + 1}`);
  } catch {
    // Do not print VM exceptions, response bodies, environment values or data.
    failures++;
    console.error(`XX weekly-send timing case ${index + 1}`);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
  }
}
console.log(`Weekly-send timing: ${assertions} assertions passed, ${failures} cases failed.`);
if (failures) process.exitCode = 1;
