// Offline regression of the actual topics component and route. Supabase,
// React, browser, HTTP and navigation dependencies are inert VM doubles.
// No environment files, credentials, network or persistent writes are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");
const ts = createRequire(resolve(root, "package.json"))("typescript");
const routeSource = readFileSync(resolve(root, "app/api/account/topics/route.ts"), "utf8");
const componentSource = readFileSync(resolve(root, "app/topics/page.tsx"), "utf8");
const guardsSource = readFileSync(resolve(root, "lib/account-topics-guards.ts"), "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const topics = ["custom:topic one", "custom:topic two", "custom:topic three", "custom:topic four", "custom:topic five"];
const copy = <T>(value: T): T => structuredClone(value);
function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const guards: Record<string, any> = {};
vm.runInNewContext(compile(guardsSource), {
  exports: guards,
  require(name: string) {
    assert.equal(name, "@/lib/topics");
    return { isValidTopicId: (value: unknown) => typeof value === "string" && topics.includes(value) };
  },
});
function api(options: { source?: string; account?: string | null; missingRead?: boolean; missingWrite?: boolean; readError?: boolean; writeError?: boolean } = {}) {
  const writes: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let serviceCalls = 0;
  let reads = 0;
  const exports: Record<string, any> = {};
  vm.runInNewContext(compile(options.source ?? routeSource), {
    exports,
    require(name: string) {
      if (name === "next/server") return { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ status: init?.status ?? 200, body }) } };
      if (name === "@/lib/supabase/server") return {
        supabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: options.account === null ? null : { id: options.account ?? A } } }) } }),
        supabaseServiceClient: async () => {
          serviceCalls++;
          return { from(table: string) {
            assert.equal(table, "users");
            return {
              select(columns: string) {
                assert.equal(columns, "topic_quota");
                return { eq(column: string, id: string) {
                  assert.equal(column, "id");
                  assert.equal(id, options.account ?? A);
                  return { async maybeSingle() {
                    reads++;
                    return { data: options.missingRead ? null : { topic_quota: 5 }, error: options.readError ? { message: "fixture read failure" } : null };
                  } };
                } };
              },
              update(fields: Record<string, unknown>) {
                return { eq(column: string, id: string) {
                  assert.equal(column, "id");
                  writes.push({ id, fields: copy(fields) });
                  return { select(columns: string) {
                    assert.equal(columns, "id");
                    return { async maybeSingle() {
                      return { data: options.missingWrite ? null : { id }, error: options.writeError ? { message: "fixture write failure" } : null };
                    } };
                  } };
                } };
              },
            };
          } };
        },
      };
      if (name === "@/lib/types") return { clampQuota: (quota: number) => quota };
      if (name === "@/lib/engine/select-sections") return { poolCap: (quota: number) => quota + 3 };
      if (name === "@/lib/rate-limit") return { rateLimit: () => ({ ok: true }) };
      if (name === "@/lib/account-topics-guards") return guards;
      throw Error(`Unexpected route import ${name}`);
    },
    console: { error() {} },
    fetch() { throw Error("Network blocked by offline harness"); },
  });
  return {
    writes,
    get serviceCalls() { return serviceCalls; },
    get reads() { return reads; },
    async post(body: unknown) {
      return exports.POST(new Request("https://alpha.test/api/account/topics", { method: "POST", body: JSON.stringify(body) }));
    },
  };
}
type Element = { type: unknown; props: Record<string, any> };
function text(tree: any): string {
  if (tree == null || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}
function find(tree: any, predicate: (element: Element) => boolean): Element | undefined {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) return tree.map((child) => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function component(options: {
  source?: string;
  accountState?: "reader" | "signed-out";
  rowError?: boolean;
  missingRow?: boolean;
  delayedRow?: Promise<void>;
  fetch?: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
} = {}) {
  let currentAccount: string | null = options.accountState === "signed-out" ? null : A;
  const values: any[] = [];
  const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
  let index = 0;
  let pending: Array<() => void> = [];
  const mirrors: Array<{ patch: Record<string, unknown>; options?: { sync?: boolean } }> = [];
  const syncs: Array<Record<string, unknown>> = [];
  const navigation: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    Fragment: "fragment",
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (next: any) => { values[slot] = typeof next === "function" ? next(values[slot]) : next; }];
    },
    useRef(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = { current: initial };
      return values[slot];
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const slot = index++;
      const previous = effects.get(slot);
      if (!previous || !same(previous.deps, deps)) pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        effects.set(slot, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
  const router = { push: (path: string) => navigation.push(path), replace: (path: string) => navigation.push(path) };
  const draft = { firstName: "Fixture Reader", topics: copy(topics) };
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: currentAccount ? { user: { id: currentAccount } } : null }, error: null }),
      getUser: async () => ({ data: { user: currentAccount ? { id: currentAccount } : null }, error: null }),
    },
    from(table: string) {
      assert.equal(table, "users");
      return { select() { return { eq(column: string, id: string) {
        assert.equal(column, "id");
        assert.equal(id, A);
        return { async maybeSingle() {
          await options.delayedRow;
          return { data: options.missingRow ? null : { topics: copy(topics), topic_quota: 5, birthday: null }, error: options.rowError ? { message: "fixture failure" } : null };
        } };
      } }; } };
    },
  };
  const exports: Record<string, any> = {};
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  vm.runInNewContext(compile(options.source ?? componentSource), {
    exports,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "next/navigation") return { useRouter: () => router };
      if (name === "@/components/onboarding/StepShell") return { StepShell: "step-shell" };
      if (name === "@/lib/onboarding-state") return { useOnboarding: () => ({ state: draft, loaded: true, storageError: null,
        update(patch: Record<string, unknown>, config?: { sync?: boolean }) {
          mirrors.push({ patch: copy(patch), options: config && copy(config) });
          if (config?.sync !== false) syncs.push(copy(patch));
          return true;
        },
      }) };
      if (name === "@/lib/topics") return {
        TOPICS: [], SUBTOPICS: {}, PARENT_TOPIC: {},
        makeCustomTopic: () => null, isCustomTopic: (value: string) => value.startsWith("custom:"),
        customTopicText: (value: string) => value.slice(7), topicLabel: (value: string) => value,
        topicEmoji: () => "", suggestCuratedTopic: () => null,
      };
      if (name === "@/lib/types") return { clampQuota: (quota: number) => quota };
      if (name === "@/lib/engine/select-sections") return { poolCap: (quota: number) => quota + 3 };
      if (name === "@/lib/audio") return { tap() {}, unselect() {}, confirm() {} };
      if (name === "@/lib/supabase/client") return { supabaseConfigured: () => true, supabaseClient: () => sb };
      if (name === "@/lib/onboarding-account") return { readOnboardingAccountState: async () => options.accountState ?? "reader" };
      throw Error(`Unexpected component import ${name}`);
    },
    window: { location: { search: "" }, sessionStorage: { getItem: () => null, removeItem() {} } },
    URLSearchParams,
    console: { warn() {} },
    fetch: async (url: string, init: { method: string; body: string }) => {
      assert.equal(url, "/api/account/topics");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      requests.push(body);
      const response = options.fetch ? await options.fetch(body) : { status: 500, body: {} };
      return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body };
    },
  });
  function render() {
    index = 0;
    pending = [];
    const tree = exports.default();
    for (const effect of pending) effect();
    return tree;
  }
  async function settle() {
    let tree = render();
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((done) => setImmediate(done));
      tree = render();
    }
    return tree;
  }
  async function save(tree: Element) {
    const control = find(tree, (element) => element.type === "button" && /^(Save|Continue →)$/.test(text(element)));
    assert.ok(control, "save or continue control exists");
    await control.props.onClick();
    return settle();
  }
  return { settle, save, render, requests, mirrors, syncs, navigation, switchAccount(account: string | null) { currentAccount = account; } };
}

