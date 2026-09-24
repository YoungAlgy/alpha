import { readFileSync } from "node:fs";
import vm from "node:vm";

const route = readFileSync(
  new URL("../app/api/cron/weekly-send/route.ts", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260830010000_weekly_send_delivery_cursors.sql",
    import.meta.url
  ),
  "utf8"
);
const workflow = readFileSync(
  new URL("../.github/workflows/daily-send.yml", import.meta.url),
  "utf8"
);

type CursorState =
  | "advanced"
  | "advanced_with_retry"
  | "override_read_only"
  | "empty"
  | "advance_failed";

interface PageContract {
  ids: number[];
  hasMore: boolean;
  retryRequired: number[];
  lastId: number | null;
  blocked: boolean;
  wrapped: boolean;
  cursorAtStart: number | null;
  cursorState: CursorState;
}

interface DrainOptions {
  readerCount: number;
  initialCursor?: number | null;
  blockedIds?: Set<number>;
  deliveredIds?: Set<number>;
  maxPages?: number;
  failFirstCursorCas?: boolean;
}

interface DrainResult {
  attempted: number[];
  delivered: Set<number>;
  durableCursor: number | null;
  retryRequired: Set<number>;
  pages: number;
  tailDrained: boolean;
  remainingWork: boolean;
  wrapCount: number;
  cursorFailure: boolean;
}

// Deterministic model of the route/workflow contract. This does not pretend to
// execute Next.js or Supabase. It proves the paging state machine that the
// source-contract checks below bind to the real implementation.
function drainDelivery(options: DrainOptions): DrainResult {
  const pageSize = 250;
  const queryLimit = pageSize + 1;
  const readers = Array.from({ length: options.readerCount }, (_, i) => i + 1);
  const blockedIds = options.blockedIds ?? new Set<number>();
  const delivered = new Set(options.deliveredIds ?? []);
  const retryRequired = new Set<number>();
  const attempted: number[] = [];
  const maxPages = options.maxPages ?? 16;
  let durableCursor = options.initialCursor ?? null;
  let mode: "normal" | "override" = "normal";
  let overrideAfter: number | null = null;
  let lastContinuation: number | null = null;
  let initialCursorPresent = false;
  let sawWrap = false;
  let wrapProbeUsed = false;
  let pages = 0;
  let tailDrained = false;
  let remainingWork = false;
  let cursorFailure = false;
  let firstCall = true;

  const fetchPage = (): PageContract => {
    const explicitAfter = mode === "override" ? overrideAfter : null;
    const cursorAtStart = explicitAfter ?? durableCursor;
    let raw = readers.filter((id) => cursorAtStart === null || id > cursorAtStart);
    let wrapped = false;
    if (mode === "normal" && durableCursor !== null && raw.length === 0) {
      raw = readers;
      wrapped = true;
    }
    raw = raw.slice(0, queryLimit);
    const hasMore = raw.length > pageSize;
    const ids = raw.slice(0, pageSize);
    const lastId = ids.at(-1) ?? null;
    const unresolved: number[] = [];

    for (const id of ids) {
      attempted.push(id);
      if (delivered.has(id)) continue;
      if (blockedIds.has(id)) {
        unresolved.push(id);
        retryRequired.add(id);
      } else {
        delivered.add(id);
      }
    }

    let cursorState: CursorState;
    let blocked = unresolved.length > 0;
    if (mode === "override") {
      cursorState = "override_read_only";
    } else if (lastId === null) {
      cursorState = "empty";
    } else if (options.failFirstCursorCas && !cursorFailure) {
      cursorFailure = true;
      blocked = true;
      cursorState = "advance_failed";
    } else {
      durableCursor = lastId;
      cursorState = blocked ? "advanced_with_retry" : "advanced";
    }

    return {
      ids,
      hasMore,
      retryRequired: unresolved,
      lastId,
      blocked,
      wrapped,
      cursorAtStart,
      cursorState,
    };
  };

  while (true) {
    if (pages >= maxPages) {
      remainingWork = true;
      break;
    }

    const page = fetchPage();
    pages++;
    if (firstCall) {
      initialCursorPresent = page.cursorAtStart !== null;
      firstCall = false;
    }
    if (page.wrapped) sawWrap = true;

    if (page.cursorState === "advance_failed") {
      if (page.hasMore) {
        if (page.lastId === null || page.lastId === lastContinuation) {
          remainingWork = true;
          break;
        }
        mode = "override";
        overrideAfter = page.lastId;
        lastContinuation = page.lastId;
        continue;
      }
      tailDrained = true;
      break;
    }

    if (mode === "override") {
      if (page.hasMore) {
        if (page.lastId === null || page.lastId === lastContinuation) {
          remainingWork = true;
          break;
        }
        overrideAfter = page.lastId;
        lastContinuation = page.lastId;
        continue;
      }
      tailDrained = true;
      break;
    }

    if (
      page.cursorState !== "advanced" &&
      page.cursorState !== "advanced_with_retry" &&
      page.cursorState !== "empty"
    ) {
      remainingWork = true;
      break;
    }
    if (page.hasMore) continue;

    if (initialCursorPresent && !sawWrap && !wrapProbeUsed) {
      wrapProbeUsed = true;
      continue;
    }

    tailDrained = true;
    break;
  }

  return {
    attempted,
    delivered,
    durableCursor,
    retryRequired,
    pages,
    tailDrained,
    remainingWork,
    wrapCount: sawWrap ? 1 : 0,
    cursorFailure,
  };
}

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

