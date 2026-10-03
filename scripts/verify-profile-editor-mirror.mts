// Offline regression for the real profile component and route. All auth,
// browser, HTTP, database and React dependencies are inert VM doubles.
// Mutations below stay in memory and prove the fixtures detect the old bugs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import { parseBirthday, coerceGender } from "../lib/demographics.ts";
import { BLURB_CAPS } from "../lib/types.ts";
import { codePointSafeSlice } from "../lib/text-truncate.ts";

const root = resolve(import.meta.dirname, "..");
const ts = createRequire(resolve(root, "package.json"))("typescript");
const componentSource = readFileSync(resolve(root, "components/ProfileEditor.tsx"), "utf8");
const routeSource = readFileSync(resolve(root, "app/api/account/profile/route.ts"), "utf8");
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const savedRow = {
  first_name: "Reader", city: "Tampa", job_blurb: "Saved work",
  project_blurb: "Saved project", fun_blurb: "Saved hobby",
  birthday: "1990-05-01", gender: "male", topics: ["mental-health"],
};
type Element = { type: unknown; props: Record<string, any> };
function copy<T>(value: T): T { return structuredClone(value); }
function compile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
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
  user?: { id?: string } | null;
  authError?: unknown;
  authThrows?: boolean;
  rowError?: unknown;
  rowThrows?: boolean;
  row?: typeof savedRow | null;
  fetch?: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
} = {}) {
  const values: any[] = [];
  const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
  let index = 0;
  let pending: Array<() => void> = [];
  const mirrors: Array<{ patch: Record<string, unknown>; options?: { sync?: boolean } }> = [];
  const syncs: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const react = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (value: any) => { values[slot] = typeof value === "function" ? value(values[slot]) : value; }];
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
  const sb = {
    auth: { async getUser() {
      if (options.authThrows) throw Error("fixture auth exception");
      return { data: { user: options.user === undefined ? { id: ACCOUNT_A } : options.user }, error: options.authError ?? null };
    } },
    from(table: string) {
      assert.equal(table, "users");
      return { select() { return { eq(column: string, id: string) {
        assert.equal(column, "id");
        assert.equal(id, options.user?.id ?? ACCOUNT_A);
        return { async maybeSingle() {
          if (options.rowThrows) throw Error("fixture query exception");
          return { data: options.rowError ? null : options.row === undefined ? copy(savedRow) : copy(options.row), error: options.rowError ?? null };
        } };
      } }; } };
    },
  };
  const exports: { ProfileEditor?: () => Element } = {};
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  vm.runInNewContext(compile(options.source ?? componentSource), {
    exports,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@/lib/onboarding-state") return { useOnboarding: () => ({ update(patch: Record<string, unknown>, config?: { sync?: boolean }) {
        mirrors.push({ patch: copy(patch), options: config && copy(config) });
        if (config?.sync !== false) syncs.push(copy(patch));
        return true;
      } }) };
      if (name === "@/lib/supabase/client") return { supabaseConfigured: () => true, supabaseClient: () => sb };
      if (name === "@/lib/demographics") return { parseBirthday, coerceGender, demographicSummary: () => "", maxBirthdayForMinAge: () => "2000-01-01" };
      if (name === "@/lib/types") return { BLURB_CAPS };
      throw Error(`Unexpected component import: ${name}`);
    },
    window: { addEventListener() {}, removeEventListener() {} },
    console: { warn() {} },
    fetch: async (url: string, init: { method: string; body: string }) => {
      assert.equal(url, "/api/account/profile");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      requests.push(body);
      const result = options.fetch ? await options.fetch(body) : { status: 500, body: { error: "fixture save failure" } };
      return { status: result.status, ok: result.status >= 200 && result.status < 300, json: async () => result.body };
    },
  }, { filename: "components/ProfileEditor.tsx" });
  function render() {
    index = 0;
    pending = [];
    const tree = exports.ProfileEditor!();
    for (const effect of pending) effect();
    return tree;
  }
  async function settle() {
    let tree = render();
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((done) => setImmediate(done));
      tree = render();
    }
    return tree;
  }
  function edit(tree: Element, label: string, value: string) {
    const field = find(tree, (element) => element.props.label === label);
    assert.ok(field, `field ${label} exists`);
    field.props.onChange(value);
    return render();
  }
  async function save(tree: Element) {
    const button = find(tree, (element) => element.type === "button" && text(element) === "Save details");
    assert.ok(button, "save control exists");
    // Call even when disabled to verify the handler's own failure boundary.
    await button.props.onClick();
    return settle();
  }
  return { settle, edit, save, render, mirrors, syncs, requests };
}