const payload = { topics, expectedAccountId: A };
for (const expectedAccountId of [undefined, null, "", "invalid", 3, {}, []]) {
  const route = api();
  assert.equal((await route.post({ ...payload, expectedAccountId })).status, 400);
  assert.equal(route.serviceCalls, 0);
  assert.equal(route.writes.length, 0);
}
const normal = api();
const app = component({ fetch: (body) => normal.post(body) });
await app.save(await app.settle());
assert.equal(app.requests.length, 1);
assert.equal(app.requests[0].expectedAccountId, A);
assert.deepEqual(normal.writes, [{ id: A, fields: { topics } }]);
assert.equal(normal.reads, 1);
assert.deepEqual(app.mirrors, [{ patch: { topics }, options: { sync: false } }]);
assert.equal(app.syncs.length, 0, "server save cannot trigger a redundant DB sync");
assert.deepEqual(app.navigation, ["/settings"]);

const switchedRoute = api({ account: B });
const switched = component({ fetch: (body) => switchedRoute.post(body) });
let tree = await switched.settle();
switched.switchAccount(B);
tree = await switched.save(tree);
assert.equal(switched.requests[0].expectedAccountId, A);
assert.equal((await switchedRoute.post(payload)).status, 409);
assert.equal(switchedRoute.serviceCalls, 0);
assert.equal(switchedRoute.writes.length, 0);
assert.equal(switched.mirrors.length, 0);
assert.equal(switched.syncs.length, 0);
assert.equal(switched.navigation.length, 0);
assert.match(text(tree), /Reload the page before saving your topics/);