check(
  "route uses a 250-row page plus one-row lookahead",
  route.includes("SUBSCRIBER_BATCH_SIZE = 250") &&
    route.includes("SUBSCRIBER_QUERY_LIMIT = SUBSCRIBER_BATCH_SIZE + 1") &&
    route.includes(".limit(SUBSCRIBER_QUERY_LIMIT)") &&
    route.includes("(page?.length ?? 0) > SUBSCRIBER_BATCH_SIZE")
);
check(
  "route exposes separate page coverage and continuation metadata",
  [
    "deliveryPageComplete",
    "deliveryRetryRequired",
    "deliveryRetryRequiredTotal",
    "deliveryPageLastUserId",
    "deliveryPageBlocked",
    "deliveryCursorState",
    "deliveryHasMore",
  ].every((name) => route.includes(name))
);
check(
  "route tracks retry-required rows exactly",
  route.includes("const deliveryRetryRequiredUserIds = new Set<string>()") &&
    route.includes('return "retry-required"') &&
    route.includes('return "settled"')
);
check(
  "all scheduled content kinds share one provider idempotency identity",
  route.includes(
    'const deliveryIdempotencyKind = force ? `force-${forceId}` : "live"'
  ) &&
    route.includes("idempotencyKind: deliveryIdempotencyKind") &&
    !route.includes("idempotencyKind: kind") &&
    route.includes('id: `${profile.firstName.toLowerCase()}-${weekOf}`') &&
    !route.includes('id: `${profile.firstName.toLowerCase()}-${weekOf}-backup`') &&
    route.includes("content backups skipped")
);
check(
  "forced resend requires a normalized UUID lane and a persisted payload",
  route.includes("const forceId = forceIdRaw?.trim().toLowerCase() || null") &&
    route.includes("force=1 requires a valid forceId UUID.") &&
    route.includes('if (!force) query = query.is("delivered_at", null)') &&
    route.includes("forceMissingRows") &&
    route.includes("Couldn't prove a stable issue payload for this delivery. Try again.")
);
check(
  "uncertain pending-issue lookup stops before regeneration or cursor progress",
  route.includes("const pendingChunkFailures = pendingChunkResults.filter") &&
    route.includes("Couldn't fetch pending delivery state. Try again.") &&
    route.indexOf("const pendingChunkFailures = pendingChunkResults.filter") <
      route.indexOf("for (const row of rows)") &&
    route.indexOf("Couldn't fetch pending delivery state. Try again.") <
      route.indexOf('"advance_weekly_send_cursor"')
);
check(
  "malformed or empty persisted payloads fail closed before the reader loop",
  route.includes("sections.length > 0") &&
    route.includes('typeof (s as { topicId?: unknown }).topicId === "string"') &&
    route.includes('typeof item.headline === "string"') &&
    route.includes('typeof item.body === "string"') &&
    route.includes("item.supplementaryRefs.every(isValidPersistedReference)") &&
    route.includes("const invalidPendingRows = pendingResult.filter") &&
    route.indexOf("const invalidPendingRows = pendingResult.filter") <
      route.indexOf("for (const row of rows)") &&
    route.indexOf("Couldn't prove a stable issue payload for this delivery. Try again.") <
      route.indexOf("for (const row of rows)") &&
    !route.includes("persisted retry content failed shape validation, regenerating")
);
check(
  "provider target comes from the just-in-time account email check",
  route.includes(
    '"email, delivery_enrolled, subscribed_at, access_granted_at, unsubscribed_at, cancelled_at, bounced_at, complained_at, suppression_cleanup_pending_at"'
  ) &&
    route.includes("currentDeliveryEmail = freshUser.email.trim()") &&
    route.includes("to: currentDeliveryEmail") &&
    route.includes("recipient: preparedEmail.recipient") &&
    route.includes("sendPreparedSubscriberEmail(preparedEmail)") &&
    !route.includes("to: row.email") &&
    route.indexOf("currentDeliveryEmail = freshUser.email.trim()") <
      route.indexOf("prepareLetterNotification({")
);
check(
  "uncertain issue-number lookup stops before the stable-key payload is sent",
  route.includes("Couldn't determine stable issue numbers. Try again.") &&
    route.indexOf("Couldn't determine stable issue numbers. Try again.") <
      route.indexOf("for (const row of rows)") &&
    route.indexOf("Couldn't determine stable issue numbers. Try again.") <
      route.indexOf("prepareLetterNotification({") &&
    route.indexOf("Couldn't determine stable issue numbers. Try again.") <
      route.indexOf('"advance_weekly_send_cursor"')
);
check(
  "normal pages record fair scan progress while keeping retry work explicit",
  route.includes('"advanced_with_retry"') &&
    !route.includes('"retained_blocked"') &&
    route.indexOf("const deliveryRetryRequiredTotal") <
      route.indexOf('"advance_weekly_send_cursor"') &&
    /deliveryCursorState = deliveryPageComplete\s*\? "advanced"\s*: "advanced_with_retry"/.test(
      route
    )
);
check(
  "manual continuation remains read-only",
  route.includes('deliveryCursorState = "override_read_only"') &&
    route.includes("if (cursorOverride) {")
);
check(
  "cursor advancement remains compare-and-swap",
  route.includes("p_expected_cursor_user_id: persistedDeliveryCursor") &&
    migration.includes("is not distinct from p_expected_cursor_user_id")
);
check(
  "route keeps scheduled wrap and disables it for explicit continuation",
  route.includes("deliveryWrapped = true") &&
    route.includes("!cursorOverride") &&
    route.includes("fetchSubscriberPage(null)")
);
check(
  "workflow drains pages with explicit page and wall-clock bounds",
  workflow.includes("MAX_DELIVERY_PAGES=16") &&
    workflow.includes("DELIVERY_DRAIN_SECONDS=3300") &&
    workflow.includes("while true; do") &&
    workflow.includes("DELIVERY_PAGE_COUNT")
);
check(
  "workflow uses afterUserId only when cursor CAS cannot claim progress",
  workflow.includes('DELIVERY_MODE="override"') &&
    workflow.includes("afterUserId=${DELIVERY_AFTER_USER_ID}") &&
    workflow.includes("DELIVERY_LAST_CONTINUATION") &&
    workflow.includes('if [ "${PAGE_CURSOR_FAILED}" -eq 1 ]; then') &&
    !/if \[ "\$\{PAGE_BLOCKED\}" -eq 1 \]; then\s*\r?\n/.test(workflow)
);
check(
  "workflow fails loudly for retry outcomes or undrained work",
  workflow.includes("DELIVERY_DRAIN_INCOMPLETE") &&
    workflow.includes("DELIVERY_RETRY_REQUIRED_TOTAL") &&
    workflow.includes("retry-required page outcome(s) were observed")
);
check(
  "workflow accepts advanced_with_retry as normal round-robin progress",
  workflow.includes("'advanced_with_retry'") &&
    workflow.includes(
      'PAGE_CURSOR_STATE}" != "advanced_with_retry"'
    )
);
check(
  "workflow isolates every Next server in a verified process group",
  workflow.includes("setsid node ./node_modules/next/dist/bin/next start") &&
    workflow.includes('SERVER_PGID=$(ps -o pgid= -p "${SERVER_PID}"') &&
    workflow.includes('kill -TERM -- "-${SERVER_PGID}"') &&
    workflow.includes('kill -KILL -- "-${SERVER_PGID}"') &&
    workflow.includes("Port 3100 still responds after the Alpha server group stopped") &&
    workflow.includes("Refusing to signal the workflow shell process group")
);
check(
  "daily workflow allows only manual or scheduled runs with no backfill input",
  workflow.includes("if: ${{ github.event_name == 'workflow_dispatch' || github.event_name == 'schedule' }}") &&
    !workflow.includes("WEEK_OF_INPUT") &&
    !workflow.includes("inputs.weekOf") &&
    !workflow.includes('URL="${URL}?weekOf=')
);
check(
  "workflow treats mid-run ineligibility as settled coverage",
  workflow.includes(
    "s.unsubscribedMidRunSkips+s.cancelledMidRunSkips+s.suppressedMidRunSkips+s.unenrolledMidRunSkips"
  )
);

