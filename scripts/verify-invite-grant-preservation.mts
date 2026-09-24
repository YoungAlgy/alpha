// Offline regression proof for the Stripe-linked invite entitlement path.
// This executes the actual source-extracted grant/revoke branch with inert
// in-memory dependencies. It neither imports Next/provider clients nor reads
// environment files, networks, or real user data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { hasReaderAccess } from "../lib/access.ts";

const NOW = "2026-09-20T19:20:29.000Z";
const AFTER_PAID_DEADLINE = new Date("2026-09-20T19:20:29.001Z");
const RealDate = Date;
const FrozenDate = class extends RealDate {
  constructor(value?: string | number | Date) {
    super(value === undefined ? NOW : value);
  }

  static now() {
    return new RealDate(NOW).getTime();
  }
} as DateConstructor;

type Row = {
  id: string;
  stripe_customer_id: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  stripe_subscription_id: string | null;
  access_requested_at: string | null;
  access_granted_at: string | null;
  delivery_enrolled: boolean;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  suppression_cleanup_pending_at: string | null;
  delivery_suppression_cleared_at: string | null;
};

const baseRow = (): Row => ({
  id: "unit-reader",
  stripe_customer_id: "unit-customer",
  stripe_subscription_id: "unit-subscription",
  subscribed_at: "2026-08-01T00:00:00.000Z",
  cancelled_at: "2026-09-20T19:20:29.000Z",
  access_requested_at: "2026-09-19T00:00:00.000Z",
  access_granted_at: null,
  delivery_enrolled: true,
  unsubscribed_at: "2026-09-01T00:00:00.000Z",
  bounced_at: "2026-09-02T00:00:00.000Z",
  complained_at: "2026-09-03T00:00:00.000Z",
  suppression_cleanup_pending_at: "2026-09-04T00:00:00.000Z",
  delivery_suppression_cleared_at: "2026-09-05T00:00:00.000Z",
});

type Options = {
  prefetchError?: boolean;
  updateError?: boolean;
  race?: (row: Row) => void;
};

type Filter = { kind: "eq" | "is"; column: keyof Row; value: string | boolean | null };

type InertDb = {
  row: Row | null;
  updates: Array<Record<string, unknown>>;
  updateFilters: Filter[][];
  sb: { from(table: string): unknown };
};

function createInertDb(row: Row | null, options: Options = {}): InertDb {
  const db: Omit<InertDb, "sb"> = { row, updates: [], updateFilters: [] };
  const result = (value: unknown) => ({
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  });
  const from = (table: string) => {
    assert.equal(table, "users");
    let patch: Record<string, unknown> | null = null;
    const filters: Filter[] = [];
    let raceApplied = false;
    const matchesFilters = (candidate: Row) =>
      filters.every(({ kind, column, value }) =>
        kind === "eq" ? candidate[column] === value : candidate[column] === null
      );
    const query = {
      select() {
        if (patch) {
          if (options.updateError) return result({ data: null, error: { message: "unit update failure" } });
          if (!raceApplied && options.race && db.row) {
            options.race(db.row);
            raceApplied = true;
          }
          db.updateFilters.push(structuredClone(filters));
          if (!db.row || !matchesFilters(db.row)) return result({ data: [], error: null });
          db.updates.push(structuredClone(patch));
          Object.assign(db.row, patch);
          return result({ data: [{ id: db.row.id }], error: null });
        }
        return query;
      },
      update(next: Record<string, unknown>) {
        patch = next;
        return query;
      },
      eq(column: keyof Row, value: string | boolean) {
        filters.push({ kind: "eq", column, value });
        return query;
      },
      is(column: keyof Row, value: null) {
        assert.equal(value, null);
        filters.push({ kind: "is", column, value });
        return query;
      },
      maybeSingle() {
        return result({
          data: options.prefetchError || !db.row ? null : structuredClone(db.row),
          error: options.prefetchError ? { message: "unit prefetch failure" } : null,
        });
      },
    };
    return query;
  };
  return { ...db, sb: { from } };
}

const routePath = fileURLToPath(new URL("../app/api/admin/users/route.ts", import.meta.url));
const routeSource = readFileSync(routePath, "utf8");
const branchStart = routeSource.indexOf(
  'if (body.action === "grant_invite" || body.action === "revoke_invite")'
);
const branchEnd = routeSource.indexOf('if (body.action === "grant_free")', branchStart);
assert.ok(branchStart >= 0 && branchEnd > branchStart, "invite branch must remain source-extractable");
const inviteBranch = routeSource.slice(branchStart, branchEnd);