for (const status of [400, 409]) {
  const rejected = component({ fetch: async () => ({ status, body: { error: "private raw server diagnostic" } }) });
  const result = await rejected.save(await rejected.settle());
  assert.match(text(result), /Reload the page/);
  assert.doesNotMatch(text(result), /private raw server diagnostic/);
  assert.equal(rejected.mirrors.length, 0);
  assert.equal(rejected.navigation.length, 0);
}
for (const options of [{ rowError: true }, { missingRow: true }]) {
  const failed = component(options);
  const result = await failed.save(await failed.settle());
  assert.match(text(result), /Couldn't check your account/);
  assert.equal(failed.requests.length, 0);
  assert.equal(failed.mirrors.length, 0);
  assert.equal(failed.navigation.length, 0);
}
let releaseRow!: () => void;
const delayed = component({ delayedRow: new Promise<void>((done) => { releaseRow = done; }) });
await delayed.settle();
delayed.switchAccount(B);
releaseRow();
const delayedTree = await delayed.save(await delayed.settle());
assert.match(text(delayedTree), /Couldn't check your account/);
assert.equal(delayed.requests.length, 0);
assert.equal(delayed.mirrors.length, 0);
assert.equal(delayed.navigation.length, 0);

const unsigned = component({ accountState: "signed-out" });
await unsigned.save(await unsigned.settle());
assert.equal(unsigned.requests.length, 0);
assert.deepEqual(unsigned.mirrors, [{ patch: { topics }, options: undefined }]);
assert.deepEqual(unsigned.navigation, ["/fun"]);

for (const options of [{ missingRead: true }, { missingWrite: true }]) {
  const route = api(options);
  const missing = component({ fetch: (body) => route.post(body) });
  const result = await missing.save(await missing.settle());
  assert.match(text(result), /Reload the page before saving your topics/);
  assert.equal(missing.requests.length, 1);
  assert.equal(missing.mirrors.length, 0, "a missing DB row cannot mirror a successful save");
  assert.equal(missing.syncs.length, 0);
  assert.equal(missing.navigation.length, 0);
  assert.equal(route.reads, 1);
  assert.equal(route.writes.length, options.missingRead ? 0 : 1);
  assert.equal((await api(options).post(payload)).status, 409);
}
for (const options of [{ readError: true }, { writeError: true }]) {
  assert.equal((await api(options).post(payload)).status, 500);
}
const signedOut = api({ account: null });
assert.equal((await signedOut.post(payload)).status, 401);
assert.equal(signedOut.serviceCalls, 0);

// Reproduce the prior account-switch defect with source strings mutated only
// in this process. No checkout files are changed by these baseline controls.
const bindingStart = routeSource.indexOf("  // Bind the saved pool to the account");
const bindingEnd = routeSource.indexOf("  // Cheap, DB-free shape check", bindingStart);
assert.ok(bindingStart >= 0 && bindingEnd > bindingStart);
const unboundRouteSource = routeSource.slice(0, bindingStart) + routeSource.slice(bindingEnd);
const unboundRoute = api({ source: unboundRouteSource, account: B });
assert.equal((await unboundRoute.post(payload)).status, 200);
assert.deepEqual(unboundRoute.writes, [{ id: B, fields: { topics } }], "baseline saves A's editor to B's current session");

const unboundComponentSource = componentSource.replace(
  "JSON.stringify({ topics: picked, expectedAccountId: accountId })",
  "JSON.stringify({ topics: picked })",
);
assert.notEqual(unboundComponentSource, componentSource);
const unboundClient = component({ source: unboundComponentSource, fetch: (body) => api().post(body) });
const unboundResult = await unboundClient.save(await unboundClient.settle());
assert.equal(unboundClient.requests[0].expectedAccountId, undefined, "baseline client omits the form's account binding");
assert.match(text(unboundResult), /Reload the page/);
assert.equal(unboundClient.mirrors.length, 0);
assert.equal(unboundClient.navigation.length, 0);
console.log("PASS verify-topics-account-binding (real route and component, inert offline account, hydrate and mirror checks)");
