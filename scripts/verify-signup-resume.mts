// Offline regression for the saved signup status and resume route.
// Run with the installed local runner: node_modules/.bin/tsx scripts/verify-signup-resume.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import { getSignupAccountState, incompleteSignupPath } from "../lib/signup-progress.ts";
import { isProfileComplete } from "../lib/checkout-guards.ts";
import { TOPICS } from "../lib/topics.ts";

const past = "2020-01-01T00:00:00.000Z";
const future = "2099-01-01T00:00:00.000Z";
const date = "2026-09-01T00:00:00.000Z";
const topics = TOPICS.slice(0, 5).map((topic) => topic.id);
const complete = { firstName: "Reader", topics, email: "reader@example.test", city: "Tampa", theme: "forest" };
let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assert.equal(actual, expected, label);
  checks++;
}

for (const [label, row, expected] of [
  ["no row", null, "incomplete"],
  ["empty row", {}, "incomplete"],
  ["pending request", { access_requested_at: date }, "pending"],
  ["request with paid access", { access_requested_at: date, subscribed_at: date }, "reader"],
  ["request with active invite", { access_requested_at: date, subscribed_at: date, access_granted_at: date }, "reader"],
  ["request with cancelled paid period still running", { access_requested_at: date, subscribed_at: date, cancelled_at: future }, "reader"],
  ["expired paid period", { subscribed_at: date, cancelled_at: past }, "ended"],
  ["invite grant after paid period", { subscribed_at: date, cancelled_at: past, access_granted_at: date }, "reader"],
  ["revoked invite grant", { subscribed_at: date, cancelled_at: past, access_requested_at: date, access_granted_at: null }, "pending"],
  ["grant marker without subscription", { access_granted_at: date }, "ended"],
  ["cancel marker without subscription", { cancelled_at: past }, "ended"],
  ["invalid cancellation date fails closed", { subscribed_at: date, cancelled_at: "broken" }, "ended"],
] as const) {
  equal(getSignupAccountState(row), expected, label);
}

for (const [label, profile, path] of [
  ["no answers", {}, "/name"],
  ["blank name", { ...complete, firstName: "  " }, "/name"],
  ["no topics", { ...complete, topics: undefined }, "/topics"],
  ["short topics", { ...complete, topics: topics.slice(0, 4) }, "/topics"],
  ["duplicate topics", { ...complete, topics: [...topics.slice(0, 4), topics[0]] }, "/topics"],
  ["unknown topic", { ...complete, topics: [...topics.slice(0, 4), "unknown-topic"] }, "/topics"],
  ["missing email", { ...complete, email: undefined }, "/email"],
  ["malformed email", { ...complete, email: "invalid" }, "/email"],
  ["complete profile", complete, null],
] as const) {
  const before = JSON.stringify(profile);
  equal(incompleteSignupPath(profile), path, label);
  equal(isProfileComplete(profile), path === null, `${label}: agrees with checkout gate`);
  equal(JSON.stringify(profile), before, `${label}: does not discard other answers`);
}

// Compile the real client module into a VM with only its two imports doubled.
// No environment file, provider client, browser, or network is loaded.
const root = resolve(import.meta.dirname, "..");
const requireFromRepo = createRequire(resolve(root, "package.json"));
const ts = requireFromRepo("typescript");
const source = readFileSync(resolve(root, "lib/onboarding-account.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type QueryResult = { data: Record<string, string | null> | null; error: unknown };
function accountRuntime(options: {
  configured?: boolean;
  session?: { user: { id: string } } | null;
  authError?: unknown;
  authUser?: { id: string } | null;
  userError?: unknown;
  row?: QueryResult;
} = {}) {
  const calls: string[] = [];
  const result = options.row ?? { data: null, error: null };
  const sb = {
    auth: {
      async getSession() { calls.push("getSession"); return { data: { session: options.session ?? null }, error: options.authError ?? null }; },
      async getUser() {
        calls.push("getUser");
        return { data: { user: options.authUser === undefined ? { id: options.session?.user.id } : options.authUser }, error: options.userError ?? null };
      },
    },
    from(table: string) {
      calls.push(`from:${table}`);
      return {
        select(columns: string) {
          calls.push(`select:${columns}`);
          return {
            eq(column: string, value: string) {
              calls.push(`eq:${column}:${value}`);
              return { async maybeSingle() { calls.push("maybeSingle"); return result; } };
            },
          };
        },
      };
    },
  };
  const exports: { readOnboardingAccountState?: () => Promise<string> } = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "@/lib/supabase/client") return {
        supabaseConfigured: () => options.configured ?? true,
        supabaseClient: () => { calls.push("supabaseClient"); return sb; },
      };
      if (name === "@/lib/signup-progress") return { getSignupAccountState };
      throw Error(`Unexpected import: ${name}`);
    },
  }, { filename: "lib/onboarding-account.ts" });
  return { read: exports.readOnboardingAccountState!, calls };
}

