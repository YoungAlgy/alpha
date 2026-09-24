// Offline account-state checks. All rows are invented fixtures; this script
// imports only the pure presentation helper and never starts the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { getAdminAccountState, type AdminAccountStateInput } from "../lib/admin-account-state.ts";
import { hasUsableReaderProfile } from "../lib/reader-profile-state.ts";

const past = "2020-01-01T00:00:00.000Z";
const base = (): AdminAccountStateInput => ({
  first_name: "Fixture",
  topics: ["mental-health"],
  stripe_customer_id: null,
  stripe_subscription_id: null,
  subscribed_at: null,
  cancelled_at: null,
  access_requested_at: null,
  access_granted_at: null,
  delivery_enrolled: false,
  unsubscribed_at: null,
  bounced_at: null,
  complained_at: null,
  suppression_cleanup_pending_at: null,
  suppression_recovery_started_at: null,
  has_suppression_recovery: false,
});
const state = (patch: Partial<AdminAccountStateInput> = {}) =>
  getAdminAccountState({ ...base(), ...patch });

const authOnly = state();
assert.equal(authOnly.accessLabel, "Signup started");
assert.equal(authOnly.pending, false);
assert.equal(authOnly.grantAction, "grant_free");
assert.equal(authOnly.canEnableDelivery, false);

const pending = state({ access_requested_at: past });
assert.equal(pending.accessLabel, "Access requested");
assert.equal(pending.pending, true);
assert.equal(pending.canEnableDelivery, false);

const free = state({ subscribed_at: past, access_granted_at: past });
assert.equal(free.accessLabel, "Free (granted)");
assert.equal(free.grantAction, null);
assert.equal(free.revokeAction, "revoke_free");
assert.equal(free.canEnableDelivery, true);
assert.equal(free.deliveryLabel, "Letters paused", "granting access does not enroll delivery");

const pastBillingInvite = state({
  subscribed_at: past,
  cancelled_at: past,
  access_granted_at: past,
  stripe_customer_id: "cus_fixture",
  stripe_subscription_id: "sub_fixture",
  delivery_enrolled: true,
});
assert.equal(pastBillingInvite.accessLabel, "Free (granted)");
assert.equal(pastBillingInvite.grantAction, null, "an existing invite cannot be granted twice");
assert.equal(pastBillingInvite.revokeAction, "revoke_invite");
assert.equal(pastBillingInvite.revokeNote, "");
assert.equal(pastBillingInvite.deliveryLabel, "Letters enabled");

const missingProfile = state({ subscribed_at: past, access_granted_at: past, first_name: null, topics: [] });
assert.equal(missingProfile.readerAccess, true);
assert.equal(missingProfile.canEnableDelivery, false);
assert.match(missingProfile.deliveryBlockReason ?? "", /Signup is unfinished/);
assert.equal(missingProfile.deliveryLabel, "Letters paused");
assert.equal(state({ subscribed_at: past, access_granted_at: past, topics: ["constructor"] }).canEnableDelivery, false);
assert.equal(state({ subscribed_at: past, access_granted_at: past, topics: ["zodiac"], birthday: null }).canEnableDelivery, false);
assert.equal(hasUsableReaderProfile({ first_name: "Reader", topics: ["zodiac"], birthday: null }), false);

for (const [field, value] of [
  ["unsubscribed_at", past],
  ["bounced_at", past],
  ["complained_at", past],
  ["suppression_cleanup_pending_at", past],
  ["suppression_recovery_started_at", past],
  ["has_suppression_recovery", true],
] as const) {
  const blocked = state({ subscribed_at: past, access_granted_at: past, [field]: value });
  assert.equal(blocked.canEnableDelivery, false, `${field} must block the offered action`);
  assert.ok(blocked.deliveryBlockReason, `${field} needs an explanation`);
  if (field === "unsubscribed_at") assert.match(blocked.deliveryBlockReason ?? "", /unsubscribed/);
}
assert.equal(
  state({ subscribed_at: past, access_granted_at: past, delivery_enrolled: true, bounced_at: past }).deliveryLabel,
  "Letters blocked",
);