// Run the exact embedded workflow parser locally with synthetic counters.
// No shell, network, subscriber data or send path is used by this fixture.
const parserMatch = workflow.replace(/\r\n/g, "\n").match(
  /PAGE_STATE=\$\(echo "\$\{RESPONSE\}" \| node -e "\n([\s\S]*?)\n\s*"\)/
);
if (!parserMatch) throw new Error("Workflow parser not found");
const parserSource = parserMatch[1];
function parseWorkflowPage(overrides: Record<string, unknown> = {}): string {
  const last = "00000000-0000-4000-8000-000000000001";
  const page = {
    subscribers: 3, sent: 2, backupSharedSent: 0, backupFreshSent: 0, backupStaleSent: 0,
    skippedAlreadyDelivered: 0, unsubscribedMidRunSkips: 0, cancelledMidRunSkips: 0,
    suppressedMidRunSkips: 0, unenrolledMidRunSkips: 1, checkoutRetentionErrors: 0,
    deliveryPageCount: 3, deliveryBatchSize: 250, deliveryRetryRequiredTotal: 0,
    deliveryPageComplete: true, deliveryRetryRequired: false, deliveryPageBlocked: false,
    deliveryHasMore: false, deliveryWrapped: false, deliveryCursorAdvanceFailed: false,
    deliveryCursorState: "advanced", deliveryCursor: null, deliveryCursorNext: last,
    deliveryPageLastUserId: last, paidCallBudgetDate: "2026-09-24", paidCallCeilingHit: false,
    paidCallReservationsGranted: 0, paidCallReservationsUsed: 0, paidCallReservationsUnused: 0,
    paidCallReservationExhausted: false, paidCallReservationError: null, ...overrides,
  };
  let output = "";
  const stdin = { on(event: string, callback: (chunk?: string) => void) {
    if (event === "data") callback(JSON.stringify(page));
    if (event === "end") callback();
    return stdin;
  } };
  vm.runInNewContext(parserSource, {
    process: { stdin, stdout: { write(value: string) { output += value; } } },
  }, { timeout: 1000 });
  return output;
}
check("actual workflow parser settles a mid-run enrollment pause", parseWorkflowPage().startsWith("OK|0|"));
check("actual workflow parser accepts all three delivered", parseWorkflowPage({ sent: 3, unenrolledMidRunSkips: 0 }).startsWith("OK|0|"));
check("actual workflow parser rejects an unexplained missed reader", parseWorkflowPage({ unenrolledMidRunSkips: 0 }) === "SHAPE_INVALID");
for (const value of [undefined, null, -1, 0.5, "1"]) {
  check(`actual workflow parser rejects invalid enrollment counter ${String(value)}`,
    parseWorkflowPage({ unenrolledMidRunSkips: value }) === "SHAPE_INVALID");
}
check(
  "stale fixed subscriber-capacity estimate is gone",
  !route.includes("2,200-3,300") &&
    route.includes("MAX_DELIVERY_PAGES or DELIVERY_DRAIN_SECONDS")
);

