// Focused Round 80 editor-cost checks. Fully local: pure boundary tests plus
// source assertions. This script does not load environment files, make network
// requests, construct provider clients, or write repository/application data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canStartPaidCall,
  paidCallsSinceBaseline,
  type PaidCallSnapshot,
} from "../lib/engine/paid-call-budget.ts";
import { createDailyPaidCallGuard } from "../lib/paid-call-reservation.ts";

const baseline: PaidCallSnapshot = {
  topicBlurbAnthropic: 10,
  editorNoteAnthropic: 20,
  deepseek: 30,
};

const at399: PaidCallSnapshot = {
  topicBlurbAnthropic: 109,
  editorNoteAnthropic: 120,
  deepseek: 230,
};
const at400: PaidCallSnapshot = { ...at399, editorNoteAnthropic: 121 };
const over400: PaidCallSnapshot = { ...at400, deepseek: 231 };

assert.equal(paidCallsSinceBaseline(baseline, at399), 399);
assert.equal(canStartPaidCall(400, baseline, at399), true, "call 400 may start");
assert.equal(paidCallsSinceBaseline(baseline, at400), 400);
assert.equal(canStartPaidCall(400, baseline, at400), false, "call 401 must fail closed");
assert.equal(canStartPaidCall(400, baseline, over400), false, "an overshoot must stay closed");

const grants = [25, 3];
let reservationCalls = 0;
const durableGuard = createDailyPaidCallGuard(
  {
    rpc: async () => {
      const data = grants[reservationCalls] ?? 0;
      reservationCalls += 1;
      return { data, error: null } as never;
    },
  } as never,
  "2026-08-28",
  25
);
assert.equal(durableGuard.snapshot().granted, 0, "the durable budget must be lazy");
const concurrentDecisions = await Promise.all(
  Array.from({ length: 29 }, () => durableGuard.allow())
);
assert.equal(concurrentDecisions.filter(Boolean).length, 28);
assert.equal(concurrentDecisions.at(-1), false, "the first unreserved call must fail closed");
assert.equal(reservationCalls, 2, "concurrent calls must share each chunk refill");
assert.deepEqual(durableGuard.snapshot(), {
  granted: 28,
  used: 28,
  remaining: 0,
  exhausted: true,
  error: null,
});

const failedGuard = createDailyPaidCallGuard(
  {
    rpc: async () => ({
      data: null,
      error: { message: "migration unavailable" },
    } as never),
  } as never,
  "2026-08-28"
);
assert.equal(await failedGuard.allow(), false);
assert.match(failedGuard.snapshot().error ?? "", /migration unavailable/);

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const editor = source("../lib/engine/editor-note.ts");
const topic = source("../lib/engine/topic-blurb.ts");
const assemble = source("../lib/engine/assemble.ts");
const cron = source("../app/api/cron/weekly-send/route.ts");
const generateRoute = source("../app/api/generate/route.ts");

const anthropicGuard = editor.indexOf('await requirePaidCallBudget("Anthropic");');
const anthropicCount = editor.indexOf("anthropicCallCount += 1;", anthropicGuard);
const anthropicStart = editor.indexOf("anthropicClient().messages.create", anthropicCount);
assert.ok(
  anthropicGuard >= 0 && anthropicGuard < anthropicCount && anthropicCount < anthropicStart,
  "every editor Anthropic attempt must reserve and count budget before the provider starts"
);
assert.equal(
  occurrences(editor, "await callClaude()"),
  2,
  "both the first Opus attempt and optional lexical retry must use the guarded call"
);
assert.match(editor, /e instanceof PaidEditorCallBudgetExceededError[\s\S]*falling back to free tiers/);

const deepseekGuard = editor.indexOf('await requirePaidCallBudget("DeepSeek");');
const deepseekStart = editor.indexOf("deepseekGenerateText(SYSTEM_PROMPT", deepseekGuard);
assert.ok(
  deepseekGuard >= 0 && deepseekGuard < deepseekStart,
  "the paid editor DeepSeek fallback must reserve budget before the provider starts"
);

