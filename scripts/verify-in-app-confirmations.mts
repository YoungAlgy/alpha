// Offline regression for the actual admin action handler and shared dialog contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const adminSource = readFileSync(new URL("../app/settings/accounts/page.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("../components/ConfirmDialog.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("page.tsx", adminSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let actNode: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "act") actNode = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(actNode, "admin act() must exist");
const actJs = ts.transpileModule(actNode.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

let assertions = 0;
function check(test: () => void) { test(); assertions++; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function scenario(action: string, answer: boolean, unmount = false) {
  const question = deferred<boolean>();
  const busyRowsRef = { current: new Set<string>() };
  const mountedRef = { current: true };
  const writes: Array<{ action: string; userId: string; expectedEmail?: string }> = [];
  let reloads = 0;
  let prompts = 0;
  const context = vm.createContext({
    loading: false, busyRowsRef, mountedRef,
    ACTION_LABELS: { enable_delivery: "Enable letters", delete: "Delete account" },
    ACTION_VERBS: { enable_delivery: "Enabled letters for", delete: "Deleted" },
    confirm: () => { prompts++; return question.promise; },
    setBusyRows: () => undefined,
    setActionMsg: () => undefined,
    setRowErrors: () => undefined,
    setActionCount: () => undefined,
    activeSearch: "", pendingOnly: true,
    load: async () => { reloads++; return []; },
    fetch: async (_url: string, options: { body: string }) => {
      writes.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });
  vm.runInContext(`${actJs}\nthis.act = act;`, context, { timeout: 1000 });
  const act = (context as { act: (id: string, email: string, action: string, message?: string) => Promise<void> }).act;
  const first = act("user-1", "owner@example.test", action, "Please confirm");
  const second = act("user-1", "owner@example.test", action, "Please confirm");
  check(() => assert.equal(prompts, 1, "same-row double click must ask once"));
  if (unmount) mountedRef.current = false;
  question.resolve(answer);
  await Promise.all([first, second]);
  return { writes, reloads, busyRowsRef };
}

for (const action of ["enable_delivery", "delete"]) {
  const canceled = await scenario(action, false);
  check(() => assert.equal(canceled.writes.length, 0, `${action} cancel must not write`));
  check(() => assert.equal(canceled.reloads, 0, `${action} cancel must not reload`));
  check(() => assert.equal(canceled.busyRowsRef.current.size, 0, `${action} cancel must release latch`));
  const approved = await scenario(action, true);
  check(() => assert.equal(approved.writes.length, 1, `${action} confirm must write once`));
  check(() => assert.equal(approved.reloads, 1, `${action} confirm must reload once`));
  check(() => assert.equal(approved.writes[0].action, action));
  check(() => assert.equal(approved.writes[0].userId, "user-1"));
  if (action === "enable_delivery") {
    check(() => assert.equal(approved.writes[0].expectedEmail, "owner@example.test"));
  }
  const leftPage = await scenario(action, true, true);
  check(() => assert.equal(leftPage.writes.length, 0, `${action} unmount before answer must not write`));
  check(() => assert.equal(leftPage.reloads, 0, `${action} unmount before answer must not reload`));
}

check(() => assert.match(dialogSource, /if \(!mounted\.current \|\| pending\.current\) return Promise\.resolve\(false\)/));
check(() => assert.match(dialogSource, /pending\.current = null;\s*current\?\.resolve\(false\)/));
check(() => assert.match(dialogSource, /if \(pending\.current !== current\) return/));
check(() => assert.match(dialogSource, /dialog\.showModal\(\)/));
check(() => assert.match(dialogSource, /aria-labelledby=/));
check(() => assert.match(dialogSource, /aria-describedby=/));
check(() => assert.match(dialogSource, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); onAnswer\(false\); \}\}/));
for (const [filename, text] of [["accounts", adminSource], ["settings", settingsSource]]) {
  const parsed = ts.createSourceFile(`${filename}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const forbidden: string[] = [];
  function inspect(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText(parsed) === "window" &&
          (callee.name.text === "alert" || callee.name.text === "confirm")) forbidden.push(callee.getText(parsed));
      if (ts.isIdentifier(callee) && callee.text === "alert") forbidden.push("alert");
      if (ts.isIdentifier(callee) && callee.text === "confirm" && !node.arguments.every(ts.isObjectLiteralExpression)) {
        forbidden.push("bare confirm with non-dialog arguments");
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(parsed);
  check(() => assert.deepEqual(forbidden, [], `${filename} must have no native alerts or confirmations`));
}

const settingsAst = ts.createSourceFile("settings.tsx", settingsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function clickHandler(needle: string): string {
  let expression: ts.Expression | undefined;
  function find(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.text === "onClick" && node.initializer &&
        ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(settingsAst).includes(needle)) {
      expression = node.initializer.expression;
    }
    ts.forEachChild(node, find);
  }
  find(settingsAst);
  assert.ok(expression, `settings onClick containing ${needle} must exist`);
  return ts.transpileModule(`this.handler = ${expression.getText(settingsAst)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const selfDeleteJs = clickHandler("deleteUserAccount()");
type DeleteResult = { ok: boolean; error?: string };
type SelfDeleteCase = "cancel" | "reject" | "throw" | "success" | "storage_blocked" | "reset_blocked";
async function selfDeleteScenario(kind: SelfDeleteCase) {
  const answer = deferred<boolean>();
  const deletion = deferred<DeleteResult>();
  const deleteInFlight = { current: false };
  const errors: string[] = [];
  const removals: string[] = [];
  const navigation: string[] = [];
  let questions = 0;
  let deletes = 0;
  let resets = 0;
  const context = vm.createContext({
    deleteInFlight,
    hasPaidSub: true,
    setConfirmingDeletion: () => undefined,
    setDeleteError: (value: string | null) => { if (value) errors.push(value); },
    setDeleting: () => undefined,
    confirm: () => { questions++; return answer.promise; },
    deleteUserAccount: () => { deletes++; return deletion.promise; },
    reset: () => { resets++; return kind !== "reset_blocked"; },
    localStorage: { removeItem: (key: string) => {
      removals.push(key);
      if (kind === "storage_blocked" && key === "alpha-theme") throw new Error("storage blocked");
    } },
    window: { location: { set href(value: string) { navigation.push(value); } } },
    console: { warn: () => undefined },
  });
  vm.runInContext(selfDeleteJs, context, { timeout: 1000 });
  const handler = (context as { handler: () => Promise<void> }).handler;
  const first = handler();
  const second = handler();
  check(() => assert.equal(questions, 1, `${kind}: repeat click must not reopen question`));
  answer.resolve(kind !== "cancel");
  if (kind !== "cancel") {
    await Promise.resolve();
    if (kind === "throw") deletion.resolve(Promise.reject(new Error("request failed")) as unknown as DeleteResult);
    else deletion.resolve(kind === "reject" ? { ok: false, error: "server refused" } : { ok: true });
  }
  await Promise.all([first, second]);
  return { deleteInFlight, errors, removals, navigation, questions, deletes, resets };
}

for (const kind of ["cancel", "reject", "throw", "success", "storage_blocked", "reset_blocked"] as const) {
  const result = await selfDeleteScenario(kind);
  check(() => assert.equal(result.deleteInFlight.current, false, `${kind}: latch must release`));
  check(() => assert.equal(result.deletes, kind === "cancel" ? 0 : 1, `${kind}: delete request count`));
  check(() => assert.equal(result.resets, ["success", "storage_blocked", "reset_blocked"].includes(kind) ? 1 : 0,
    `${kind}: local onboarding reset count`));
  check(() => assert.equal(result.navigation.length, kind === "success" ? 1 : 0, `${kind}: navigation count`));
  if (["cancel", "reject", "throw"].includes(kind)) {
    check(() => assert.deepEqual(result.removals, [], `${kind}: local data must be preserved`));
  }
  if (kind === "success") {
    check(() => assert.deepEqual(result.removals, ["alpha-first-issue", "alpha-theme"]));
    check(() => assert.equal(result.navigation[0], "/welcome"));
  }
  if (["reject", "throw", "storage_blocked", "reset_blocked"].includes(kind)) {
    check(() => assert.ok(result.errors.length > 0, `${kind}: failure must be visible`));
  }
}

const exportJs = clickHandler("URL.createObjectURL");
async function exportScenario(serverOk: boolean) {
  const exportInFlight = { current: false };
  const server = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
  const warnings: string[] = [];
  const blobs: Array<{ contents: unknown[]; options: unknown }> = [];
  const anchors: Array<{ href?: string; download?: string; clicked?: boolean }> = [];
  const revoked: string[] = [];
  let requests = 0;
  const context = vm.createContext({
    exportInFlight,
    state: { source: "device" },
    setExporting: () => undefined,
    setExportWarning: (message: string | null) => { if (message) warnings.push(message); },
    supabaseConfigured: () => true,
    supabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: {} }, error: null }) } }),
    fetch: () => { requests++; return server.promise; },
    Blob: class { constructor(contents: unknown[], options: unknown) { blobs.push({ contents, options }); } },
    URL: { createObjectURL: () => "blob:offline", revokeObjectURL: (value: string) => { revoked.push(value); } },
    document: { createElement: () => {
      const anchor: { href?: string; download?: string; clicked?: boolean; click: () => void } = {
        click() { this.clicked = true; },
      };
      anchors.push(anchor);
      return anchor;
    } },
    window: { setTimeout: (callback: () => void) => { callback(); } },
    console: { warn: () => undefined },
  });
  vm.runInContext(exportJs, context, { timeout: 1000 });
  const handler = (context as { handler: () => Promise<void> }).handler;
  const first = handler();
  const second = handler();
  check(() => assert.equal(requests, 0, "export waits for session before request"));
  await Promise.resolve();
  await Promise.resolve();
  server.resolve({ ok: serverOk, json: async () => ({ source: "server" }) });
  await Promise.all([first, second]);
  return { exportInFlight, warnings, blobs, anchors, revoked, requests };
}

for (const serverOk of [true, false]) {
  const result = await exportScenario(serverOk);
  const label = serverOk ? "export success" : "export fallback";
  check(() => assert.equal(result.requests, 1, `${label}: repeat click must fetch once`));
  check(() => assert.equal(result.exportInFlight.current, false, `${label}: latch must release`));
  check(() => assert.equal(result.blobs.length, 1, `${label}: must prepare one file`));
  check(() => assert.equal(result.anchors[0].download, "alpha-export.json"));
  check(() => assert.equal(result.anchors[0].clicked, true));
  check(() => assert.deepEqual(result.revoked, ["blob:offline"]));
  const exported = JSON.parse(String(result.blobs[0].contents[0])) as { source: string };
  check(() => assert.equal(exported.source, serverOk ? "server" : "device"));
  check(() => assert.equal(result.warnings.length, serverOk ? 0 : 1,
    `${label}: local-only file must carry an in-page warning`));
}

console.log(`In-app confirmations: ${assertions} offline checks passed.`);
