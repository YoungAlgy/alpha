"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Footer } from "@/components/Footer";
import { Wordmark } from "@/components/Wordmark";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { topicLabel } from "@/lib/topics";
import { THEMES } from "@/lib/themes";
import { demographicSummary } from "@/lib/demographics";
import { getAdminAccountState } from "@/lib/admin-account-state";
import { MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE } from "@/lib/suppression-recovery-policy";

interface AdminUserRow {
  id: string;
  email: string;
  first_name: string | null;
  city: string | null;
  birthday: string | null;
  gender: string | null;
  theme: string | null;
  topics: string[] | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscribed_at: string | null;
  access_requested_at: string | null;
  access_granted_at: string | null;
  delivery_enrolled: boolean;
  cancelled_at: string | null;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  suppression_cleanup_pending_at: string | null;
  suppression_recovery_started_at: string | null;
  has_suppression_recovery: boolean;
  created_at: string;
}

interface Stats {
  totalUsers: number;
  pendingRequests: number;
  freeGranted: number;
  lettersEnabled: number;
  signupIncomplete: number;
  unsubscribed: number;
  latestIssueWeekOf: string | null;
  latestIssueCount: number;
}

type AdminAction =
  | "delete"
  | "grant_free"
  | "revoke_free"
  | "grant_invite"
  | "revoke_invite"
  | "deny_access"
  | "enable_delivery"
  | "pause_delivery";

// Invite and free grants are the same thing to the owner now. The server
// picks the matching action from the row's billing history.
const ACTION_VERBS: Record<AdminAction, string> = {
  delete: "Deleted",
  grant_free: "Granted free access to",
  grant_invite: "Granted free access to",
  revoke_free: "Revoked free access from",
  revoke_invite: "Revoked free access from",
  deny_access: "Denied the access request from",
  enable_delivery: "Enabled letters for",
  pause_delivery: "Paused letters for",
};

const ACTION_LABELS: Record<AdminAction, string> = {
  delete: "Delete account",
  grant_free: "Approve access",
  grant_invite: "Approve access",
  revoke_free: "Revoke access",
  revoke_invite: "Revoke access",
  deny_access: "Deny request",
  enable_delivery: "Enable letters",
  pause_delivery: "Pause letters",
};

