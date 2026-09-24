// Offline checks against the real onboarding hook. These are test-only browser
// and React doubles; this script never loads environment files or calls a provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");
const requireFromRepo = createRequire(resolve(root, "package.json"));
const ts = requireFromRepo("typescript");
const source = readFileSync(resolve(root, "lib/onboarding-state.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function storage() {
  const data = new Map<string, string>();
  const faults = { read: false, write: false, remove: false };
  return {
    data, faults,
    getItem(key: string) {
      if (faults.read) throw Error("test-only read failure");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (faults.write) throw Error("test-only write failure");
      data.set(key, value);
    },
    removeItem(key: string) {
      if (faults.remove) throw Error("test-only remove failure");
      data.delete(key);
    },
  };
}

function runtime(local = storage(), session = storage()) {
  let active: any;
  const syncCalls: any[] = [];
  const react = {
    useState(initial: unknown) {
      const index = active.index++;
      if (!(index in active.values)) active.values[index] = initial;
      return [active.values[index], (value: unknown) => { active.values[index] = value; }];
    },
    useEffect(effect: () => void) {
      const index = active.index++;
      if (!active.effectsRun.has(index)) active.pending.push([index, effect]);
    },
    useCallback(callback: unknown) { active.index++; return callback; },
  };
  const exports: any = {};
  const storageListeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
  vm.runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "react") return react;
      if (name === "./user-sync") return { syncUserProfile: (...args: unknown[]) => syncCalls.push(args) };
      throw Error(`Unexpected import ${name}`);
    },
    window: {
      localStorage: local, sessionStorage: session,
      addEventListener(type: string, listener: (event: { key: string | null; newValue: string | null }) => void) {
        if (type === "storage") storageListeners.add(listener);
      },
      removeEventListener(type: string, listener: (event: { key: string | null; newValue: string | null }) => void) {
        if (type === "storage") storageListeners.delete(listener);
      },
    }, Date, JSON,
  }, { filename: "lib/onboarding-state.ts" });
  function mount() {
    active = { values: [], index: 0, pending: [], effectsRun: new Set<number>() };
    const render = () => { active.index = 0; return exports.useOnboarding(); };
    render();
    for (const [index, effect] of active.pending) {
      active.effectsRun.add(index);
      effect();
    }
    return render;
  }
  return {
    local, session, mount, syncCalls,
    externalRemoval() {
      local.data.delete(key);
      for (const listener of storageListeners) listener({ key, newValue: null });
    },
    externalClear() {
      local.data.clear();
      for (const listener of storageListeners) listener({ key: null, newValue: null });
    },
  };
}

const key = "alpha-onboarding";
const local = storage();
const session = storage();
let app = runtime(local, session);
let page = app.mount();
assert.equal(page().update({ firstName: "Test reader", email: "reader@example.test" }), true);
assert.equal(page().state.firstName, "Test reader");
assert.equal(page().storageError, null);
assert.equal(session.data.has(key), false);
assert.equal(app.mount()().state.email, "reader@example.test");
app = runtime(local, session); // full reload, fresh module memory
assert.equal(app.mount()().state.firstName, "Test reader");

// An external signout/cleanup must not resurrect a successful local save.
const removalLocal = storage();
const removalApp = runtime(removalLocal, storage());
const removalPage = removalApp.mount();
assert.equal(removalPage().update({ firstName: "Remove me" }), true);
removalApp.externalRemoval();
assert.equal(removalApp.mount()().state.firstName, undefined);

// Another tab's signout must clear this tab's session fallback too, including
// the currently mounted answers. A reload must not bring them back.
const fallbackLocal = storage();
const fallbackSession = storage();
fallbackLocal.faults.write = true;
const fallbackApp = runtime(fallbackLocal, fallbackSession);
let fallbackPage = fallbackApp.mount();
assert.equal(fallbackPage().update({ firstName: "Fallback private" }), true);
assert.equal(fallbackSession.data.has(key), true);
fallbackApp.externalRemoval();
assert.equal(fallbackPage().state.firstName, undefined);
assert.equal(fallbackSession.data.has(key), false);
assert.equal(fallbackApp.mount()().state.firstName, undefined);
assert.equal(runtime(fallbackLocal, fallbackSession).mount()().state.firstName, undefined);
fallbackPage = fallbackApp.mount();
assert.equal(fallbackPage().update({ firstName: "Clear event" }), true);
fallbackApp.externalClear();
assert.equal(fallbackSession.data.has(key), false);
assert.equal(fallbackApp.mount()().state.firstName, undefined);

// A tab that hydrated earlier merges onto another tab's latest local save.
const otherTab = runtime(local, storage());
const otherPage = otherTab.mount();
page = app.mount();
assert.equal(otherPage().update({ theme: "classic" }), true);
assert.equal(page().update({ city: "Tampa" }), true);
assert.equal(JSON.parse(local.data.get(key)!).theme, "classic");

