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

function channelHub(queued = false) {
  const channels = new Set<{ onmessage?: (event: { data: unknown }) => void }>();
  const pending: Array<() => void> = [];
  return class BroadcastChannelDouble {
    static flush() { for (const deliver of pending.splice(0)) deliver(); }
    onmessage?: (event: { data: unknown }) => void;
    constructor(_name: string) { channels.add(this); }
    postMessage(data: unknown) {
      for (const channel of channels) if (channel !== this) {
        const deliver = () => channel.onmessage?.({ data });
        if (queued) pending.push(deliver);
        else deliver();
      }
    }
    close() { channels.delete(this); }
  };
}

function runtime(local = storage(), session = storage(), BroadcastChannel = channelHub()) {
  let active: any;
  let cleanup: (() => void) | undefined;
  const syncCalls: any[] = [];
  const react = {
    useState(initial: unknown) {
      const index = active.index++;
      if (!(index in active.values)) active.values[index] = initial;
      return [active.values[index], (value: unknown) => { active.values[index] = value; }];
    },
    useEffect(effect: () => void | (() => void)) {
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
    }, BroadcastChannel, Date, JSON,
  }, { filename: "lib/onboarding-state.ts" });
  function mount() {
    cleanup?.();
    active = { values: [], index: 0, pending: [], effectsRun: new Set<number>() };
    const render = () => { active.index = 0; return exports.useOnboarding(); };
    render();
    for (const [index, effect] of active.pending) {
      active.effectsRun.add(index);
      cleanup = effect();
    }
    return render;
  }
  return {
    local, session, mount, syncCalls,
    unmount() { cleanup?.(); cleanup = undefined; },
    externalRemoval() {
      if (!local.data.delete(key)) return; // Browser sends no event for a no-op remove.
      for (const listener of storageListeners) listener({ key, newValue: null });
    },
    externalClear() {
      if (local.data.size === 0) return; // Clearing an empty store is also a no-op.
      local.data.clear();
      for (const listener of storageListeners) listener({ key: null, newValue: null });
    },
    externalResetMarker() {
      const value = local.data.get("alpha-onboarding-reset-at");
      if (value === undefined) return;
      for (const listener of storageListeners) listener({ key: "alpha-onboarding-reset-at", newValue: value });
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
assert.equal(app.syncCalls.length, 1); // Default updates still sync.
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
const fallbackOtherSession = storage();
const fallbackChannels = channelHub();
fallbackLocal.faults.write = true;
const fallbackApp = runtime(fallbackLocal, fallbackSession, fallbackChannels);
const fallbackOtherTab = runtime(fallbackLocal, fallbackOtherSession, fallbackChannels);
let fallbackPage = fallbackApp.mount();
assert.equal(fallbackPage().update({ firstName: "Fallback private" }), true);
assert.equal(fallbackSession.data.has(key), true);
assert.equal(fallbackLocal.data.has(key), false);
const fallbackOtherPage = fallbackOtherTab.mount();
assert.equal(fallbackOtherPage().reset(), true); // no local key, so no storage event
assert.equal(fallbackPage().state.firstName, undefined);
assert.equal(fallbackSession.data.has(key), false);
assert.equal(fallbackApp.mount()().state.firstName, undefined);
assert.equal(runtime(fallbackLocal, fallbackSession).mount()().state.firstName, undefined);
fallbackPage = fallbackApp.mount();
assert.equal(fallbackPage().update({ firstName: "Clear event" }), true);
fallbackLocal.data.set("unrelated-key", "present");
fallbackApp.externalClear();
assert.equal(fallbackSession.data.has(key), false);
assert.equal(fallbackApp.mount()().state.firstName, undefined);

// A reset that can overwrite but cannot remove the shared key also clears
// another tab's newer session fallback and its mounted form.
const deniedSharedLocal = storage();
const deniedSharedSession = storage();
const deniedSharedChannels = channelHub();
const deniedSharedTab = runtime(deniedSharedLocal, deniedSharedSession, deniedSharedChannels);
const deniedResetTab = runtime(deniedSharedLocal, storage(), deniedSharedChannels);
let deniedSharedPage = deniedSharedTab.mount();
assert.equal(deniedSharedPage().update({ firstName: "Private backup" }), true);
deniedSharedLocal.faults.write = true;
assert.equal(deniedSharedPage().update({ city: "Private city" }), true);
assert.equal(deniedSharedSession.data.has(key), true);
deniedSharedLocal.faults.write = false;
deniedSharedLocal.faults.remove = true;
assert.equal(deniedResetTab.mount()().reset(), true);
assert.equal(deniedSharedPage().state.firstName, undefined);
assert.equal(deniedSharedSession.data.has(key), false);
assert.equal(runtime(deniedSharedLocal, deniedSharedSession).mount()().state.firstName, undefined);

// A tab on another route misses the live message, then rejects its old
// session-only draft on remount using the durable reset marker.
const dormantLocal = storage();
const dormantSession = storage();
const dormantChannels = channelHub();
const dormantTab = runtime(dormantLocal, dormantSession, dormantChannels);
const dormantResetTab = runtime(dormantLocal, storage(), dormantChannels);
dormantLocal.faults.write = true;
const dormantPage = dormantTab.mount();
assert.equal(dormantPage().update({ firstName: "Dormant private" }), true);
assert.equal(dormantSession.data.has(key), true);
dormantTab.unmount();
dormantLocal.faults.write = false;
assert.equal(dormantResetTab.mount()().reset(), true);
assert.equal(dormantSession.data.has(key), true); // No listener was mounted.
assert.equal(dormantTab.mount()().state.firstName, undefined);
assert.equal(runtime(dormantLocal, dormantSession).mount()().state.firstName, undefined);

// With no BroadcastChannel, a reset marker storage event clears an open tab
// whose session draft has no shared draft key. Receiving it does not publish
// a second marker or create a reset loop.
const unavailableChannel = class {
  onmessage?: (event: { data: unknown }) => void;
  constructor(_name: string) { throw Error("test-only channel unavailable"); }
  postMessage(_data: unknown) {}
  close() {}
};
const markerLocal = storage();
const markerSession = storage();
const markerTab = runtime(markerLocal, markerSession, unavailableChannel);
const markerResetTab = runtime(markerLocal, storage(), unavailableChannel);
markerLocal.faults.write = true;
const markerPage = markerTab.mount();
assert.equal(markerPage().update({ firstName: "Marker private" }), true);
markerLocal.faults.write = false;
assert.equal(markerResetTab.mount()().reset(), true);
const publishedReset = markerLocal.data.get("alpha-onboarding-reset-at");
assert.ok(publishedReset);
markerTab.externalResetMarker();
assert.equal(markerPage().state.firstName, undefined);
assert.equal(markerSession.data.has(key), false);
assert.equal(markerLocal.data.get("alpha-onboarding-reset-at"), publishedReset);

// The live signal can arrive after the reader has already saved a new draft.
// Its older reset timestamp must not erase that post-reset work.
const delayedLocal = storage();
const delayedSession = storage();
const delayedChannels = channelHub(true);
const delayedTab = runtime(delayedLocal, delayedSession, delayedChannels);
const delayedResetTab = runtime(delayedLocal, storage(), delayedChannels);
delayedLocal.faults.write = true;
const delayedPage = delayedTab.mount();
assert.equal(delayedPage().update({ firstName: "Old draft" }), true);
delayedLocal.faults.write = false;
assert.equal(delayedResetTab.mount()().reset(), true);
delayedLocal.faults.write = true;
assert.equal(delayedPage().update({ firstName: "New draft" }), true);
delayedChannels.flush();
assert.equal(delayedPage().state.firstName, "New draft");
assert.equal(delayedSession.data.has(key), true);

// A tab that hydrated earlier merges onto another tab's latest local save.
const otherTab = runtime(local, storage());
const otherPage = otherTab.mount();
page = app.mount();
assert.equal(otherPage().update({ theme: "classic" }), true);
assert.equal(page().update({ city: "Tampa" }), true);
assert.equal(JSON.parse(local.data.get(key)!).theme, "classic");

// A server-authoritative save can mirror locally without another profile sync.
const syncBeforeMirror = app.syncCalls.length;
assert.equal(page().update({ topics: ["tech"] as any }, { sync: false }), true);
assert.equal(app.syncCalls.length, syncBeforeMirror);
assert.equal(JSON.parse(local.data.get(key)!).topics[0], "tech");
assert.equal(page().update({ jobBlurb: "Default sync check" }), true);
assert.equal(app.syncCalls.length, syncBeforeMirror + 1);

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
