// Offline contract for an owner-approved account whose auth-created profile
// never received the reader's onboarding answers. No provider or DB calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasUsableReaderProfile } from "../lib/reader-profile-state.ts";
import { TOPICS } from "../lib/topics.ts";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const route = source("../app/api/access/request/route.ts");
const checkout = source("../app/checkout/page.tsx");

assert.ok(route.indexOf("authOwnsAccessRequestEmail(signedInUser.email, email)") <
  route.indexOf("const repair = {"), "auth email ownership precedes repair");
assert.match(route, /\.eq\("updated_at", existing\.updated_at\)[\s\S]*?\.eq\("access_granted_at", existing\.access_granted_at\)/);
assert.doesNotMatch(route.slice(route.indexOf("const repair = {"), route.indexOf("const repaired =")),
  /access_requested_at|delivery_enrolled|subscribed_at|cancelled_at|stripe_customer_id|suppression/);
assert.match(checkout, /approvedNeedsProfile[\s\S]*?Finish signup/);
assert.match(checkout, /!hasUsableReaderProfile\(profile\)/);
assert.equal(hasUsableReaderProfile({ first_name: "Reader", topics: ["zodiac"], birthday: null }), false);
assert.equal(hasUsableReaderProfile({ first_name: "Reader", topics: ["zodiac"], birthday: "1990-05-01" }), true);
assert.equal(hasUsableReaderProfile({ first_name: "Reader", topics: ["constructor"] }), false);
assert.equal(hasUsableReaderProfile({ first_name: "Reader", topics: ["mental-health"] }), true);
assert.match(checkout, /isProfileComplete\(state\)[\s\S]*?Finish in settings/);
assert.doesNotMatch(checkout.slice(checkout.indexOf("readOnboardingAccountState().then"),
  checkout.indexOf("function rememberCheckoutSignIn")), /requestAccess\(/);

const begin = route.indexOf("  if (\n    hasReaderAccess(", route.indexOf("const { data: existing"));
const end = route.indexOf("  let result;", begin);
assert.ok(begin >= 0 && end > begin, "approved repair branch can be exercised offline");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
const evaluate = new AsyncFunction("existing", "profile", "sb", "userId", "hasReaderAccess",
  "hasUsableReaderProfile", "NextResponse", "console", `${route.slice(begin, end)}return null;`);
const profile = {
  first_name: "Nick", topics: TOPICS.slice(0, 5).map((topic) => topic.id),
  city: "Tampa", job_blurb: "work", project_blurb: null, fun_blurb: null,
  birthday: null, gender: null,
};
const base = {
  id: "account-1", updated_at: "2026-09-24T01:00:00Z", access_granted_at: "2026-09-23T01:00:00Z",
  subscribed_at: null, cancelled_at: null, stripe_customer_id: null,
  first_name: null, topics: [], city: null, job_blurb: null,
  project_blurb: null, fun_blurb: null, birthday: null, gender: null,
};
const responses = { json: (body: Record<string, unknown>, opts?: { status: number }) => ({ body, status: opts?.status ?? 200 }) };
const hasAccess = (_subscribed: unknown, _cancelled: unknown, grant: unknown) => !!grant;
const silentConsole = { error: () => {} };

async function run(existing: typeof base, result: { data: unknown; error: unknown }) {
  const writes: Array<{ fields: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const sb = { from: () => ({ update(fields: Record<string, unknown>) {
    const filters: Array<[string, unknown]> = [];
    writes.push({ fields, filters });
    const chain = {
      eq(column: string, value: unknown) { filters.push([column, value]); return chain; },
      is(column: string, value: unknown) { filters.push([column, value]); return chain; },
      select() { return chain; },
      maybeSingle: async () => result,
    };
    return chain;
  } }) };
  const response = await evaluate(existing, profile, sb, "account-1", hasAccess,
    hasUsableReaderProfile, responses, silentConsole);
  return { response: response as { body: Record<string, unknown>; status: number } | null, writes };
}

let outcome = await run(base, { data: { id: "account-1" }, error: null });
assert.deepEqual(outcome.response, { body: { ok: true, repaired: true }, status: 200 });
assert.equal(outcome.writes.length, 1);
assert.equal(outcome.writes[0].fields.first_name, "Nick");
assert.deepEqual(outcome.writes[0].fields.topics, profile.topics);
assert.deepEqual(outcome.writes[0].filters, [
  ["id", "account-1"], ["access_granted_at", base.access_granted_at], ["updated_at", base.updated_at],
]);
assert.equal("access_requested_at" in outcome.writes[0].fields, false);
assert.equal("delivery_enrolled" in outcome.writes[0].fields, false);

outcome = await run({ ...base, first_name: "Saved name", topics: ["mental-health"] }, { data: null, error: null });
assert.equal(outcome.response?.status, 409);
assert.equal(outcome.writes.length, 0, "a complete saved profile ignores an older draft");

outcome = await run({ ...base, first_name: "Saved name" }, { data: { id: "account-1" }, error: null });
assert.equal(outcome.writes[0].fields.first_name, "Saved name", "repair preserves present fields");
assert.deepEqual(outcome.writes[0].fields.topics, profile.topics);

outcome = await run(base, { data: null, error: null });
assert.equal(outcome.response?.status, 409, "a concurrent account edit requires retry");

outcome = await run({ ...base, access_granted_at: null }, { data: null, error: null });
assert.equal(outcome.response, null, "an unapproved account continues through the request branch");
assert.equal(outcome.writes.length, 0);

outcome = await run({ ...base, updated_at: null as unknown as string }, { data: { id: "account-1" }, error: null });
assert.deepEqual(outcome.writes[0].filters[1], ["access_granted_at", base.access_granted_at]);
assert.deepEqual(outcome.writes[0].filters[2], ["updated_at", null], "null account clock uses a null filter");

const requestBegin = route.indexOf("  let result;", route.indexOf("const { data: existing"));
const requestEnd = route.indexOf("  // The database row is the source of truth.", requestBegin);
assert.ok(requestBegin >= 0 && requestEnd > requestBegin);
const evaluateRequest = new AsyncFunction("existing", "profile", "sb", "userId", "NextResponse", "console",
  `${route.slice(requestBegin, requestEnd)}return null;`);
async function runRequest(existing: typeof base | null, result: { data: unknown; error: unknown }) {
  const calls: Array<{ action: string; payload: Record<string, unknown>; filters: Array<[string, string, unknown]> }> = [];
  const sb = { from: () => ({
    update(payload: Record<string, unknown>) { return chain("update", payload); },
    insert(payload: Record<string, unknown>) { return chain("insert", payload); },
  }) };
  function chain(action: string, payload: Record<string, unknown>) {
    const filters: Array<[string, string, unknown]> = [];
    calls.push({ action, payload, filters });
    const query = {
      eq(column: string, value: unknown) { filters.push(["eq", column, value]); return query; },
      is(column: string, value: unknown) { filters.push(["is", column, value]); return query; },
      select() { return query; },
      maybeSingle: async () => result,
    };
    return query;
  }
  const response = await evaluateRequest(existing, profile, sb, "account-1", responses, silentConsole);
  return { response: response as { body: Record<string, unknown>; status: number } | null, calls };
}

let requested = await runRequest(base, { data: { id: "account-1" }, error: null });
assert.equal(requested.response, null, "unchanged account continues to request success");
assert.deepEqual(requested.calls[0].filters, [
  ["eq", "id", "account-1"], ["is", "subscribed_at", null],
  ["eq", "access_granted_at", base.access_granted_at], ["eq", "updated_at", base.updated_at],
]);

requested = await runRequest({ ...base, access_granted_at: null }, { data: null, error: null });
assert.equal(requested.response?.status, 409, "concurrent grant cannot become a new pending request");
assert.deepEqual(requested.calls[0].filters[2], ["is", "access_granted_at", null]);

requested = await runRequest({ ...base, subscribed_at: null, access_granted_at: null,
  updated_at: null as unknown as string }, { data: { id: "account-1" }, error: null });
assert.deepEqual(requested.calls[0].filters[3], ["is", "updated_at", null]);

requested = await runRequest(null, { data: null, error: { code: "23505" } });
assert.equal(requested.response?.status, 409, "auth-only insert collision asks for a refresh");
assert.equal(requested.calls[0].action, "insert");

console.log("Approved signup repair offline checks passed.");