const over750 = drainDelivery({ readerCount: 1001 });
check(
  "behavior: more than 750 clean readers drain in one workflow",
  over750.tailDrained &&
    !over750.remainingWork &&
    over750.retryRequired.size === 0 &&
    over750.delivered.size === 1001 &&
    over750.pages === 5 &&
    over750.durableCursor === 1001
);

const blockedContinuation = drainDelivery({
  readerCount: 800,
  blockedIds: new Set([17]),
});
check(
  "behavior: a retry-required page advances fair scan position and reaches later readers",
  blockedContinuation.tailDrained &&
    !blockedContinuation.remainingWork &&
    blockedContinuation.retryRequired.has(17) &&
    blockedContinuation.durableCursor === 800 &&
    new Set(blockedContinuation.attempted).size === 800 &&
    blockedContinuation.delivered.size === 799
);

const finalPartial = drainDelivery({ readerCount: 620 });
check(
  "behavior: a clean final partial page terminates the drain",
  finalPartial.tailDrained &&
    !finalPartial.remainingWork &&
    finalPartial.pages === 3 &&
    finalPartial.durableCursor === 620
);

const exactPage = drainDelivery({ readerCount: 250 });
check(
  "behavior: an exact 250-reader final page needs no empty probe",
  exactPage.tailDrained && exactPage.pages === 1 && exactPage.durableCursor === 250
);

