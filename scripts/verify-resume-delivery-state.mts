// Focused offline behavior checks. No environment loader, framework/client
// import, network, provider, database, child process or server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  getResumeLetterStatus, parseResumeLetterResponse, RESUME_LETTER_MESSAGES,
} from "../lib/resume-letter-status";

let checks = 0;
function same(actual: unknown, expected: unknown) { assert.deepEqual(actual, expected); checks++; }
const NOW = new Date("2026-10-24T12:00:00Z");
const ID = "reader-id";
const base = {
  id: ID, email: "reader@fixture.invalid",
  subscribed_at: "2026-01-01T00:00:00Z", cancelled_at: null,
  access_granted_at: "2026-01-01T00:00:00Z", delivery_enrolled: true,
  unsubscribed_at: null, bounced_at: null, complained_at: null,
  suppression_cleanup_pending_at: null, brevo_unsubscribed_at: null,
};
const classify = (row: unknown, brevo = true, letters = true) =>
  getResumeLetterStatus(row, { brevoSchemaEnabled: brevo, lettersEnabled: letters, now: NOW });
same(classify(base), "eligible");
same(classify({ ...base, delivery_enrolled: false }), "owner-paused");
same(classify(base, true, false), "sending-paused");
for (const field of ["bounced_at", "complained_at", "suppression_cleanup_pending_at", "brevo_unsubscribed_at"]) {
  same(classify({ ...base, [field]: "2026-10-01T00:00:00Z" }), "delivery-review");
}
same(classify({ ...base, subscribed_at: null }), "access-required");
same(classify({ ...base, access_granted_at: null, cancelled_at: "2026-10-01T00:00:00Z" }), "access-required");
same(classify({ ...base, cancelled_at: "2026-10-01T00:00:00Z" }), "eligible"); // Permanent free invite survives paid period end.
same(classify({ ...base, access_granted_at: null, cancelled_at: "2030-01-01T00:00:00Z" }), "eligible");
for (const email of [null, undefined, "", "  ", 1]) same(classify({ ...base, email }), "unverified");
for (const enrollment of [null, undefined, "true", 1]) same(classify({ ...base, delivery_enrolled: enrollment }), "unverified");
for (const row of [null, {}, [], { ...base, unsubscribed_at: "2026-10-01T00:00:00Z" },
  { ...base, bounced_at: undefined }, { ...base, complained_at: "invalid" }]) same(classify(row), "unverified");
same(classify({ ...base, brevo_unsubscribed_at: undefined }), "unverified");
same(classify({ ...base, brevo_unsubscribed_at: undefined }, false), "eligible");
same(classify({ ...base, brevo_unsubscribed_at: "2026-10-01T00:00:00Z" }, false), "eligible");

for (const status of Object.keys(RESUME_LETTER_MESSAGES)) {
  same(parseResumeLetterResponse({ ok: true, status }), status);
}
for (const payload of [null, [], {}, { ok: true }, { ok: true, status: "new-status" },
  { ok: false, status: "eligible" }, { ok: 1, status: "eligible" },
  { ok: true, status: "__proto__" }, Object.create({ ok: true, status: "eligible" })]) {
  same(parseResumeLetterResponse(payload), null);
}