const signedOut = accountRuntime({ configured: false });
equal(await signedOut.read(), "signed-out", "unconfigured client signs out");
equal(signedOut.calls.length, 0, "unconfigured client makes no auth call");

const noSession = accountRuntime();
equal(await noSession.read(), "signed-out", "no session signs out");
equal(noSession.calls.includes("from:users"), false, "no session makes no row query");

const authFailure = accountRuntime({ authError: { message: "offline" } });
await assert.rejects(authFailure.read(), /Couldn't check your sign-in/);
checks++;
equal(authFailure.calls.includes("from:users"), false, "auth failure makes no row query");

for (const [label, row, expected] of [
  ["confirmed auth without row", null, "incomplete"],
  ["saved pending request", { access_requested_at: date }, "pending"],
  ["granted reader", { subscribed_at: date, access_granted_at: date }, "reader"],
  ["ended reader", { subscribed_at: date, cancelled_at: past }, "ended"],
] as const) {
  const runtime = accountRuntime({ session: { user: { id: "signed-in-user-id" } }, row: { data: row, error: null } });
  equal(await runtime.read(), expected, label);
  assert.deepEqual(runtime.calls, [
    "supabaseClient", "getSession", "from:users",
    "select:subscribed_at, cancelled_at, access_requested_at, access_granted_at",
    "eq:id:signed-in-user-id", "maybeSingle",
    ...(row === null ? ["getUser"] : []),
  ], `${label}: reads only the signed-in account`);
  checks++;
}

const rowFailure = accountRuntime({ session: { user: { id: "signed-in-user-id" } }, row: { data: null, error: { message: "offline" } } });
await assert.rejects(rowFailure.read(), /Couldn't check your signup/);
checks++;

for (const [label, overrides] of [
  ["deleted auth user", { authUser: null }],
  ["different auth user", { authUser: { id: "someone-else" } }],
  ["auth lookup failure", { userError: { message: "offline" } }],
] as const) {
  const runtime = accountRuntime({ session: { user: { id: "signed-in-user-id" } }, row: { data: null, error: null }, ...overrides });
  await assert.rejects(runtime.read(), /Couldn't verify your account/, label);
  checks++;
  equal(runtime.calls.includes("getUser"), true, `${label}: authoritative auth check`);
}

// Exercise the real page functions with deterministic React hooks and JSX objects.
// Effects and Supabase results settle between renders, like a browser reload.
type Element = { type: unknown; props: Record<string, any> };
function pageRuntime(file: string, imports: Record<string, unknown>) {
  const pageSource = readFileSync(resolve(root, file), "utf8");
  const pageCode = ts.transpileModule(pageSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const values: any[] = [];
  const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
  const callbacks = new Map<number, { deps?: unknown[]; fn: any }>();
  let index = 0;
  let pending: (() => void)[] = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (value: unknown) => { values[slot] = typeof value === "function" ? (value as (old: unknown) => unknown)(values[slot]) : value; }];
    },
    useRef(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = { current: initial };
      return values[slot];
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const slot = index++;
      const previous = callbacks.get(slot);
      if (previous && same(previous.deps, deps)) return previous.fn;
      callbacks.set(slot, { fn, deps });
      return fn;
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const slot = index++;
      const previous = effects.get(slot);
      if (!previous || !same(previous.deps, deps)) {
        pending.push(() => {
          previous?.cleanup?.();
          const cleanup = effect();
          effects.set(slot, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
        });
      }
    },
  };
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
  const exports: { default?: () => Element } = {};
  vm.runInNewContext(pageCode, {
    exports,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name in imports) return imports[name];
      throw Error(`${file}: Unexpected import ${name}`);
    },
    window: { location: { assign() { throw Error("Unexpected navigation"); } } },
    localStorage: { getItem() { throw Error("Signed-in flow must not read a local letter"); } },
    document: { documentElement: { setAttribute() {} } },
    setTimeout,
    console,
    process: { env: { NODE_ENV: "test" } },
  }, { filename: file });
  function render() {
    index = 0;
    pending = [];
    const tree = exports.default!();
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
  return { settle, render };
}
function treeText(value: unknown): string {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(treeText).join(" ");
  if (typeof value === "object") return treeText((value as Element).props?.children);
  return String(value);
}
function findElement(value: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.map((item) => findElement(item, predicate)).find(Boolean);
  const element = value as Element;
  if (predicate(element)) return element;
  return findElement(element.props?.children, predicate);
}
const dummy = () => null;
function checkoutRuntime(accountRead: () => Promise<string>, profile: Record<string, unknown>) {
  const routes: string[] = [];
  const router = { replace: (path: string) => routes.push(path), push: (path: string) => routes.push(path) };
  const app = pageRuntime("app/checkout/page.tsx", {
    "next/navigation": { useRouter: () => router },
    "@/components/onboarding/StepShell": { StepShell: dummy },
    "@/lib/onboarding-state": { useOnboarding: () => ({ state: profile, loaded: true, update: dummy }) },
    "@/lib/topics": { topicLabel: dummy, topicEmoji: dummy },
    "@/lib/themes": { THEMES: [], SWATCHES: { forest: { paper: "", ink: "", accent: "" } }, coerceThemeId: () => "forest" },
    "@/lib/analytics": { track: dummy },
    "@/lib/checkout-guards": { isProfileComplete },
    "@/lib/access-mode": { isInviteOnly: () => true },
    "@/lib/onboarding-account": { readOnboardingAccountState: accountRead },
    "@/lib/signup-progress": { incompleteSignupPath },
  });
  return { ...app, routes };
}

const pendingCheckout = checkoutRuntime(async () => "pending", {});
let checkoutTree = await pendingCheckout.settle();
assert.match(treeText(checkoutTree), /Your request is saved/);
checks++;
equal(pendingCheckout.routes.length, 0, "pending checkout with no draft does not redirect");
equal(treeText(checkoutTree).includes("Request access →"), false, "pending checkout does not offer duplicate request");

const expiredEmailCheckout = checkoutRuntime(async () => "incomplete", { ...complete, email: undefined });
await expiredEmailCheckout.settle();
equal(expiredEmailCheckout.routes.includes("/email"), true, "expired email resumes at email");

const approvedCheckout = checkoutRuntime(async () => "reader", {});
await approvedCheckout.settle();
equal(approvedCheckout.routes.includes("/inbox"), true, "approved reader goes to inbox even without draft");
equal(approvedCheckout.routes.includes("/name"), false, "approved reader never gets incomplete redirect");

let accountAttempts = 0;
const failedCheckout = checkoutRuntime(async () => {
  accountAttempts++;
  if (accountAttempts === 1) throw Error("test-only outage");
  return "pending";
}, {});
checkoutTree = await failedCheckout.settle();
assert.match(treeText(checkoutTree), /saved answers haven't been cleared/);
checks++;
const retry = findElement(checkoutTree, (el) => el.type === "button" && treeText(el) === "Try again");
assert.ok(retry, "account read failure offers retry");
checks++;
retry.props.onClick();
checkoutTree = await failedCheckout.settle();
assert.match(treeText(checkoutTree), /Your request is saved/);
checks++;
equal(accountAttempts, 2, "retry reruns saved account read");

function inboxRuntime(row: Record<string, string | null> | null, authUser: { id: string } | null = { id: "signed-in-user-id" }, userError: unknown = null) {
  const calls: string[] = [];
  const session = { user: { id: "signed-in-user-id" } };
  const query = (table: string) => ({
    select() { return this; }, lte() { return this; }, order() { return this; }, limit() { return this; },
    eq(column: string, value: string) { calls.push(`eq:${column}:${value}`); return this; },
    async maybeSingle() { calls.push(`read:${table}`); return { data: table === "users" ? row : null, error: null }; },
  });
  const sb = { auth: {
    async getSession() { return { data: { session }, error: null }; },
    async getUser() { calls.push("getUser"); return { data: { user: authUser }, error: userError }; },
  }, from: (table: string) => query(table) };
  const app = pageRuntime("app/inbox/page.tsx", {
    "next/link": { default: "Link" },
    "next/navigation": { useRouter: () => ({ push: dummy }) },
    "@/components/Digest": { Digest: dummy },
    "@/components/Wordmark": { Wordmark: dummy },
    "@/lib/themes": { coerceThemeId: () => "forest" },
    "@/components/ThemeSwitcher": { ThemeSwitcher: dummy },
    "@/components/AudioToggle": { AudioToggle: dummy },
    "@/components/ReadingProgress": { ReadingProgress: dummy },
    "@/components/InstallPrompt": { InstallPrompt: dummy },
    "@/components/FirstLetterCelebration": { FirstLetterCelebration: dummy },
    "@/components/LetterTOC": { LetterTOC: dummy },
    "@/components/ShareButton": { ShareButton: dummy },
    "@/lib/supabase/client": { supabaseConfigured: () => true, supabaseClient: () => sb },
    "@/lib/signup-progress": { getSignupAccountState },
    "@/lib/onboarding-state": { useOnboarding: () => ({ state: {}, loaded: true, reset: () => true }) },
    "@/lib/cadence": { currentPeriodIso: () => date, nextSendIso: () => future, SEND_HOUR_UTC: 14 },
    "@/lib/audio": { fanfare: dummy },
    "@/lib/copy": { SHARE_LEAD: "" },
  });
  return { ...app, calls };
}
for (const [label, row, expected] of [
  ["saved pending inbox", { access_requested_at: date }, /Your request is saved/],
  ["confirmed account without profile row", null, /Finish your signup/],
] as const) {
  const app = inboxRuntime(row);
  const tree = await app.settle();
  assert.match(treeText(tree), expected, label);
  checks++;
  equal(treeText(tree).includes("Your Alpha access has ended"), false, `${label}: no ended message`);
  equal(app.calls.includes("eq:id:signed-in-user-id"), true, `${label}: looks up signed-in user`);
  if (row === null) {
    const continueLink = findElement(tree, (el) => el.type === "Link" && treeText(el).includes("Continue signup"));
    equal(continueLink?.props.href, "/name", "auth-only inbox offers continue signup");
  }
}
for (const [label, authUser, userError, expected] of [
  ["deleted user", null, null, /Your Alpha access has ended/],
  ["mismatched user", { id: "someone-else" }, null, /Your Alpha access has ended/],
  ["auth check failure", { id: "signed-in-user-id" }, { message: "offline" }, /Couldn.t load your letters/],
] as const) {
  const app = inboxRuntime(null, authUser, userError);
  const tree = await app.settle();
  assert.match(treeText(tree), expected, label);
  checks++;
  equal(app.calls.includes("getUser"), true, `${label}: authoritative auth check`);
  equal(treeText(tree).includes("Finish your signup"), false, `${label}: no incomplete signup offer`);
}

console.log(`Signup resume offline: ${checks} assertions passed.`);
