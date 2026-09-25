// Offline regression for the saved signup status and resume route.
// Run with the installed local runner: node_modules/.bin/tsx scripts/verify-signup-resume.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import { getSignupAccountState, incompleteSignupPath, signInDestination } from "../lib/signup-progress.ts";
import { isProfileComplete } from "../lib/checkout-guards.ts";
import { TOPICS, isValidTopicId } from "../lib/topics.ts";
import { authOwnsAccessRequestEmail } from "../lib/access-request-ownership.ts";
import { hasUsableReaderProfile } from "../lib/reader-profile-state.ts";
import { issueIsReaderVisible } from "../lib/issue-visibility.ts";
import { latestVisibleIssue } from "../lib/latest-visible-issue.ts";

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

// Signing in with a new or unfinished account goes into setup, not an empty inbox.
for (const [label, state, draft, expected] of [
  ["brand-new email, nothing saved", "incomplete", {}, "/welcome"],
  ["new email with a blank-name draft", "incomplete", { firstName: "  ", topics: [] }, "/welcome"],
  ["unfinished account with saved name resumes", "incomplete", { firstName: "Reader" }, "/checkout"],
  ["unfinished account with saved topics resumes", "incomplete", { topics: ["mental-health"] }, "/checkout"],
  ["waiting for approval", "pending", {}, "/inbox"],
  ["approved reader", "reader", { firstName: "Reader" }, "/inbox"],
  ["ended access", "ended", {}, "/inbox"],
  ["no session", "signed-out", {}, "/inbox"],
] as const) {
  equal(signInDestination(state, draft), expected, `sign-in destination: ${label}`);
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
// A successful server topic save must only mirror the browser draft. A second
// fire-and-forget profile write could arrive after the next validated save.
const topicsPage = readFileSync(resolve(root, "app/topics/page.tsx"), "utf8");
assert.match(topicsPage, /update\(\{ topics: picked \}, \{ sync: false \}\)/);
checks++;
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
      if (name === "@/lib/reader-profile-state") return { hasUsableReaderProfile };
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
  ["granted reader", { first_name: "Reader", topics: ["mental-health"], subscribed_at: date, access_granted_at: date }, "reader"],
  // Approved before the profile was saved: the normal signup steps stay open.
  ["granted before profile saved", { first_name: null, topics: [], subscribed_at: date, access_granted_at: date }, "incomplete"],
  ["legacy reader without an owner grant", { subscribed_at: date }, "reader"],
  ["ended reader", { subscribed_at: date, cancelled_at: past }, "ended"],
] as const) {
  const runtime = accountRuntime({ session: { user: { id: "signed-in-user-id" } }, row: { data: row, error: null } });
  equal(await runtime.read(), expected, label);
  assert.deepEqual(runtime.calls, [
    "supabaseClient", "getSession", "from:users",
    "select:first_name, topics, birthday, subscribed_at, cancelled_at, access_requested_at, access_granted_at",
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
function pageRuntime(file: string, imports: Record<string, unknown>, allowEmptyStorage = false, navigationPaths?: string[], globals: Record<string, unknown> = {}) {
  const pageSource = readFileSync(resolve(root, file), "utf8");
  const pageCode = ts.transpileModule(pageSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const values: any[] = [];
  const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
  const callbacks = new Map<number, { deps?: unknown[]; fn: any }>();
  let index = 0;
  let pending: (() => void)[] = [];
  let stateWrites = 0;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (value: unknown) => { stateWrites++; values[slot] = typeof value === "function" ? (value as (old: unknown) => unknown)(values[slot]) : value; }];
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
    useMemo(factory: () => unknown, deps?: unknown[]) {
      const slot = index++;
      const previous = callbacks.get(slot);
      if (previous && same(previous.deps, deps)) return previous.fn;
      const value = factory();
      callbacks.set(slot, { fn: value, deps });
      return value;
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
    window: { location: { assign(path: string) { if (navigationPaths) navigationPaths.push(path); else throw Error("Unexpected navigation"); } } },
    localStorage: { getItem() { if (allowEmptyStorage) return null; throw Error("Signed-in flow must not read a local letter"); } },
    document: { documentElement: { setAttribute() {} } },
    setTimeout,
    console,
    process: { env: { NODE_ENV: "test" } },
    ...globals,
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
  function unmount() {
    for (const effect of effects.values()) effect.cleanup?.();
    effects.clear();
  }
  return { settle, render, unmount, get stateWrites() { return stateWrites; } };
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
function checkoutRuntime(accountRead: () => Promise<string>, profile: Record<string, unknown>, savedProfile: Record<string, unknown> = {
  first_name: "Reader", topics, access_granted_at: date,
}, emailDraft = profile.email, overrides: { imports?: Record<string, unknown>; globals?: Record<string, unknown> } = {}) {
  const routes: string[] = [];
  const router = { replace: (path: string) => routes.push(path), push: (path: string) => routes.push(path) };
  // Mirrors lib/onboarding-account.ts: an owner grant without a saved profile
  // reads as "incomplete" so the normal signup steps stay open.
  const readOnboardingAccount = async () => {
    const state = await accountRead();
    const approvedIncomplete = state === "reader" && !!savedProfile.access_granted_at && !hasUsableReaderProfile(savedProfile);
    return { state: approvedIncomplete ? "incomplete" : state, approvedIncomplete, email: complete.email };
  };
  const app = pageRuntime("app/checkout/page.tsx", {
    "next/navigation": { useRouter: () => router },
    "@/components/onboarding/StepShell": { StepShell: dummy },
    "@/lib/onboarding-state": { useOnboarding: () => ({ state: profile, emailDraft, loaded: true, update: dummy }) },
    "@/lib/topics": { topicLabel: dummy, topicEmoji: dummy, isValidTopicId },
    "@/lib/themes": { THEMES: [], SWATCHES: { forest: { paper: "", ink: "", accent: "" } }, coerceThemeId: () => "forest" },
    "@/lib/analytics": { track: dummy },
    "@/lib/checkout-guards": { isProfileComplete },
    "@/lib/access-mode": { isInviteOnly: () => true },
    "@/lib/onboarding-account": { readOnboardingAccount },
    "@/lib/signup-progress": { incompleteSignupPath },
    "@/lib/access-request-ownership": { authOwnsAccessRequestEmail },
    "@/lib/supabase/client": { supabaseConfigured: () => true, supabaseClient: () => { throw Error("unexpected sign-in call"); } },
    "@/lib/gotrue-errors": { isAuthRateLimitError: () => false, isInvalidOrExpiredOtpError: () => false },
    ...overrides.imports,
  }, false, undefined, overrides.globals);
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
const unfinishedApprovedCheckout = checkoutRuntime(async () => "reader", complete, { first_name: "", topics: [], access_granted_at: date });
checkoutTree = await unfinishedApprovedCheckout.settle();
assert.match(treeText(checkoutTree), /Finish signup/);
checks++;
equal(unfinishedApprovedCheckout.routes.length, 0, "approved empty account keeps matching complete draft for explicit save");
// With no draft on this device, the approved reader answers the normal steps.
// /name is reachable because the account reads as "incomplete", not "reader".
const approvedWithoutDraft = checkoutRuntime(async () => "reader", {}, { first_name: "", topics: [], access_granted_at: date });
await approvedWithoutDraft.settle();
equal(approvedWithoutDraft.routes.includes("/name"), true, "approved empty account without draft resumes at the first step");
// A draft email older than 24 hours still identifies this signed-in account.
const approvedStaleEmail = checkoutRuntime(async () => "reader", { ...complete, email: undefined },
  { first_name: "", topics: [], access_granted_at: date }, complete.email);
checkoutTree = await approvedStaleEmail.settle();
assert.match(treeText(checkoutTree), /Finish signup/);
checks++;
equal(approvedStaleEmail.routes.length, 0, "approved reader with a stale draft email is not sent back to /email");
// A draft that belongs to a different address is never applied to this account.
const approvedOtherDraft = checkoutRuntime(async () => "reader", { ...complete, email: "someone-else@example.test" },
  { first_name: "", topics: [], access_granted_at: date });
checkoutTree = await approvedOtherDraft.settle();
assert.match(treeText(checkoutTree), /Finish in settings/);
checks++;

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

// Request access confirms the email right on this page: the code is sent at
// once, entering it sends the request, and there's no detour to /signin.
{
  const authCalls: string[] = [];
  let signedIn = false;
  let requests = 0;
  const auth = {
    async signInWithOtp({ email }: { email: string }) { authCalls.push(`send:${email}`); return { error: null }; },
    async verifyOtp({ email, token }: { email: string; token: string }) {
      authCalls.push(`verify:${email}:${token}`);
      signedIn = token === "123456";
      return { error: signedIn ? null : { status: 403, code: "otp_expired", message: "expired" } };
    },
  };
  const fetchStub = async () => {
    requests++;
    return signedIn
      ? { status: 200, ok: true, json: async () => ({ ok: true }) }
      : { status: 401, ok: false, json: async () => ({ error: "identity_verification_required" }) };
  };
  const run = checkoutRuntime(async () => "incomplete", complete, undefined, complete.email, {
    imports: {
      "@/lib/supabase/client": { supabaseConfigured: () => true, supabaseClient: () => ({ auth }) },
      "@/lib/gotrue-errors": {
        isAuthRateLimitError: () => false,
        isInvalidOrExpiredOtpError: (e: { code?: string }) => e?.code === "otp_expired",
      },
    },
    globals: { fetch: fetchStub },
  });
  let tree = await run.settle();
  const request = findElement(tree, (el) => el.type === "button" && treeText(el).includes("Request access"));
  assert.ok(request, "request button renders");
  await request.props.onClick();
  tree = await run.settle();
  equal(authCalls[0], `send:${complete.email}`, "Request access emails the code right away");
  assert.match(treeText(tree), new RegExp(`We emailed a 6-digit code to ${complete.email.replace(".", "\\.")}`));
  checks++;
  equal(run.routes.includes("/signin"), false, "no detour to the sign-in page");
  const typeCode = async (value: string) => {
    const input = findElement(tree, (el) => el.type === "input" && el.props.autoComplete === "one-time-code");
    assert.ok(input, "code box renders on the request page");
    input.props.onChange({ target: { value } });
    tree = await run.settle();
    await findElement(tree, (el) => el.type === "form")!.props.onSubmit({ preventDefault() {} });
    tree = await run.settle();
  };
  await typeCode("111111");
  assert.match(treeText(tree), /That code didn't work/);
  checks++;
  equal(requests, 1, "a wrong code does not send the request");
  await typeCode("123456");
  assert.match(treeText(tree), /Your request is saved/);
  checks++;
  equal(requests, 2, "the right code sends the request without another click");
  equal(authCalls.filter((c) => c.startsWith("send:")).length, 1, "only one code email for the whole flow");
}

type InboxRow = Record<string, string | null> | null;
type InboxQueryResult = { data: InboxRow; error: unknown };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function inboxRuntime(row: InboxRow, authUser: { id: string } | null = { id: "signed-in-user-id" }, userError: unknown = null, options: {
  sessions?: boolean[];
  rows?: Array<InboxQueryResult | Promise<InboxQueryResult>>;
  allowEmptyStorage?: boolean;
  signOutErrors?: unknown[];
  resetResult?: boolean;
} = {}) {
  const calls: string[] = [];
  const routes: string[] = [];
  const session = { user: { id: "signed-in-user-id" } };
  let sessionRead = 0;
  let rowRead = 0;
  let signOutRead = 0;
  const query = (table: string) => ({
    select() { return this; }, lte() { return this; }, order() { return this; }, limit() { return this; },
    async range() { calls.push(`read:${table}`); return { data: [], error: null }; },
    eq(column: string, value: string) { calls.push(`eq:${column}:${value}`); return this; },
    async maybeSingle() {
      calls.push(`read:${table}`);
      if (table === "users") return options.rows?.[rowRead++] ?? { data: row, error: null };
      return { data: null, error: null };
    },
  });
  const sb = { auth: {
    async getSession() {
      const signedIn = options.sessions?.[sessionRead++] ?? true;
      return { data: { session: signedIn ? session : null }, error: null };
    },
    async getUser() { calls.push("getUser"); return { data: { user: authUser }, error: userError }; },
    async signOut() { calls.push("signOut"); return { error: options.signOutErrors?.[signOutRead++] ?? null }; },
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
    "@/lib/topics": { isValidTopicId },
    "@/lib/reader-profile-state": { hasUsableReaderProfile },
    "@/lib/issue-visibility": { issueIsReaderVisible },
    "@/lib/latest-visible-issue": { latestVisibleIssue },
    "@/lib/onboarding-state": { useOnboarding: () => ({ state: {}, loaded: true, reset: () => { calls.push("reset"); return options.resetResult ?? true; } }) },
    "@/lib/cadence": { currentPeriodIso: () => date, nextSendIso: () => future, SEND_HOUR_UTC: 14 },
    "@/lib/audio": { fanfare: dummy },
    "@/lib/copy": { SHARE_LEAD: "" },
  }, options.allowEmptyStorage, routes);
  return { ...app, calls, routes, get stateWrites() { return app.stateWrites; } };
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

const pendingRow = { data: { access_requested_at: date }, error: null };
const approvedRow = { data: { subscribed_at: date, access_granted_at: date }, error: null };
const signedOutRetry = inboxRuntime(null, undefined, null, {
  sessions: [true, false],
  rows: [pendingRow],
  allowEmptyStorage: true,
});
let inboxTree = await signedOutRetry.settle();
const statusButton = findElement(inboxTree, (el) => el.type === "button" && treeText(el) === "Check approval status");
assert.ok(statusButton, "pending inbox offers approval retry");
checks++;
statusButton.props.onClick();
inboxTree = await signedOutRetry.settle();
assert.match(treeText(inboxTree), /Sign in to see my letters/, "lost session offers sign-in after retry");
checks++;
equal(treeText(inboxTree).includes("You're signed in"), false, "lost session clears signed-in state");
equal(treeText(inboxTree).includes("Your request is saved"), false, "lost session clears pending state");

const olderPending = deferred<InboxQueryResult>();
const approvalRace = inboxRuntime(null, undefined, null, {
  rows: [pendingRow, olderPending.promise, approvedRow],
});
inboxTree = await approvalRace.settle();
const raceButton = findElement(inboxTree, (el) => el.type === "button" && treeText(el) === "Check approval status");
assert.ok(raceButton, "pending status is available before overlapping checks");
checks++;
raceButton.props.onClick();
await new Promise<void>((done) => setImmediate(done));
raceButton.props.onClick();
inboxTree = await approvalRace.settle();
equal(treeText(inboxTree).includes("Your request is saved"), false, "newer approval clears pending status");
olderPending.resolve(pendingRow);
inboxTree = await approvalRace.settle();
equal(treeText(inboxTree).includes("Your request is saved"), false, "older pending reply cannot replace approval");

const afterUnmount = deferred<InboxQueryResult>();
const unmountedInbox = inboxRuntime(null, undefined, null, {
  rows: [pendingRow, afterUnmount.promise],
});
inboxTree = await unmountedInbox.settle();
const unmountButton = findElement(inboxTree, (el) => el.type === "button" && treeText(el) === "Check approval status");
assert.ok(unmountButton, "pending status is available before unmount");
checks++;
unmountButton.props.onClick();
await new Promise<void>((done) => setImmediate(done));
unmountedInbox.unmount();
const writesAtUnmount = unmountedInbox.stateWrites;
assert.ok(writesAtUnmount > 0, "state-write counter stays live through the inbox wrapper");
checks++;
afterUnmount.resolve(approvedRow);
await new Promise<void>((done) => setImmediate(done));
equal(unmountedInbox.stateWrites, writesAtUnmount, "late inbox reply makes no state writes after unmount");

const signOutRetry = inboxRuntime({ access_requested_at: date }, undefined, null, {
  signOutErrors: [{ message: "offline" }, null],
});
inboxTree = await signOutRetry.settle();
const signOutButton = findElement(inboxTree, (el) => el.type === "button" && treeText(el) === "Sign out and clear this device");
assert.ok(signOutButton, "pending inbox has explicit device sign-out");
checks++;
signOutButton.props.onClick();
inboxTree = await signOutRetry.settle();
assert.match(treeText(inboxTree), /Couldn't sign you out/, "sign-out error is shown");
checks++;
equal(signOutRetry.routes.length, 0, "failed sign-out does not navigate");
equal(signOutRetry.calls.includes("reset"), false, "failed sign-out does not clear saved answers");
const signOutAgain = findElement(inboxTree, (el) => el.type === "button" && treeText(el) === "Try again");
assert.ok(signOutAgain, "failed sign-out offers retry");
checks++;
signOutAgain.props.onClick();
await signOutRetry.settle();
equal(signOutRetry.calls.filter((call) => call === "signOut").length, 2, "sign-out retry calls provider again");
equal(signOutRetry.calls.filter((call) => call === "reset").length, 1, "successful sign-out clears saved answers once");
equal(signOutRetry.routes[0], "/welcome", "successful sign-out leaves inbox");

console.log(`Signup resume offline: ${checks} assertions passed.`);