const route = readFileSync(new URL("../app/api/resume/route.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("resume.ts", route, ts.ScriptTarget.Latest, true);
const post = parsed.statements.find((n): n is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(n) && n.name?.text === "POST");
assert.ok(post?.body);
const handlerText = "async function POST() " + post.body.getText(parsed) + "\nthis.handler = POST;";
type Row = Record<string, unknown>;
async function run(options: {
  row?: Row | null; schema?: boolean; letters?: boolean; signedIn?: boolean;
  limited?: boolean; updateError?: boolean; readError?: boolean; returnedRows?: unknown;
  currentOverride?: Row | null;
} = {}) {
  const row = options.row === undefined ? { ...base, unsubscribed_at: "2026-10-01T00:00:00Z" } : options.row && { ...options.row };
  const before = row && { ...row };
  const schema = options.schema ?? true;
  const calls: { writes: Row[]; reads: number; updates: number; selected: string[]; ids: unknown[] } =
    { writes: [], reads: 0, updates: 0, selected: [], ids: [] };
  const svc = { from(table: string) {
    assert.equal(table, "users");
    let patch: Row | null = null;
    let brevoFilter = false;
    const q = {
      update(value: Row) { patch = value; calls.updates++; return q; },
      eq(column: string, value: unknown) { assert.equal(column, "id"); calls.ids.push(value); return q; },
      is(column: string, value: unknown) {
        assert.equal(column, "brevo_unsubscribed_at"); assert.equal(value, null);
        brevoFilter = true; return q;
      },
      async maybeSingle() {
        calls.reads++;
        return { data: options.currentOverride === undefined ? row : options.currentOverride,
          error: options.readError ? { message: "unavailable" } : null };
      },
      select(columns: string) {
        calls.selected.push(columns);
        if (!patch) return q;
        if (options.updateError) return Promise.resolve({ data: null, error: { message: "unavailable" } });
        if (!row || brevoFilter && row.brevo_unsubscribed_at !== null) return Promise.resolve({ data: [], error: null });
        calls.writes.push({ ...patch }); Object.assign(row, patch);
        const data = Object.hasOwn(options, "returnedRows") ? options.returnedRows : [{ ...row }];
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  } };
  const context: Record<string, unknown> = {
    supabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: options.signedIn === false ? null : { id: ID } } }) } }),
    supabaseServiceClient: async () => svc,
    rateLimit: () => ({ ok: !options.limited, retryAfterSec: 60 }),
    BREVO_DELIVERY_SCHEMA_ENABLED: schema,
    SUBSCRIBER_LETTERS_ENABLED: options.letters ?? true,
    getResumeLetterStatus: (value: unknown, flags: { brevoSchemaEnabled: boolean; lettersEnabled: boolean }) =>
      getResumeLetterStatus(value, { ...flags, now: NOW }),
    NextResponse: { json: (body: unknown, init: { status?: number; headers?: object } = {}) =>
      ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) },
    Date, Number,
  };
  vm.runInNewContext(ts.transpileModule(handlerText, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const response = await (context.handler as () => Promise<{ status: number; body: Record<string, unknown> }>)();
  same(calls.ids.every((id) => id === ID), true);
  for (const write of calls.writes) same(write, { unsubscribed_at: null });
  if (row && before) same({ ...row, unsubscribed_at: before.unsubscribed_at }, before);
  same(JSON.stringify(response.body).includes("reader@fixture.invalid"), false);
  return { response, row, calls };
}

for (const schema of [false, true]) {
  const ready = await run({ schema });
  same(ready.response.status, 200); same(ready.response.body.status, "eligible");
  same(ready.row?.unsubscribed_at, null);
  same(ready.calls.selected[0].includes("delivery_enrolled"), true);
  same(ready.calls.selected[0].includes("email"), true);
  same(ready.calls.selected[0].includes("brevo_unsubscribed_at"), schema);
  const missing = await run({ schema, row: null });
  same(missing.response.status, 503); same(missing.response.body.ok, undefined);
  same((await run({ schema, updateError: true })).response.status, 503);
}
for (const [field, value, expected] of [
  ["delivery_enrolled", false, "owner-paused"], ["bounced_at", "2026-10-01T00:00:00Z", "delivery-review"],
  ["complained_at", "2026-10-01T00:00:00Z", "delivery-review"],
  ["suppression_cleanup_pending_at", "2026-10-01T00:00:00Z", "delivery-review"],
  ["subscribed_at", null, "access-required"],
] as const) {
  const outcome = await run({ row: { ...base, unsubscribed_at: "2026-10-01T00:00:00Z", [field]: value } });
  same(outcome.response.status, 200); same(outcome.response.body.status, expected);
  same(outcome.row?.unsubscribed_at, null);
}
same((await run({ letters: false })).response.body.status, "sending-paused");
for (const email of ["", undefined]) same((await run({ row: { ...base, email } })).response.status, 503);
const blocked = await run({ row: { ...base, unsubscribed_at: "2026-10-01T00:00:00Z", brevo_unsubscribed_at: "2026-10-01T00:00:00Z" } });
same(blocked.response.status, 409); same(blocked.calls.writes.length, 0);
same(blocked.row?.unsubscribed_at, "2026-10-01T00:00:00Z");
same((await run({ row: { ...base, brevo_unsubscribed_at: "2026-10-01T00:00:00Z" }, readError: true })).response.status, 503);
same((await run({ row: { ...base, brevo_unsubscribed_at: "invalid" } })).response.status, 503);
same((await run({ row: null, currentOverride: { id: "other-user", brevo_unsubscribed_at: "2026-10-01T00:00:00Z" } })).response.status, 503);
for (const returnedRows of [null, [], { 0: base, length: 1 }, [{ ...base, id: "other-user" }], [{ id: ID }], [{ ...base }, { ...base }]]) {
  const unavailable = await run({ returnedRows }); same(unavailable.response.status, 503);
  same(unavailable.response.body.ok, undefined);
}
for (const options of [{ signedIn: false }, { limited: true }]) {
  const stopped = await run(options);
  same(stopped.response.status, options.signedIn === false ? 401 : 429);
  same(stopped.calls.updates, 0);
}
const settings = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
assert.match(settings, /parseResumeLetterResponse\(data\)/);
assert.match(settings, /RESUME_LETTER_MESSAGES\[resumeStatus\]/);
assert.doesNotMatch(settings, /Your daily letters start up again from here/);
console.log(`PASS resume delivery state: ${checks} checks. Actual POST with fake store only, zero live requests.`);