function route(options: { source?: string; accountId?: string | null; writeError?: unknown } = {}) {
  const writes: Array<{ fields: Record<string, unknown>; id: string }> = [];
  let serviceCalls = 0;
  const exports: { POST?: (request: Request) => Promise<{ status: number; body: Record<string, unknown> }> } = {};
  vm.runInNewContext(compile(options.source ?? routeSource), {
    exports,
    require(name: string) {
      if (name === "next/server") return { NextResponse: { json: (body: Record<string, unknown>, init?: { status: number }) => ({ status: init?.status ?? 200, body }) } };
      if (name === "@/lib/supabase/server") return {
        supabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: options.accountId === null ? null : { id: options.accountId ?? ACCOUNT_A } } }) } }),
        supabaseServiceClient: async () => {
          serviceCalls++;
          return { from(table: string) {
            assert.equal(table, "users");
            return { update(fields: Record<string, unknown>) { return { async eq(column: string, id: string) {
              assert.equal(column, "id");
              writes.push({ fields: copy(fields), id });
              return { error: options.writeError ?? null };
            } }; } };
          } };
        },
      };
      if (name === "@/lib/demographics") return { parseBirthday, coerceGender };
      if (name === "@/lib/types") return { BLURB_CAPS };
      if (name === "@/lib/rate-limit") return { rateLimit: () => ({ ok: true }) };
      if (name === "@/lib/text-truncate") return { codePointSafeSlice };
      throw Error(`Unexpected route import: ${name}`);
    },
    console: { error() {} },
    fetch: () => { throw Error("offline fixture blocked network"); },
  }, { filename: "app/api/account/profile/route.ts" });
  async function post(body: unknown) {
    return exports.POST!(new Request("https://alpha.test/api/account/profile", { method: "POST", body: JSON.stringify(body) }));
  }
  return { post, writes, get serviceCalls() { return serviceCalls; } };
}

const authoritative = { first_name: "Saved Reader", city: "Miami", job_blurb: null, project_blurb: "Trimmed project", fun_blurb: null, birthday: null, gender: null };
const success = component({ fetch: async () => ({ status: 200, body: { ok: true, profile: authoritative } }) });
let tree = await success.settle();
tree = success.edit(tree, "First name", "  Requested Reader  ");
tree = await success.save(tree);
assert.equal(success.requests.length, 1);
assert.equal(success.requests[0].expectedAccountId, ACCOUNT_A);
assert.equal(success.mirrors.length, 1);
assert.deepEqual(success.mirrors[0], { patch: {
  firstName: "Saved Reader", city: "Miami", jobBlurb: undefined,
  projectBlurb: "Trimmed project", funBlurb: undefined, birthday: undefined, gender: undefined,
}, options: { sync: false } });
assert.equal(success.syncs.length, 0, "server success cannot launch a second profile write");
assert.match(text(tree), /Saved\. Your next letter uses these\./);
assert.equal(find(tree, (element) => element.props.label === "First name")?.props.value, "Saved Reader");