assert.match(inviteBranch, /access_requested_at: null, access_granted_at: grantedAt/);
assert.match(inviteBranch, /access_requested_at: null, access_granted_at: null/);
assert.doesNotMatch(inviteBranch, /stripe\.|fetch\(|send[A-Z]|Resend|supabaseServiceClient/);
assert.doesNotMatch(inviteBranch, /cancelled_at\s*:/);
assert.doesNotMatch(inviteBranch, /subscribed_at\s*:/);
assert.doesNotMatch(inviteBranch, /unsubscribed_at\s*:/);
assert.doesNotMatch(inviteBranch, /bounced_at\s*:/);
assert.doesNotMatch(inviteBranch, /complained_at\s*:/);
assert.doesNotMatch(inviteBranch, /suppression_cleanup_pending_at\s*:/);
assert.doesNotMatch(inviteBranch, /delivery_suppression_cleared_at\s*:/);

const NextResponse = {
  json(value: unknown, init?: { status?: number }) {
    return { value, status: init?.status ?? 200 };
  },
};
const quietConsole = { error() {} };
const blockedFetch = () => {
  throw new Error("offline test blocked a network call");
};

async function invoke(action: "grant_invite" | "revoke_invite", db: InertDb) {
  // The extracted branch gets a fresh VM global. Its only available network
  // primitive is a tripwire that throws, and its clock is fixed for this test.
  const response = await (runInNewContext(
    `(async () => { ${inviteBranch} })()`,
    {
      body: { action, userId: "unit-reader" },
      sb: db.sb,
      NextResponse,
      console: quietConsole,
      Date: FrozenDate,
      fetch: blockedFetch,
    }
  ) as Promise<{ value: unknown; status: number }>);
  return structuredClone(response);
}

let tests = 0;
async function test(name: string, body: () => Promise<void>) {
  await body();
  tests += 1;
  console.log(`PASS ${name}`);
}

await test("grant touches only entitlement fields and preserves billing and delivery blocks", async () => {
  const row = baseRow();
  const before = structuredClone(row);
  const db = createInertDb(row);
  const response = await invoke("grant_invite", db);
  assert.deepEqual(response, { value: { ok: true }, status: 200 });
  assert.deepEqual(db.updates, [{ access_requested_at: null, access_granted_at: NOW }]);
  assert.equal(row.cancelled_at, before.cancelled_at);
  assert.equal(row.subscribed_at, before.subscribed_at);
  assert.equal(row.stripe_customer_id, before.stripe_customer_id);
  assert.equal(row.stripe_subscription_id, before.stripe_subscription_id);
  assert.equal(row.unsubscribed_at, before.unsubscribed_at);
  assert.equal(row.bounced_at, before.bounced_at);
  assert.equal(row.complained_at, before.complained_at);
  assert.equal(row.suppression_cleanup_pending_at, before.suppression_cleanup_pending_at);
  assert.equal(row.delivery_suppression_cleared_at, before.delivery_suppression_cleared_at);
  assert.deepEqual(db.updateFilters, [[
    { kind: "eq", column: "id", value: "unit-reader" },
    { kind: "eq", column: "stripe_customer_id", value: "unit-customer" },
    { kind: "eq", column: "subscribed_at", value: "2026-08-01T00:00:00.000Z" },
    { kind: "eq", column: "access_requested_at", value: "2026-09-19T00:00:00.000Z" },
    { kind: "is", column: "access_granted_at", value: null },
  ]]);
});

await test("grant keeps reader access at and after the paid deadline without clearing suppression", async () => {
  const row = baseRow();
  const db = createInertDb(row);
  await invoke("grant_invite", db);
  assert.equal(hasReaderAccess(row.subscribed_at, row.cancelled_at, row.access_granted_at, new Date(NOW)), true);
  assert.equal(hasReaderAccess(row.subscribed_at, row.cancelled_at, row.access_granted_at, AFTER_PAID_DEADLINE), true);
  assert.equal(row.unsubscribed_at, "2026-09-01T00:00:00.000Z");
  assert.equal(row.suppression_cleanup_pending_at, "2026-09-04T00:00:00.000Z");
});

await test("paid access is true before the deadline and false at it without an invite", async () => {
  const row = baseRow();
  assert.equal(
    hasReaderAccess(row.subscribed_at, row.cancelled_at, null, new Date("2026-09-20T19:20:28.999Z")),
    true
  );
  assert.equal(hasReaderAccess(row.subscribed_at, row.cancelled_at, null, new Date(NOW)), false);
});

await test("an indefinite no-Stripe reader remains readable through the pure access rule", async () => {
  assert.equal(
    hasReaderAccess("2026-08-01T00:00:00.000Z", null, null, AFTER_PAID_DEADLINE),
    true
  );
});

await test("grant is idempotent when access is already granted", async () => {
  const row = { ...baseRow(), access_requested_at: null, access_granted_at: "2026-09-10T00:00:00.000Z" };
  const db = createInertDb(row);
  const response = await invoke("grant_invite", db);
  assert.deepEqual(response, { value: { ok: true, alreadyGranted: true }, status: 200 });
  assert.deepEqual(db.updates, []);
});

await test("already-granted pending request clears only the request and preserves its grant timestamp", async () => {
  const row = { ...baseRow(), access_granted_at: "2026-09-10T00:00:00.000Z" };
  const db = createInertDb(row);
  const response = await invoke("grant_invite", db);
  assert.deepEqual(response, { value: { ok: true, alreadyGranted: true }, status: 200 });
  assert.deepEqual(db.updates, [{ access_requested_at: null }]);
  assert.equal(row.access_granted_at, "2026-09-10T00:00:00.000Z");
});

await test("revoke clears invite access and pauses letters while preserving billing and suppression", async () => {
  const row = { ...baseRow(), access_granted_at: "2026-09-10T00:00:00.000Z" };
  const before = structuredClone(row);
  const db = createInertDb(row);
  const response = await invoke("revoke_invite", db);
  assert.deepEqual(response, { value: { ok: true }, status: 200 });
  assert.deepEqual(db.updates, [{ access_requested_at: null, access_granted_at: null, delivery_enrolled: false }]);
  assert.equal(row.delivery_enrolled, false);
  assert.equal(row.cancelled_at, before.cancelled_at);
  assert.equal(row.subscribed_at, before.subscribed_at);
  assert.equal(row.unsubscribed_at, before.unsubscribed_at);
  assert.equal(row.bounced_at, before.bounced_at);
  assert.equal(row.complained_at, before.complained_at);
  assert.equal(row.suppression_cleanup_pending_at, before.suppression_cleanup_pending_at);
  assert.equal(row.delivery_suppression_cleared_at, before.delivery_suppression_cleared_at);
});

await test("missing row returns not found", async () => {
  const response = await invoke("grant_invite", createInertDb(null));
  assert.deepEqual(response, { value: { error: "User not found." }, status: 404 });
});

await test("no Stripe binding stays on the free-access path", async () => {
  const response = await invoke("grant_invite", createInertDb({ ...baseRow(), stripe_customer_id: null }));
  assert.deepEqual(response, { value: { error: "Use Grant free for a reader with no Stripe account." }, status: 400 });
});

await test("Stripe binding without a local subscription stamp is held for review", async () => {
  const response = await invoke("grant_invite", createInertDb({ ...baseRow(), subscribed_at: null }));
  assert.equal(response.status, 409);
  assert.match((response.value as { error: string }).error, /no local access stamp/);
});

await test("query failures return a server error without writes", async () => {
  const prefetchDb = createInertDb(baseRow(), { prefetchError: true });
  const prefetchResponse = await invoke("grant_invite", prefetchDb);
  assert.equal(prefetchResponse.status, 500);
  assert.deepEqual(prefetchDb.updates, []);
  const updateDb = createInertDb(baseRow(), { updateError: true });
  const updateResponse = await invoke("grant_invite", updateDb);
  assert.equal(updateResponse.status, 500);
  assert.deepEqual(updateDb.updates, []);
});

await test("compare-and-swap ownership fences reject raced values without overwriting", async () => {
  const races: Array<[keyof Row, string | null]> = [
    ["id", "unit-other-reader"],
    ["stripe_customer_id", "unit-other-customer"],
    ["subscribed_at", "2026-08-02T00:00:00.000Z"],
    ["access_requested_at", "2026-09-19T00:00:01.000Z"],
    ["access_granted_at", "2026-09-19T00:00:02.000Z"],
  ];
  for (const [column, racedValue] of races) {
    const row = baseRow();
    const db = createInertDb(row, { race: (target) => { Object.assign(target, { [column]: racedValue }); } });
    const response = await invoke("grant_invite", db);
    assert.equal(response.status, 409, `${column} race must be rejected`);
    assert.deepEqual(db.updates, [], `${column} race must not write`);
    assert.equal(row[column], racedValue, `${column} raced value must not be overwritten`);
  }
});

console.log(`PASS verify-invite-grant-preservation (offline, ${tests} tests)`);