const topicDeepseekGuard = topic.indexOf('await requirePaidCallBudget("DeepSeek");');
const topicDeepseekStart = topic.indexOf("deepseekGenerateText(SYSTEM_PROMPT", topicDeepseekGuard);
assert.ok(
  topicDeepseekGuard >= 0 && topicDeepseekGuard < topicDeepseekStart,
  "every paid topic DeepSeek attempt must reserve budget before the provider starts"
);
const topicAnthropicGuard = topic.indexOf("await requirePaidCallBudget(`Anthropic ${model}`);");
const topicAnthropicCount = topic.indexOf("paidCallCount += 1;", topicAnthropicGuard);
const topicAnthropicStart = topic.indexOf("anthropicClient().messages.create", topicAnthropicCount);
assert.ok(
  topicAnthropicGuard >= 0 &&
    topicAnthropicGuard < topicAnthropicCount &&
    topicAnthropicCount < topicAnthropicStart,
  "every paid topic Anthropic attempt must reserve and count budget before the provider starts"
);
assert.ok(
  occurrences(topic, "if (e2 instanceof PaidTopicCallBudgetExceededError) throw e2;") >= 2,
  "paid DeepSeek and Haiku retries must stop before call 401 rather than swallowing the brake"
);

const editorInvocation = assemble.indexOf("generateEditorNote(user, blurbs, fallbackTopicIds, {");
const editorFallbackCatch = assemble.indexOf("[assemble] editor note failed, using fallback intro", editorInvocation);
const deterministicIntro = assemble.indexOf("editorIntro = `A few things worth your time today", editorFallbackCatch);
assert.ok(editorInvocation >= 0 && assemble.includes("paidCallAllowed", editorInvocation));
assert.match(
  assemble,
  /generateTopicBlurb\(id, weekOf, signal, \{\s*paidCallAllowed,\s*\}\)/,
  "topic generation must receive the same guard as editor generation"
);
assert.ok(
  editorInvocation < editorFallbackCatch && editorFallbackCatch < deterministicIntro,
  "a blocked or failed optional editor note must preserve a usable deterministic intro"
);

assert.match(cron, /editorNoteAnthropic:\s*editorNoteAnthropicCallCount\(\)/);
assert.match(cron, /deepseek:\s*deepseekCallCount\(\)/);
assert.match(cron, /const paidCallBaseline = currentPaidCallSnapshot\(\)/);
assert.match(
  cron,
  /const paidCallBudgetDate = currentPeriodIso\(\)[\s\S]*createDailyPaidCallGuard\(\s*sb,\s*paidCallBudgetDate,\s*25\s*\)[\s\S]*const paidCallAllowed = async \(\): Promise<boolean> => \{[\s\S]*dailyPaidCallBudget\.allow\(\)[\s\S]*if \(!allowed\) paidCallCeilingHit = true/
);
assert.match(
  cron,
  /const paidCallBudgetDate = currentPeriodIso\(\)[\s\S]*const weekOf = weekOfOverride \?\? paidCallBudgetDate/,
  "historical issue overrides must still share the real invocation-day spend ceiling"
);
assert.match(cron, /const summary = \{[\s\S]*paidCallBudgetDate,/);
assert.match(
  generateRoute,
  /createDailyPaidCallGuard\([\s\S]{0,180}defaultWeekOf\(\),\s*10\s*\)[\s\S]{0,500}generateIssue\([\s\S]{0,300}interactivePaidCallBudget\.allow/,
  "interactive generation must reserve from the same durable real-day paid-call ceiling"
);
assert.doesNotMatch(
  cron,
  /DEFERRED \(paid-call ceiling exhausted\)/,
  "paid exhaustion must not skip subscribers who can still use free or persisted content"
);
assert.match(cron, /paidCallsSinceBaseline\([\s\S]*paidCallBaseline,[\s\S]*currentPaidCallSnapshot\(\)/);
assert.match(cron, /paidCallReservationsGranted:\s*paidCallBudget\.granted/);
assert.match(cron, /paidCallReservationError:\s*paidCallBudget\.error/);
const reservationSql = source("../supabase/migrations/20260827050000_daily_paid_call_budget.sql");
assert.match(reservationSql, /reserved_calls\s*<=\s*400/);
assert.match(reservationSql, /grant execute on function public\.reserve_alpha_paid_calls\(date, integer\)\s+to service_role/);
assert.equal(
  cron.match(/failedCache,\s*paidCallAllowed\s*\)/g)?.length,
  2,
  "normal and fast-fallback generateIssue calls must share the paid-call guard"
);

console.log("PASS verify-r80-editor-cost-budget (offline, 34 assertions)");