for (const status of [401, 409, 500]) {
  const app = component({ fetch: async () => ({ status, body: { error: "Reload the page before saving your details." } }) });
  let result = await app.settle();
  result = app.edit(result, "First name", "Changed Reader");
  result = await app.save(result);
  assert.equal(app.requests.length, 1);
  assert.equal(app.mirrors.length, 0, `HTTP ${status} never mirrors`);
  assert.equal(app.syncs.length, 0);
  assert.doesNotMatch(text(result), /Saved\. Your next letter/);
}
for (const options of [
  { rowThrows: true }, { rowError: { message: "fixture query failure" } }, { row: null },
]) {
  const app = component(options);
  let result = await app.settle();
  assert.match(text(result), /Couldn't load your saved details/);
  result = app.edit(result, "First name", "Retry Reader");
  assert.equal(find(result, (element) => element.type === "button" && text(element) === "Save details")?.props.disabled, true);
  await app.save(result);
  assert.equal(app.requests.length, 0, "failed hydrate cannot clear stored optional fields");
  assert.equal(app.mirrors.length, 0);
}
for (const options of [{ authThrows: true }, { authError: { message: "fixture auth failure" } }, { user: null }]) {
  const app = component(options);
  const result = await app.settle();
  assert.equal(find(result, (element) => element.type === "button" && text(element) === "Save details"), undefined);
  assert.equal(app.requests.length, 0);
}

const body = { expectedAccountId: ACCOUNT_A, firstName: "  Reader  ", city: "", jobBlurb: "", projectBlurb: " Saved project ", funBlurb: "", birthday: "", gender: "" };
for (const expectedAccountId of [undefined, null, "", "invalid", 4, {}, []]) {
  const api = route();
  const result = await api.post({ ...body, expectedAccountId });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /Reload the page/);
  assert.equal(api.serviceCalls, 0);
  assert.equal(api.writes.length, 0);
}
const switchedApi = route({ accountId: ACCOUNT_B });
const switched = await switchedApi.post(body);
assert.equal(switched.status, 409);
assert.equal(switchedApi.serviceCalls, 0);
assert.equal(switchedApi.writes.length, 0, "an account A form cannot write account B");
const switchedApp = component({ fetch: async (payload) => switchedApi.post(payload) });
tree = await switchedApp.settle();
tree = switchedApp.edit(tree, "First name", "Changed Reader");
tree = await switchedApp.save(tree);
assert.match(text(tree), /Your signed-in account changed/);
assert.equal(switchedApp.mirrors.length, 0);
assert.equal(switchedApi.writes.length, 0);
const api = route();
const accepted = await api.post(body);
assert.equal(accepted.status, 200);
assert.deepEqual(api.writes, [{ id: ACCOUNT_A, fields: {
  first_name: "Reader", city: null, job_blurb: null, project_blurb: "Saved project", fun_blurb: null, birthday: null, gender: null,
} }], "normal save touches only profile fields");
const signedOutApi = route({ accountId: null });
assert.equal((await signedOutApi.post(body)).status, 401);
assert.equal(signedOutApi.serviceCalls, 0);

// Reproduce each prior defect by mutating source strings in this process only.
const duplicateSource = componentSource.replace("}, { sync: false });", "});");
assert.notEqual(duplicateSource, componentSource);
const duplicate = component({ source: duplicateSource, fetch: async () => ({ status: 200, body: { profile: authoritative } }) });
tree = await duplicate.settle();
tree = duplicate.edit(tree, "First name", "Changed Reader");
await duplicate.save(tree);
assert.equal(duplicate.syncs.length, 1, "baseline mirror triggers unwanted extra write");
const failedHydrateSource = componentSource
  .replace(/(console\.warn\("\[ProfileEditor\] signed-in hydrate failed"\);)\s*setHydrateFailed\(true\);/, "$1")
  .replace(" && !!accountId;", ";");
assert.notEqual(failedHydrateSource, componentSource);
const failedHydrate = component({ source: failedHydrateSource, rowThrows: true });
tree = await failedHydrate.settle();
tree = failedHydrate.edit(tree, "First name", "Retry Reader");
await failedHydrate.save(tree);
assert.equal(failedHydrate.requests.length, 1, "baseline failed query permits saving blank optional fields");
assert.equal(failedHydrate.requests[0].city, "");
const missingHydrateSource = componentSource.replace("if (rowErr || !row) {", "if (rowErr) {");
assert.notEqual(missingHydrateSource, componentSource);
const missingHydrate = component({ source: missingHydrateSource, row: null });
tree = await missingHydrate.settle();
tree = missingHydrate.edit(tree, "First name", "Retry Reader");
await missingHydrate.save(tree);
assert.equal(missingHydrate.requests.length, 1, "baseline missing row permits clearing unseen optional fields");
assert.equal(missingHydrate.requests[0].city, "");
const ownershipStart = routeSource.indexOf("  // Bind the form to the account");
const ownershipEnd = routeSource.indexOf("  const firstName =", ownershipStart);
assert.ok(ownershipStart >= 0 && ownershipEnd > ownershipStart);
const oldRoute = route({ source: routeSource.slice(0, ownershipStart) + routeSource.slice(ownershipEnd), accountId: ACCOUNT_B });
assert.equal((await oldRoute.post(body)).status, 200);
assert.equal(oldRoute.writes[0].id, ACCOUNT_B, "baseline applies the previous account's form to current account");

console.log("PASS verify-profile-editor-mirror (real component and route, offline ownership, hydrate and mirror regressions)");