export default function AdminAccountsPage() {
  const { confirm, dialog } = useConfirmDialog();
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  // alpha-drift-r62-01 (2026-08-20, self-audit-r61): r61's Promise.allSettled
  // fix in the API route (fcc95a6) lets a stats-only failure return a real
  // 200 with `stats: null`, but this page's own `if (data.stats)` no-op'd on
  // null with no else -- so any reload AFTER the first (act()'s own finally
  // block fires one after every admin action, plus search/clear) left the
  // PRIOR stats object rendered under a green "action succeeded" message,
  // indistinguishable from fresh. This flag makes that staleness visible
  // instead of either hiding it (a fix that would ALSO undo r61: `stats:
  // null` is a real, accepted, self-healing degraded response shape, not an
  // error to react to by blanking the whole card again) or leaving it silent.
  const [statsStale, setStatsStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // alpha-drift-r48-02 (2026-08-20): this used to be a single `busy: string
  // | null` slot -- disabling was scoped to whichever ONE userId was in it,
  // so acting on a SECOND row overwrote the shared slot and silently
  // un-disabled the FIRST row's button while its own request was still in
  // flight. Worse, there was no synchronous ref-based re-entrancy latch
  // either, unlike every other mutating action in this codebase
  // (ProfileEditor's saveInFlight, settings/page.tsx's confirmInFlight/
  // resumeInFlight/deleteInFlight) -- a second click on that still-in-flight
  // row (now looking normal again) could fire a real second concurrent
  // request, including for the irreversible delete action. busyRowsRef is
  // the synchronous guard (checked before any async work starts); busyRows
  // mirrors it into React state purely for rendering each row's own
  // disabled state independently.
  const busyRowsRef = useRef<Set<string>>(new Set());
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  // alpha-drift-r53-04 (2026-08-20, duplicate-code-audit): a successful
  // delete removes the acted-on row (and its just-clicked, focused Delete
  // button) from the DOM via the finally block's load() -- with nothing
  // else claiming it, the browser drops focus to <body>, silently losing a
  // keyboard admin's position in the list. Mirrors app/settings/page.tsx's
  // own confirmHeadingRef/billingHeadingRef convention: a monotonic counter
  // (not a boolean, so two actions in a row both trigger the effect even
  // though the "true" value wouldn't visibly change) plus a useEffect keyed
  // on it, so focus moves only once React has actually committed the
  // row's removal, not synchronously inside act() before the DOM updates.
  //
  // alpha-drift-r61-03 (2026-08-20, accessibility-resweep-newer-code-round-
  // 9): originally only incremented for action === "delete". The other
  // account actions can also unmount their own just-
  // clicked button via this same finally-block reload (access status
  // changes swap one conditionally-rendered button for a
  // different one, or for nothing, not an in-place update), dropping focus
  // to <body> identically. Renamed delete->action and the gate on
  // act()'s success path removed so account actions restore focus.
  const [actionCount, setActionCount] = useState(0);
  const accountsHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (actionCount > 0) accountsHeadingRef.current?.focus();
  }, [actionCount]);
  // alpha-drift-r67-01 (2026-08-21, accessibility-resweep-newer-code-r15):
  // Load More's button intentionally never blurs mid-request (aria-disabled,
  // not disabled -- see the button's own comment below), so focus only
  // needs rescuing when THIS action's reload response drops the button from
  // the DOM entirely: hasMore flips false (every row through the newest 200
  // is now shown) and the block's own hasMore gate stops rendering it. Same
  // monotonic-counter-plus-effect shape as actionCount above, gated on the
  // ref being empty so a still-mounted button (more pages left) is left
  // alone -- focus never moved off it in the first place.
  const loadMoreBtnRef = useRef<HTMLButtonElement>(null);
  const [loadMoreCount, setLoadMoreCount] = useState(0);
  useEffect(() => {
    if (loadMoreCount > 0 && !loadMoreBtnRef.current) accountsHeadingRef.current?.focus();
  }, [loadMoreCount]);
  // alpha-drift-r73-02 (2026-08-21, accessibility-resweep-newer-code-r21):
  // clearSearch() unconditionally sets activeSearch to "", which unmounts
  // the just-clicked Clear button (rendered only inside `{activeSearch &&
  // ...}`) with no focus restoration -- the same class already fixed for
  // this file's row actions and Load More, just never wired to this third
  // control. Separate counter, not folded into either of the two above,
  // since Clear's own unmount condition (activeSearch) is independent of
  // both actionCount's and loadMoreCount's.
  const [clearCount, setClearCount] = useState(0);
  useEffect(() => {
    if (clearCount > 0) accountsHeadingRef.current?.focus();
  }, [clearCount]);
  // alpha-drift-r32-04 (2026-08-14): act() only ever alert()'d on FAILURE --
  // a successful account action gave a sighted admin the visual
  // row-list reload as feedback, but a screen reader user got no
  // confirmation an action even happened, unlike settings/page.tsx's own
  // billingMsg pattern for the exact same "did my click work" question.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Search runs against the whole table, so it always comes back as one full
  // (non-appendable) page — "Load more" only makes sense on the unfiltered,
  // newest-first list, so we track it separately from the search box's value.
  const [activeSearch, setActiveSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // load() is called from several places (mount, search, load-more, the
  // delete/grant/revoke reload) — a per-call cancellation flag wouldn't cover
  // all of them, so this stays true for the component's whole lifetime and
  // guards every setState call below against firing post-unmount.
  const mountedRef = useRef(true);
  // alpha-drift-r46-03 (2026-08-19): this used to only ever set the ref to
  // false (on unmount) -- under React Strict Mode dev, every component's
  // effects mount, immediately clean up, then mount again on the same
  // initial render. The first (discarded) mount's cleanup set this to
  // false; nothing ever set it back to true, so it stayed stuck false for
  // the rest of the component's real lifetime and every guard below
  // silently no-op'd forever, leaving the page stuck on its loading
  // skeleton in local dev. Matches the already-fixed pattern in
  // app/archive/page.tsx, app/inbox/page.tsx, and
  // app/inbox/[issueId]/page.tsx.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // alpha-drift-r49-08 (2026-08-20, sibling-consistency-round-7): load() had
  // no request-ordering guard at all -- act()'s own finally block (round
  // 46) always reloads, runSearch/clearSearch each trigger their own load(),
  // and none of these four call sites are sequenced against each other
  // (only busyRowsRef's same-row check blocks a second click on the SAME
  // row). Two admin actions on different rows, or an action racing a
  // search, could each fire their own load() and have the responses land
  // out of HTTP order -- whichever arrives LAST silently wins the
  // setUsers/setStats write, even if it reflects an OLDER request than the
  // one that resolved first. Same class of bug this codebase already
  // guards against elsewhere (app/inbox/[issueId]/page.tsx's
  // activeIssueIdRef/stale() guard, lib/brave.ts's monotonic counter) --
  // loadSeqRef is a monotonic per-call id; a response only gets applied if
  // it's still the MOST RECENTLY ISSUED call by the time it resolves.
  const loadSeqRef = useRef(0);

  // Resolves to the rows this call applied, or null when it failed or a
  // newer load superseded it.
  async function load(opts?: {
    search?: string;
    before?: string;
    append?: boolean;
    pending?: boolean;
    // Same view reloaded (after an action, or Refresh): keep the current rows
    // on screen so a failed reload does not blank the list.
    keep?: boolean;
  }): Promise<AdminUserRow[] | null> {
    if (!mountedRef.current) return null;
    // alpha-drift-r45-04 (2026-08-19): this never cleared a prior `err` on
    // a later successful load -- if the initial mount load() 401'd (e.g.
    // the auth cookie hadn't hydrated yet) and a subsequent retry/search
    // succeeded, the fully-loaded, accurate user list rendered underneath a
    // permanently stuck "Sign in first." banner, with nothing to say the
    // data below it was actually fresh and correct.
    if (err) setErr(null);
    // alpha-drift-r67-03 (2026-08-21, form-validation-consistency-audit-
    // r13): mirrors act()'s own setActionMsg(null)-then-set convention
    // (alpha-drift-r32-04's verify check 8d) -- actionMsg is a single
    // shared slot between act()'s per-action messages and this append
    // path's own, and the two "no more accounts" announcements below can
    // land far apart in time but be textually IDENTICAL, which React's
    // Object.is bailout would otherwise silently swallow (no re-render, no
    // re-announcement). Clearing here -- before the fetch, so there's a
    // real async gap before the real message lands -- guarantees that.
    // Scoped to append only: a blanket clear would wipe out the success
    // message act()'s own finally block just set, moments before its own
    // reload call into this same function.
    if (opts?.append) setActionMsg(null);
    const seq = ++loadSeqRef.current;
    const isStale = () => !mountedRef.current || seq !== loadSeqRef.current;
    setLoading(true);
    // Never show old rows under a newly selected filter or search heading.
    if (!opts?.append && !opts?.keep) setUsers(null);
    try {
      const params = new URLSearchParams();
      if (opts?.search) params.set("q", opts.search);
      else {
        if (opts?.pending) params.set("pending", "1");
        if (opts?.before) params.set("before", opts.before);
      }
      const res = await fetch(`/api/admin/users${params.toString() ? `?${params}` : ""}`, { cache: "no-store" });
      if (isStale()) return null;
      if (res.status === 401) {
        setUsers(null);
        setStats(null);
        setErr("Sign in first.");
        return null;
      }
      if (res.status === 403) {
        setUsers(null);
        setStats(null);
        setErr("Not authorized.");
        return null;
      }
      const data = await res.json();
      if (isStale()) return null;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers((prev) => (opts?.append && prev ? [...prev, ...data.users] : data.users));
      // alpha-drift-r66-01 (2026-08-21, accessibility-resweep-newer-code-
      // r14): Load More appended rows with zero announcement -- the page's
      // own role=status region (below) exists but was only ever
      // fed by act()'s result, never by this path. A screen-reader admin
      // got no confirmation new rows loaded, and (per this page's
      // aria-disabled={loadingMore} on the just-clicked button, the same
      // focus-loss class already fixed for act()'s row actions) couldn't
      // rely on the button's own label change either. Includes the
      // running total, not just this page's count -- the API caps every
      // response at 200, so a bare per-page count would repeat verbatim
      // across consecutive clicks and silently fail to re-announce.
      //
      // alpha-drift-r67-03 (2026-08-21): the zero-row and exhaustion cases
      // were unhandled -- a 0-row response (the boundary lands exactly on
      // a multiple of 200) rendered "Loaded 0 more accounts -- N shown.",
      // wrongly implying rows arrived, and a final partial page gave no
      // signal the list was now complete, unlike the sibling fix in
      // app/archive/page.tsx this mirrors.
      if (opts?.append) {
        const newTotal = (users?.length ?? 0) + data.users.length;
        const stillMore = data.users.length === 200;
        setActionMsg(
          data.users.length === 0
            ? "No more accounts to load."
            : `Loaded ${data.users.length} more account${data.users.length === 1 ? "" : "s"} -- ${newTotal} shown.${stillMore ? "" : " That's all of them."}`
        );
      }
      if (data.stats) {
        setStats(data.stats);
        setStatsStale(false);
      } else {
        // Keep showing the last good numbers rather than blanking the card
        // (see statsStale's own comment) -- just flag them as unverified.
        setStatsStale(true);
      }
      // The API caps every response at 200 rows — fewer than that back means
      // we've hit the end of the table (or, for a search, all the matches).
      setHasMore(data.users.length === 200);
      return data.users as AdminUserRow[];
    } catch (e) {
      if (!isStale()) setErr(e instanceof Error ? e.message : "Couldn't load users.");
      return null;
    } finally {
      if (!isStale()) setLoading(false);
    }
  }

  useEffect(() => {
    // This mount effect hydrates the admin list from the server. load() marks
    // the list as loading before its request, which is the intended update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load({ pending: true });
    // `load` is intentionally mount-only. It is recreated during render and
    // adding it here would turn this hydration effect into a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // alpha-drift-r47-01 (2026-08-20): these had no busy guard at all, unlike
  // every per-row action button on this page (disabled={isBusy}) -- act()'s
  // own finally block (alpha-drift-r46-01) always reloads the row list via
  // load(), so an admin could act on a row, then immediately run a NEW
  // search or hit Clear before that reload resolved. Neither request is
  // sequenced, so whichever response landed last silently won the
  // setUsers/setStats write regardless of which was issued more recently,
  // leaving the admin looking at stale data with no indication anything
  // was wrong. The early-return here is defense in depth on top of the
  // controls themselves being disabled below (Enter can still submit a
  // form whose submit button is disabled, if the input itself isn't).
  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (busyRowsRef.current.size > 0) return;
    const search = q.trim();
    setQ(search);
    setActiveSearch(search);
    setPendingOnly(false);
    setRowErrors({});
    load({ search });
  }

  function clearSearch() {
    if (busyRowsRef.current.size > 0) return;
    setQ("");
    setActiveSearch("");
    setPendingOnly(true);
    setRowErrors({});
    load({ pending: true });
    setClearCount((c) => c + 1);
  }

  function showPendingRequests() {
    if (busyRowsRef.current.size > 0) return;
    setQ("");
    setActiveSearch("");
    setPendingOnly(true);
    setRowErrors({});
    load({ pending: true });
  }

  function showAllAccounts() {
    if (busyRowsRef.current.size > 0) return;
    setQ("");
    setActiveSearch("");
    setPendingOnly(false);
    setRowErrors({});
    load();
  }

  async function loadMore() {
    if (loading || loadingMore || busyRowsRef.current.size > 0 || activeSearch || !users || users.length === 0) return;
    setLoadingMore(true);
    try {
      const last = users[users.length - 1];
      const before = pendingOnly ? last.access_requested_at : last.created_at;
      if (!before) return;
      await load({ before, append: true, pending: pendingOnly });
    } finally {
      setLoadingMore(false);
      setLoadMoreCount((c) => c + 1);
    }
  }

  async function act(
    userId: string,
    email: string,
    action: AdminAction,
    confirmMsg?: string
  ) {
    if (loading || busyRowsRef.current.has(userId)) return;
    busyRowsRef.current.add(userId);
    // Lock before awaiting the in-app question. Cancel must never reach the
    // mutation or its reload, and unmount resolves the question as cancelled.
    if (confirmMsg && !await confirm({
      title: `${ACTION_LABELS[action]}?`,
      description: confirmMsg,
      confirmLabel: ACTION_LABELS[action],
      destructive: action === "delete" || action === "revoke_free" || action === "revoke_invite",
    })) {
      busyRowsRef.current.delete(userId);
      return;
    }
    if (!mountedRef.current) {
      busyRowsRef.current.delete(userId);
      return;
    }
    setBusyRows(new Set(busyRowsRef.current));
    setActionMsg(null);
    setRowErrors((prev) => ({ ...prev, [userId]: "" }));
    let failure: string | null = null;
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId, ...(action === "enable_delivery" || action === "pause_delivery" ? { expectedEmail: email } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (mountedRef.current) setActionMsg(`${ACTION_VERBS[action]} ${email}.`);
    } catch (e) {
      failure = e instanceof Error ? e.message : "Action failed.";
      const message = failure;
      if (mountedRef.current) setRowErrors((prev) => ({ ...prev, [userId]: message }));
    } finally {
      // alpha-drift-r46-01 (2026-08-19): this used to only reload on the
      // clean-success path. An action can commit before a later operation
      // reports an error, so skipping the reload here can leave the row list
      // showing a pre-action snapshot after a committed write. Reload through whatever
      // search was active, so acting on a result found past the newest-200
      // window doesn't bounce the admin back to page one -- regardless of
      // whether this action's own response was a full success.
      const rows = await load(
        activeSearch
          ? { search: activeSearch, keep: true }
          : { pending: pendingOnly, keep: true }
      );
      busyRowsRef.current.delete(userId);
      if (!mountedRef.current) return;
      // A failed action can still remove its row (a partial delete, or a
      // request approved elsewhere). Show that error where it stays visible.
      if (failure && rows && !rows.some((row) => row.id === userId)) {
        setActionMsg(`${email}: ${failure}`);
      }
      // alpha-drift-r65-03 (2026-08-21, accessibility-resweep-newer-code-
      // r13): used to sit in the try block's success-only branch (see
      // actionCount's own comment above for the r61-03 "all 4 actions"
      // history) -- but the same r46-01 reasoning above applies here too:
      // a committed action can unmount the just-clicked row's button on the
      // reload above exactly like a
      // clean success does, dropping a keyboard/screen-reader admin's
      // focus to <body> with no restoration. Moved here so it fires
      // whenever this reload actually ran, not just on a clean response.
      setActionCount((c) => c + 1);
      setBusyRows(new Set(busyRowsRef.current));
    }
  }

  // alpha-drift-r21-02 (found+fixed 2026-08-14): this whole page used to color
  // its status labels/badges/action buttons with var(--accent-ink), which
  // fails WCAG AA's 4.5:1 normal-text contrast against var(--paper) in 11 of
  // this app's 25 themes -- including root/forest, the literal default a
  // fresh signup renders with no theme chosen yet (2.88:1, worse than the
  // 3:1 floor even for large text). Computed every theme's real hex values
  // in app/globals.css to confirm: var(--ink) clears 4.5:1 in EVERY theme
  // (lowest is sunset at 7.97:1), so it's a safe universal swap for text on
  // this admin-only page -- not a fix to the shared accent-ink token itself,
  // which is used for non-text accents elsewhere in the app and is a bigger,
  // deliberate design-system question outside this page's scope.
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-5xl mx-auto w-full flex items-center justify-between">
        <Link
          href="/inbox"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          <Wordmark />
        </Link>
        <Link
          href="/settings"
          className="alpha-ui text-sm py-3 -my-3"
          style={{ color: "var(--ink-soft)" }}
        >
          ← Back to settings
        </Link>
      </nav>

      <section className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full">
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-2">
          <h1
            ref={accountsHeadingRef}
            tabIndex={-1}
            className="alpha-display text-4xl md:text-5xl font-bold tracking-tight"
            style={{ outline: "none" }}
          >
            Accounts
          </h1>
          {users && (
            <span className="alpha-mono" style={{ color: "var(--ink-soft)" }}>
              {users.length} SHOWN
              {stats
                ? ` OF ${
                    pendingOnly ? stats.pendingRequests : stats.totalUsers
                  } ${pendingOnly ? "PENDING" : "ACCOUNTS"}${
                    statsStale ? " (unverified)" : ""
                  }`
                : ""}
            </span>
          )}
        </div>
        <p className="alpha-ui text-sm mb-6" style={{ color: "var(--ink-soft)" }}>
          Free, owner-approved access. Approve access first, then enable letters separately.
        </p>

        <form onSubmit={runSearch} className="flex flex-wrap gap-3 mb-10">
          <input
            type="text"
            // alpha-drift-r69-01 (2026-08-21, form-validation-consistency-
            // audit-r15): this used to be type="email" -- the server does a
            // plain ILIKE substring match with no format requirement
            // (app/api/admin/users/route.ts:237), but a real <form
            // onSubmit> plus a type="submit" button means the browser's
            // own HTML5 email-format constraint validation ran first and
            // silently blocked submitting anything that isn't shaped like
            // "x@y" -- so the one realistic way an admin actually uses this
            // box (a name fragment, a bare domain like "gmail.com") never
            // reached runSearch() at all. inputMode="email" keeps the
            // mobile "@" keyboard hint (matches app/signin/page.tsx and
            // components/EmailChanger.tsx's own inputMode usage) without
            // triggering format validation the way type="email" does.
            inputMode="email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by email…"
            // alpha-drift-r21-11 (found+fixed 2026-08-14): placeholder text
            // is not an accessible name -- it disappears once the field has
            // a value, and most screen readers don't announce it reliably
            // as a label in the first place. aria-label gives this field a
            // real accessible name without changing the visual layout.
            aria-label="Search by email"
            disabled={busyRows.size > 0}
            className="alpha-ui text-sm flex-1 min-w-0 px-3 py-2 border"
            style={{ borderColor: "var(--rule)", borderRadius: "var(--radius-card)", background: "var(--paper)", opacity: busyRows.size > 0 ? 0.6 : 1 }}
          />
          <button
            type="submit"
            disabled={busyRows.size > 0}
            className="alpha-ui text-sm px-4 py-2 underline underline-offset-4"
            style={{ color: "var(--ink)", opacity: busyRows.size > 0 ? 0.4 : 1 }}
          >
            Search
          </button>
          {activeSearch && (
            <button
              type="button"
              disabled={busyRows.size > 0}
              onClick={clearSearch}
              className="alpha-ui text-sm px-4 py-2 underline underline-offset-4"
              style={{ color: "var(--ink-soft)", opacity: busyRows.size > 0 ? 0.4 : 1 }}
            >
              Clear
            </button>
          )}
        </form>

        <div className="flex flex-wrap gap-4 -mt-6 mb-4">
          <button
            type="button"
            disabled={busyRows.size > 0 || pendingOnly}
            onClick={showPendingRequests}
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{
              color: "var(--ink)",
              opacity: busyRows.size > 0 || pendingOnly ? 0.5 : 1,
            }}
          >
            Pending requests{stats ? ` (${stats.pendingRequests})` : ""}
          </button>
          <button
            type="button"
            disabled={busyRows.size > 0 || (!pendingOnly && !activeSearch)}
            onClick={showAllAccounts}
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{
              color: "var(--ink-soft)",
              opacity:
                busyRows.size > 0 || (!pendingOnly && !activeSearch) ? 0.5 : 1,
            }}
          >
            All accounts
          </button>
          <button
            type="button"
            // aria-disabled, not disabled: a disabled button drops keyboard
            // focus to <body> mid-refresh (same reason as Load more below).
            aria-disabled={loading || busyRows.size > 0}
            onClick={() => {
              if (loading || busyRowsRef.current.size > 0) return;
              setRowErrors({});
              load(activeSearch ? { search: activeSearch, keep: true } : { pending: pendingOnly, keep: true });
            }}
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--ink-soft)" }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <p className="alpha-ui text-sm mb-6" style={{ color: "var(--ink-soft)" }}>
          Pending requests appear after email confirmation and the final Request access step.
          All accounts also includes people who have only started signup. Approved requests move out of Pending.
        </p>

        {stats && (
          <div
            className="alpha-card p-5 mb-10"
            style={{
              // alpha-drift-r63-01 (2026-08-21, self-audit-r62): this used
              // to be `opacity: statsStale ? 0.6 : 1` on the whole card --
              // group opacity composites BOTH the background and the
              // --ink-soft text as one layer against the page backdrop, so
              // it silently dropped every label/sub-line/the disclosure
              // span itself below the 4.5:1 WCAG AA floor in all 26 themes
              // -- the exact class the same round's 82f2a00 commit was
              // busy purging everywhere else. Border-color-only cue instead
              // -- text stays at full, already-tuned contrast.
              borderColor: statsStale ? "var(--ink-soft)" : "var(--rule)",
              borderRadius: "var(--radius-card)",
              background: "var(--paper-deep)",
            }}
          >
            <div className="alpha-mono mb-4" style={{ color: "var(--ink)" }}>
              OPERATIONAL STATE
              {statsStale && (
                <span role="status" style={{ color: "var(--ink-soft)" }}>
                  {" "}
                  -- couldn&apos;t refresh, showing the last known numbers
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <Stat label="Free (granted)" value={stats.freeGranted} />
              <Stat label="Letters enabled" value={stats.lettersEnabled} sub="Enrollment only. Delivery blocks still apply." />
              <Stat label="Pending requests" value={stats.pendingRequests} />
              <Stat label="Signup started" value={stats.signupIncomplete} />
              <Stat label="Unsubscribed" value={stats.unsubscribed} />
              <Stat label="Latest issue" value={stats.latestIssueWeekOf || "—"} sub={`${stats.latestIssueCount} sent`} />
              <Stat
                label="Email"
                value="Resend"
                sub="alpha@everyday.report"
              />
              <Stat label="Total users" value={stats.totalUsers} />
            </div>
          </div>
        )}

        {err && (
          <p role="alert" className="alpha-ui text-sm mb-6" style={{ color: "var(--ink)" }}>
            {err}
          </p>
        )}

        {/* alpha-drift-r32-04 (2026-08-14): announces act()'s result --
            see the state comment above. Visible now so a failed action whose
            row left the list still has somewhere to show its error. */}
        <p role="status" aria-live="polite" className="alpha-ui text-sm mb-4">
          {actionMsg}
        </p>

        {/* alpha-drift-r19-01 (found+fixed 2026-08-07): was a bare "Loading…"
            line, unlike every sibling data page (app/archive/page.tsx,
            inbox/[issueId]'s LetterLoader) which both render a pulse
            skeleton shaped like the eventual content to avoid a layout
            jump. Shape mirrors a real row below: name+email line, a status
            badge, a metadata line. */}
        {!users && !err && (
          <ul className="space-y-4 animate-pulse" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="border-b pb-4" style={{ borderColor: "var(--rule)" }}>
                <div className="flex items-baseline justify-between gap-4 mb-2">
                  <div className="h-5 w-48 rounded" style={{ background: "var(--rule)" }} />
                  <div className="h-3 w-16 rounded" style={{ background: "var(--rule)" }} />
                </div>
                <div className="h-3 w-64 rounded" style={{ background: "var(--rule)" }} />
              </li>
            ))}
          </ul>
        )}

        {users && users.length === 0 && (
          <p className="alpha-display text-lg" style={{ color: "var(--ink-soft)" }}>
            {pendingOnly ? "No pending access requests." : "Nobody yet."}
          </p>
        )}

        {users && users.length > 0 && (
          <ul className="space-y-4">
            {users.map((u) => {
              const account = getAdminAccountState(u);
              const theme = u.theme ? THEMES.find((t) => t.id === u.theme)?.label || u.theme : "—";
              const topics = (u.topics || [])
                .map((id) => topicLabel(id))
                .filter(Boolean)
                .join(" · ");
              const created = new Date(u.created_at).toLocaleDateString();
              const hasPendingAccessRequest = account.pending;
              const isBusy = loading || busyRows.has(u.id);
              // alpha-drift-r20-06: deliverability suppression is its own
              // badge, separate from the access label, since any reader can
              // be bounce-suppressed.
              const isSuppressed = account.suppressed;
              const recoveryInProgress = account.recovery;
              return (
                <li
                  key={u.id}
                  className="border-b pb-4"
                  style={{ borderColor: "var(--rule)" }}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3 mb-1">
                    <div className="min-w-0 break-words">
                      <span className="alpha-display text-lg font-semibold">
                        {u.first_name || "Name not saved"}
                      </span>
                      <span
                        className="alpha-ui text-sm ml-3"
                        style={{ color: "var(--ink-soft)" }}
                      >
                        {u.email}
                      </span>
                    </div>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span
                        className="alpha-mono text-xs"
                        style={{ color: "var(--ink)" }}
                      >
                        {account.deliveryLabel.toUpperCase()}
                      </span>
                      {(isSuppressed || recoveryInProgress) && (
                        <span
                          className="alpha-mono text-xs"
                          style={{ color: "var(--ink)" }}
                          // alpha-drift-r21-09 (found+fixed 2026-08-14):
                          // bounced_at/complained_at are independent,
                          // non-exclusive flags (isSuppressed is an OR of
                          // both), but this tooltip was an if/else keyed
                          // only on bounced_at -- a reader with BOTH set had
                          // the complaint reason/date silently dropped, with
                          // no indication a second suppression cause even
                          // existed. Joins whichever ones are actually set.
                          title={[
                            u.bounced_at ? `Bounced ${new Date(u.bounced_at).toLocaleDateString()}` : null,
                            u.complained_at ? `Complained ${new Date(u.complained_at).toLocaleDateString()}` : null,
                            u.suppression_cleanup_pending_at
                              ? `Reviewed recovery required since ${new Date(
                                  u.suppression_cleanup_pending_at
                                ).toLocaleDateString()}`
                              : null,
                            u.suppression_recovery_started_at
                              ? `Recovery started ${new Date(
                                  u.suppression_recovery_started_at
                                ).toLocaleDateString()}. Delivery and deletion stay blocked until reviewed settlement.`
                              : null,
                          ].filter(Boolean).join(" · ")}
                        >
                          {recoveryInProgress
                            ? "RECOVERY IN PROGRESS"
                            : u.suppression_cleanup_pending_at
                            ? "DELIVERY REVIEW"
                            : "SUPPRESSED"}
                        </span>
                      )}
                      <span
                        className="alpha-mono text-xs"
                        style={{ color: "var(--ink)" }}
                      >
                        {account.accessLabel.toUpperCase()}
                      </span>
                    </span>
                  </div>
                  <div
                    className="alpha-ui text-xs space-x-3"
                    style={{ color: "var(--ink-soft)" }}
                  >
                    <span>Joined {created}</span>
                    {u.city && <span>· {u.city}</span>}
                    {u.gender && <span>· {u.gender === "male" ? "Male" : u.gender === "female" ? "Female" : u.gender}</span>}
                    {u.birthday && <span>· {demoSummary(u.birthday)}</span>}
                    {theme !== "—" && <span>· {theme}</span>}
                  </div>
                  {topics && (
                    <div
                      className="alpha-ui text-xs mt-1"
                      style={{ color: "var(--ink-soft)" }}
                    >
                      {topics}
                    </div>
                  )}
                  {u.access_requested_at && account.pending && (
                    <p className="alpha-ui text-xs mt-2" style={{ color: "var(--ink-soft)" }}>
                      Requested {new Date(u.access_requested_at).toLocaleString()}
                    </p>
                  )}
                  {account.deliveryBlockReason && (
                    <p className="alpha-ui text-sm mt-2" style={{ color: "var(--ink-soft)" }}>
                      {account.deliveryBlockReason}
                    </p>
                  )}
                  {rowErrors[u.id] && (
                    <p role="alert" className="alpha-ui text-sm mt-2" style={{ color: "var(--ink)" }}>
                      {rowErrors[u.id]}
                    </p>
                  )}
                  {/* alpha-drift-r53-03 (2026-08-20, accessibility-resweep-
                      newer-code): these 4 buttons carried zero touch-target
                      padding -- under the WCAG 2.5.8 24px minimum, unlike
                      the Search/Clear controls above (which have real px-4
                      py-2 padding) and every other underline-only action
                      button already fixed for this exact gap elsewhere in
                      the app (InstallPrompt.tsx, QuestionStep.tsx, topics/
                      page.tsx, you/page.tsx). py-2 -my-2 (vertical-only, not
                      p-2 -m-2) deliberately avoids colliding with this row's
                      own gap-3 horizontal spacing. */}
                  <div className="flex flex-wrap gap-3 mt-3">
                    {!u.delivery_enrolled && (
                      <button
                        type="button"
                        disabled={isBusy || !account.canEnableDelivery}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            "enable_delivery",
                            `Enable daily Alpha letters for ${u.email}? They will join the next scheduled send. This will not send old issues.`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 min-h-11 px-3 py-2"
                        style={{ color: "var(--ink)", opacity: isBusy || !account.canEnableDelivery ? 0.4 : 1 }}
                        title={account.deliveryBlockReason || undefined}
                      >
                        Enable letters
                      </button>
                    )}
                    {u.delivery_enrolled && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => act(u.id, u.email, "pause_delivery")}
                        className="alpha-ui text-xs underline underline-offset-4 min-h-11 px-3 py-2"
                        style={{ color: "var(--ink)", opacity: isBusy ? 0.4 : 1 }}
                      >
                        Pause letters
                      </button>
                    )}
                    {account.grantAction && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            account.grantAction!,
                            `Approve free Alpha access for ${u.email}? Letter delivery stays a separate setting.`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                        style={{
                          color: "var(--ink)",
                          opacity: isBusy ? 0.4 : 1,
                        }}
                      >
                        {hasPendingAccessRequest ? "Approve access" : "Grant free"}
                      </button>
                    )}
                    {account.revokeAction && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            account.revokeAction!,
                            `Revoke ${u.email}'s free access and pause future letters?${account.revokeNote}`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                        style={{ color: "var(--ink-soft)", opacity: isBusy ? 0.4 : 1 }}
                      >
                        Revoke access
                      </button>
                    )}
                    {hasPendingAccessRequest && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            "deny_access",
                            `Deny ${u.email}'s Alpha access request? They can request again later.`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                        style={{
                          color: "var(--ink-soft)",
                          opacity: isBusy ? 0.4 : 1,
                        }}
                      >
                        Deny request
                      </button>
                    )}
                    {account.needsAccountReview && (
                      <span
                        className="alpha-ui text-xs basis-full"
                        style={{ color: "var(--ink-soft)" }}
                      >
                        This historical account needs review before access can change.
                      </span>
                    )}
                    {isSuppressed && !recoveryInProgress && (
                      <span
                        className="alpha-ui text-xs basis-full"
                        style={{ color: "var(--ink-soft)" }}
                      >
                        {MANUAL_PROVIDER_SUPPRESSION_REMOVAL_HOLD_MESSAGE}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={isBusy || recoveryInProgress}
                      onClick={() =>
                        act(
                          u.id,
                          u.email,
                          "delete",
                          `Permanently delete ${u.email}? This removes auth + their letters. Cannot be undone.`
                        )
                      }
                      className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                      style={{
                        color: "var(--ink)",
                        opacity: isBusy || recoveryInProgress ? 0.4 : 1,
                      }}
                      title={
                        recoveryInProgress
                          ? "Deletion stays blocked until the reviewed delivery recovery settles."
                          : undefined
                      }
                    >
                      {recoveryInProgress ? "Deletion blocked" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Search results come back as one full page already — "Load more" only
            applies to the unfiltered, newest-first list. */}
        {users && users.length > 0 && !activeSearch && hasMore && (
          <button
            type="button"
            ref={loadMoreBtnRef}
            // alpha-drift-r67-01: aria-disabled, not disabled -- a real
            // disabled attribute blurs a focused button back to <body> the
            // instant it's set (Chrome and others), which fires mid-click
            // on every "more pages remain" case even though the button
            // stays mounted right after -- the opposite of the focus loss
            // this fix exists to prevent. loadMore()'s own leading guard
            // (if (loadingMore) ... return;) does the re-entrancy job
            // disabled used to.
            aria-disabled={loading || loadingMore || busyRows.size > 0}
            onClick={loadMore}
            className="alpha-ui text-sm mt-6 underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--ink)", opacity: loadingMore ? 0.4 : 1 }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
      <Footer />
      {dialog}
    </main>
  );
}

// "Millennial, Leo" from a birthday, falling back to the raw date if it doesn't
// parse (so an admin still sees something for a malformed row).
function demoSummary(birthday: string): string {
  return demographicSummary(birthday) || birthday;
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div>
      <div className="alpha-mono mb-1" style={{ color: "var(--ink-soft)", fontSize: 10 }}>
        {label.toUpperCase()}
      </div>
      <div
        className="alpha-display text-2xl font-bold leading-tight"
        style={{ color: color || "var(--ink)" }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="alpha-ui text-xs mt-1"
          style={{ color: "var(--ink-soft)" }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