// A stale local copy must not beat a newer same-tab fallback.
local.faults.write = true;
page = app.mount();
assert.equal(page().update({ projectBlurb: "Reader draft" }), true);
assert.equal(page().storageError, null);
assert.equal(JSON.parse(local.data.get(key)!).projectBlurb, undefined);
assert.equal(JSON.parse(session.data.get(key)!).projectBlurb, "Reader draft");
assert.equal(app.mount()().state.projectBlurb, "Reader draft");
app = runtime(local, session);
assert.equal(app.mount()().state.projectBlurb, "Reader draft");

// A later successful local save becomes primary again and clears fallback.
local.faults.write = false;
page = app.mount();
assert.equal(page().update({ jobBlurb: "Builder" }), true);
assert.equal(session.data.has(key), false);
assert.equal(JSON.parse(local.data.get(key)!).city, "Tampa");

// Either store can hydrate if the other store's read is denied.
local.faults.read = true;
session.data.set(key, JSON.stringify({ firstName: "Session reader", draftSavedAt: Date.now() + 100 }));
assert.equal(runtime(local, session).mount()().state.firstName, "Session reader");
local.faults.read = false;
session.faults.read = true;
assert.equal(runtime(local, session).mount()().state.city, "Tampa");
session.faults.read = false;
session.data.delete(key);

// Neither store can persist. The current tab retains the draft, but update
// returns false so the caller can block navigation before a full reload.
local.faults.write = true;
session.faults.write = true;
app = runtime(local, session);
page = app.mount();
const syncBeforeFailedSave = app.syncCalls.length;
assert.equal(page().update({ funBlurb: "Keep me here" }), false);
assert.equal(app.syncCalls.length, syncBeforeFailedSave);
assert.match(page().storageError, /could not be saved/);
assert.equal(app.mount()().state.funBlurb, "Keep me here");
assert.equal(runtime(local, session).mount()().state.funBlurb, undefined);
local.faults.read = true;
session.faults.read = true;
assert.match(runtime(local, session).mount()().storageError, /could not be saved/);
local.faults.read = false;
session.faults.read = false;
local.faults.write = false;
session.faults.write = false;

// Expired email remains available to prefill, but cannot pass completeness.
const oldEmailSavedAt = Date.now() - 25 * 60 * 60 * 1000;
local.data.set(key, JSON.stringify({ email: "old@example.test", emailSavedAt: oldEmailSavedAt, firstName: "Old reader" }));
app = runtime(local, session);
page = app.mount();
assert.equal(page().emailDraft, "old@example.test");
assert.equal(page().state.email, undefined);
assert.equal(page().update({ city: "Miami" }), true);
assert.equal(page().state.email, undefined);
assert.equal(JSON.parse(local.data.get(key)!).emailSavedAt, oldEmailSavedAt);
assert.equal(app.syncCalls.at(-1)[0].email, undefined);
assert.equal(page().update({ email: "confirmed@example.test" }), true);
assert.equal(page().state.email, "confirmed@example.test");
assert.equal(page().emailDraft, "confirmed@example.test");

// Explicit reset removes both stores and the same-module memory draft.
session.data.set(key, JSON.stringify({ email: "fallback@example.test", draftSavedAt: 1 }));
assert.equal(page().reset(), true);
assert.equal(local.data.has(key), false);
assert.equal(session.data.has(key), false);
assert.equal(page().emailDraft, undefined);
assert.equal(app.mount()().state.firstName, undefined);
assert.equal(runtime(local, session).mount()().state.firstName, undefined);

// Reset must also clear a draft saved in the session fallback.
local.faults.write = true;
app = runtime(local, session);
page = app.mount();
assert.equal(page().update({ firstName: "Fallback only" }), true);
assert.equal(session.data.has(key), true);
assert.equal(page().reset(), true);
assert.equal(session.data.has(key), false);
assert.equal(app.mount()().state.firstName, undefined);

// If removal is denied but writing works, replace the private draft with an
// empty one so a reload also stays clear.
const deniedLocal = storage();
app = runtime(deniedLocal, storage());
page = app.mount();
assert.equal(page().update({ firstName: "Private reader" }), true);
deniedLocal.faults.remove = true;
assert.equal(page().reset(), true);
assert.equal(page().storageError, null);
assert.equal(app.mount()().state.firstName, undefined);
assert.equal(runtime(deniedLocal, storage()).mount()().state.firstName, undefined);

// If both removal and overwrite fail, caller must keep the user on the page.
deniedLocal.faults.remove = false;
page = app.mount();
assert.equal(page().update({ firstName: "Cannot clear" }), true);
deniedLocal.faults.remove = true;
deniedLocal.faults.write = true;
assert.equal(page().reset(), false);
assert.match(page().storageError, /could not be saved/);
assert.equal(app.mount()().state.firstName, undefined);

console.log("PASS verify-onboarding-draft-storage (actual hook; offline storage and remount cases)");