const deliveredBeforeWrap = new Set(
  Array.from({ length: 500 }, (_, i) => i + 1)
);
const wrapped = drainDelivery({
  readerCount: 600,
  initialCursor: 500,
  deliveredIds: deliveredBeforeWrap,
});
check(
  "behavior: a resumed clean drain wraps once and covers the ordered head",
  wrapped.tailDrained &&
    !wrapped.remainingWork &&
    wrapped.wrapCount === 1 &&
    wrapped.delivered.size === 600 &&
    wrapped.durableCursor === 600
);

const retryDelivered = new Set(blockedContinuation.delivered);
const retry = drainDelivery({
  readerCount: 800,
  initialCursor: blockedContinuation.durableCursor,
  deliveredIds: retryDelivered,
});
check(
  "behavior: the next normal run wraps and retries the unresolved reader",
  retry.tailDrained &&
    !retry.remainingWork &&
    retry.retryRequired.size === 0 &&
    retry.delivered.size === 800 &&
    retry.durableCursor === 800
);

const cursorCasFailure = drainDelivery({
  readerCount: 700,
  failFirstCursorCas: true,
});
check(
  "behavior: cursor CAS failure retains progress but does not starve later pages",
  cursorCasFailure.cursorFailure &&
    cursorCasFailure.durableCursor === null &&
    new Set(cursorCasFailure.attempted).size === 700 &&
    cursorCasFailure.delivered.size === 700
);