const legacyBinding = state({ stripe_subscription_id: "sub_fixture" });
assert.equal(legacyBinding.grantAction, null, "a subscription-only binding must not offer grant_free");
assert.equal(legacyBinding.needsAccountReview, true);
assert.equal(state({ stripe_customer_id: "cus_fixture" }).grantAction, null);
assert.equal(state({ stripe_customer_id: "cus_fixture", subscribed_at: past }).grantAction, "grant_invite");

// Execute the actual Accounts load() function with inert fetch/state setters.
// This checks the pending, all, and search transitions without rendering React
// or touching any account service.
const pageSource = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("accounts.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = parsed.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "AdminAccountsPage");
assert.ok(component?.body);
const load = component.body.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "load");
assert.ok(load?.body);
const loadJs = ts.transpileModule(load.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let rows: Array<{ id: string }> | null = [{ id: "old-row" }];
let stats: unknown = null;
let loading = false;
let error: string | null = null;
let more = false;
const loadSeqRef = { current: 0 };
const mountedRef = { current: true };
const pendingFetches: Array<{ url: string; resolve: (response: unknown) => void }> = [];
const inertFetch = (url: string) => new Promise((resolve) => pendingFetches.push({ url, resolve }));
const makeLoad = new Function(
  "fetch", "setUsers", "setStats", "setLoading", "setErr", "setHasMore",
  "setStatsStale", "setActionMsg", "loadSeqRef", "mountedRef", "err", "users",
  `${loadJs}\nreturn load;`,
) as (...args: unknown[]) => (options?: { pending?: boolean; search?: string }) => Promise<void>;
const loadRows = makeLoad(
  inertFetch,
  (next: unknown) => { rows = typeof next === "function" ? (next as (current: typeof rows) => typeof rows)(rows) : next as typeof rows; },
  (next: unknown) => { stats = next; },
  (next: boolean) => { loading = next; },
  (next: string | null) => { error = next; },
  (next: boolean) => { more = next; },
  () => {}, () => {}, loadSeqRef, mountedRef, error, rows,
);
const reply = (index: number, ids: string[]) => pendingFetches[index].resolve({
  ok: true,
  status: 200,
  json: async () => ({ users: ids.map((id) => ({ id })), stats: { totalUsers: ids.length } }),
});
const pendingLoad = loadRows({ pending: true });
assert.equal(pendingFetches[0].url, "/api/admin/users?pending=1");
assert.equal(rows, null, "switching to pending clears previously shown rows");
reply(0, ["pending-row"]);
await pendingLoad;
assert.deepEqual(rows, [{ id: "pending-row" }]);

const allLoad = loadRows();
assert.equal(pendingFetches[1].url, "/api/admin/users");
assert.equal(rows, null, "switching to all clears pending rows");
reply(1, ["all-row"]);
await allLoad;
assert.deepEqual(rows, [{ id: "all-row" }]);

const stalePending = loadRows({ pending: true });
const searchLoad = loadRows({ search: "fixture" });
assert.equal(pendingFetches[3].url, "/api/admin/users?q=fixture");
assert.equal(rows, null, "search clears the previous filter's rows");
reply(3, ["search-row"]);
await searchLoad;
reply(2, ["stale-pending-row"]);
await stalePending;
assert.deepEqual(rows, [{ id: "search-row" }], "late pending response cannot replace search results");
assert.equal(loading, false);
assert.equal(error, null);
assert.equal(more, false);
assert.deepEqual(stats, { totalUsers: 1 });
assert.match(pageSource, /setRowErrors\(\(prev\) => \(\{[\s\S]*?e instanceof Error \? e\.message/);
const act = component.body.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "act");
assert.ok(act?.body);
let alertCalls = 0;
const inspect = (node: ts.Node) => {
  if (ts.isCallExpression(node) &&
      (node.expression.getText(parsed) === "alert" || node.expression.getText(parsed) === "window.alert")) alertCalls++;
  ts.forEachChild(node, inspect);
};
inspect(act.body);
assert.equal(alertCalls, 0, "action errors stay in their account row instead of a browser alert");

console.log("Admin account flow offline fixtures passed.");