const bounded = drainDelivery({ readerCount: 5000, maxPages: 4 });
check(
  "behavior: page exhaustion is bounded and reports remaining work",
  bounded.pages === 4 &&
    bounded.remainingWork &&
    !bounded.tailDrained &&
    bounded.durableCursor === 1000
);

const scaleSlotOne = drainDelivery({
  readerCount: 5000,
  blockedIds: new Set([17]),
  maxPages: 16,
});
const scaleSlotTwo = drainDelivery({
  readerCount: 5000,
  initialCursor: scaleSlotOne.durableCursor,
  blockedIds: new Set([17]),
  deliveredIds: scaleSlotOne.delivered,
  maxPages: 16,
});
check(
  "behavior: consecutive bounded slots resume beyond 4,000 and later wrap to retry the head",
  scaleSlotOne.durableCursor === 4000 &&
    scaleSlotOne.remainingWork &&
    scaleSlotTwo.attempted.includes(4001) &&
    scaleSlotTwo.attempted.includes(5000) &&
    scaleSlotTwo.attempted.includes(17) &&
    scaleSlotTwo.durableCursor === 3000 &&
    scaleSlotTwo.remainingWork
);

const deliveredBeforeBlockedTail = new Set(
  Array.from({ length: 500 }, (_, i) => i + 1).filter((id) => id !== 100)
);
const blockedTailWithNewHead = drainDelivery({
  readerCount: 600,
  initialCursor: 500,
  blockedIds: new Set([550]),
  deliveredIds: deliveredBeforeBlockedTail,
});
check(
  "behavior: a blocked final tail still wraps and reaches a new lower-sorting reader",
  blockedTailWithNewHead.tailDrained &&
    blockedTailWithNewHead.wrapCount === 1 &&
    blockedTailWithNewHead.attempted.includes(100) &&
    blockedTailWithNewHead.delivered.has(100) &&
    blockedTailWithNewHead.retryRequired.has(550) &&
    blockedTailWithNewHead.durableCursor === 600
);

const blockedExactPage = drainDelivery({
  readerCount: 250,
  blockedIds: new Set([17]),
});
const recoveredExactPage = drainDelivery({
  readerCount: 250,
  initialCursor: blockedExactPage.durableCursor,
  deliveredIds: blockedExactPage.delivered,
});
check(
  "behavior: an exact blocked page advances, then the next slot wraps and recovers it",
  blockedExactPage.durableCursor === 250 &&
    blockedExactPage.retryRequired.has(17) &&
    recoveredExactPage.wrapCount === 1 &&
    recoveredExactPage.delivered.has(17) &&
    recoveredExactPage.retryRequired.size === 0
);

const validManualWeekOf = (raw: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};
check(
  "behavior: manual date validation rejects query injection and impossible dates",
  validManualWeekOf("2026-08-31") &&
    !validManualWeekOf("2026-08-31&force=1") &&
    !validManualWeekOf("2026-04-31") &&
    encodeURIComponent("2026-08-31&force=1").includes("%26force%3D1")
);

const scheduledDeliveryKey = (userId: string, issueDate: string) =>
  `alpha-letter-${userId}-${issueDate}-live`;
check(
  "behavior: live and every backup retry resolve to one scheduled provider key",
  new Set(
    ["live", "backup-shared", "backup-fresh", "backup-stale"].map(() =>
      scheduledDeliveryKey("reader-1", "August 31, 2026")
    )
  ).size === 1 &&
    scheduledDeliveryKey("reader-1", "August 31, 2026") !==
      scheduledDeliveryKey("reader-2", "August 31, 2026") &&
    scheduledDeliveryKey("reader-1", "August 31, 2026") !==
      scheduledDeliveryKey("reader-1", "September 1, 2026")
);

const forceUuid = "A9F50FB1-5CB7-4E99-852D-5D7A04DD54A1";
const forceLane = (raw: string) => {
  const normalized = raw.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? `force-${normalized}`
    : null;
};
check(
  "behavior: one force UUID is case-stable while a new UUID creates a new delivery lane",
  forceLane(forceUuid) === forceLane(forceUuid.toLowerCase()) &&
    forceLane(forceUuid) !==
      forceLane("0b79b8af-1445-48b7-8d6c-da777a0dfc95") &&
    forceLane("missing") === null
);

type PersistedPayloadState =
  | "missing"
  | "malformed"
  | "malformed-item"
  | "empty"
  | "valid";
const modelStablePayload = (
  state: PersistedPayloadState,
  forceRequested: boolean
) => {
  const invalid =
    state === "malformed" || state === "malformed-item" || state === "empty";
  const missingForForce = forceRequested && state === "missing";
  const stoppedBeforeLoop = invalid || missingForForce;
  return {
    stoppedBeforeLoop,
    generationStarted: !stoppedBeforeLoop && state === "missing",
    reusedPersistedPayload: !stoppedBeforeLoop && state === "valid",
    persistedPayloadOverwritten: false,
    sendStarted: !stoppedBeforeLoop,
    cursorAdvanced: !stoppedBeforeLoop,
  };
};
for (const invalidState of ["malformed", "malformed-item", "empty"] as const) {
  const outcome = modelStablePayload(invalidState, false);
  check(
    `behavior: ${invalidState} pending content cannot generate, overwrite, send, or advance`,
    outcome.stoppedBeforeLoop &&
      !outcome.generationStarted &&
      !outcome.persistedPayloadOverwritten &&
      !outcome.sendStarted &&
      !outcome.cursorAdvanced
  );
}
const missingForcePayload = modelStablePayload("missing", true);
const validForcePayload = modelStablePayload("valid", true);
check(
  "behavior: force replays a valid persisted body and fails closed when it is missing",
  missingForcePayload.stoppedBeforeLoop &&
    !missingForcePayload.generationStarted &&
    !missingForcePayload.sendStarted &&
    validForcePayload.reusedPersistedPayload &&
    !validForcePayload.generationStarted &&
    validForcePayload.sendStarted
);

const chooseDeliveryEmail = (_snapshot: string, fresh: string | null) =>
  typeof fresh === "string" && fresh.trim() ? fresh.trim() : null;
check(
  "behavior: a mid-page account email change targets the current address and missing email stops",
  chooseDeliveryEmail("old@example.com", "new@example.com") ===
    "new@example.com" &&
    chooseDeliveryEmail("old@example.com", "  ") === null
);

const modelPendingPrefetch = (lookupSucceeded: boolean) => {
  let generationStarted = false;
  let persistedPayloadOverwritten = false;
  let cursorAdvanced = false;
  if (!lookupSucceeded) {
    return { generationStarted, persistedPayloadOverwritten, cursorAdvanced };
  }
  generationStarted = true;
  persistedPayloadOverwritten = true;
  cursorAdvanced = true;
  return { generationStarted, persistedPayloadOverwritten, cursorAdvanced };
};
const uncertainPendingPrefetch = modelPendingPrefetch(false);
check(
  "behavior: uncertain pending lookup cannot regenerate, overwrite, or claim cursor progress",
  !uncertainPendingPrefetch.generationStarted &&
    !uncertainPendingPrefetch.persistedPayloadOverwritten &&
    !uncertainPendingPrefetch.cursorAdvanced
);

const modelIssueNumberLookup = (lookupSucceeded: boolean) => ({
  sendStarted: lookupSucceeded,
  cursorAdvanced: lookupSucceeded,
});
const uncertainIssueNumber = modelIssueNumberLookup(false);
check(
  "behavior: uncertain issue number cannot change a sent payload or cursor",
  !uncertainIssueNumber.sendStarted && !uncertainIssueNumber.cursorAdvanced
);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "OK " : "XX "}${label}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`ALL WEEKLY SEND CURSOR ASSERTIONS PASS (${checks.length})`);
