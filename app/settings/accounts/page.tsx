"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Footer } from "@/components/Footer";
import { Wordmark } from "@/components/Wordmark";
import { topicLabel } from "@/lib/topics";
import { THEMES } from "@/lib/themes";
import { demographicSummary } from "@/lib/demographics";
import { hasActiveAccess } from "@/lib/access";

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
  subscribed_at: string | null;
  cancelled_at: string | null;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  created_at: string;
}

interface Stats {
  totalUsers: number;
  paying: number;
  freeGranted: number;
  cancelled: number;
  unsubscribed: number;
  notSubscribed: number;
  latestIssueWeekOf: string | null;
  latestIssueCount: number;
}

export default function AdminAccountsPage() {
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
  // 9): originally only incremented for action === "delete" -- but
  // grant_free/revoke_free/clear_suppression ALSO unmount their own just-
  // clicked button via this same finally-block reload (isGranted/
  // isSuppressed flipping swaps one conditionally-rendered button for a
  // different one, or for nothing, not an in-place update), dropping focus
  // to <body> identically. Renamed delete->action and the gate on
  // act()'s success path removed so all 4 actions restore focus, not just
  // delete.
  const [actionCount, setActionCount] = useState(0);
  const accountsHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (actionCount > 0) accountsHeadingRef.current?.focus();
  }, [actionCount]);
  // alpha-drift-r32-04 (2026-08-14): act() only ever alert()'d on FAILURE --
  // a successful grant/revoke/clear/delete gave a sighted admin the visual
  // row-list reload as feedback, but a screen reader user got no
  // confirmation an action even happened, unlike settings/page.tsx's own
  // billingMsg pattern for the exact same "did my click work" question.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Search runs against the whole table, so it always comes back as one full
  // (non-appendable) page — "Load more" only makes sense on the unfiltered,
  // newest-first list, so we track it separately from the search box's value.
  const [activeSearch, setActiveSearch] = useState("");
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

  async function load(opts?: { search?: string; before?: string; append?: boolean }) {
    // alpha-drift-r45-04 (2026-08-19): this never cleared a prior `err` on
    // a later successful load -- if the initial mount load() 401'd (e.g.
    // the auth cookie hadn't hydrated yet) and a subsequent retry/search
    // succeeded, the fully-loaded, accurate user list rendered underneath a
    // permanently stuck "Sign in first." banner, with nothing to say the
    // data below it was actually fresh and correct.
    if (err) setErr(null);
    const seq = ++loadSeqRef.current;
    const isStale = () => !mountedRef.current || seq !== loadSeqRef.current;
    try {
      const params = new URLSearchParams();
      if (opts?.search) params.set("q", opts.search);
      else if (opts?.before) params.set("before", opts.before);
      const res = await fetch(`/api/admin/users${params.toString() ? `?${params}` : ""}`);
      if (isStale()) return;
      if (res.status === 401) {
        setErr("Sign in first.");
        return;
      }
      if (res.status === 403) {
        setErr("Not authorized.");
        return;
      }
      const data = await res.json();
      if (isStale()) return;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers((prev) => (opts?.append && prev ? [...prev, ...data.users] : data.users));
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
    } catch (e) {
      if (!isStale()) setErr(e instanceof Error ? e.message : "Couldn't load users.");
    }
  }

  useEffect(() => {
    load();
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
    setActiveSearch(q);
    load({ search: q });
  }

  function clearSearch() {
    if (busyRowsRef.current.size > 0) return;
    setQ("");
    setActiveSearch("");
    load();
  }

  async function loadMore() {
    if (!users || users.length === 0) return;
    setLoadingMore(true);
    try {
      await load({ before: users[users.length - 1].created_at, append: true });
    } finally {
      setLoadingMore(false);
    }
  }

  async function act(userId: string, email: string, action: "delete" | "grant_free" | "revoke_free" | "clear_suppression", confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    if (busyRowsRef.current.has(userId)) return;
    busyRowsRef.current.add(userId);
    setBusyRows(new Set(busyRowsRef.current));
    setActionMsg(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const verb =
        action === "delete"
          ? "Deleted"
          : action === "grant_free"
          ? "Granted free access to"
          : action === "revoke_free"
          ? "Revoked free access from"
          : "Cleared delivery suppression for";
      setActionMsg(`${verb} ${email}.`);
      // alpha-drift-r61-03: no longer gated to action === "delete" -- see
      // actionCount's own comment above.
      setActionCount((c) => c + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed.");
    } finally {
      // alpha-drift-r46-01 (2026-08-19): this used to only reload on the
      // clean-success path -- but grant_free's own 502 (alpha-drift-r45-01)
      // means the DB write already landed even though the response reports
      // an error, so skipping the reload here left the row list/stats
      // showing the pre-action snapshot (e.g. still "Not subscribed", or a
      // SUPPRESSED badge that the DB write actually just cleared) for a
      // write that had, in fact, already committed. Reload through whatever
      // search was active, so acting on a result found past the newest-200
      // window doesn't bounce the admin back to page one -- regardless of
      // whether this action's own response was a full success.
      await load(activeSearch ? { search: activeSearch } : undefined);
      busyRowsRef.current.delete(userId);
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
  function statusLabel(u: AdminUserRow): { label: string; color: string } {
    if (u.unsubscribed_at) return { label: "Unsubscribed", color: "var(--ink-soft)" };
    // "Cancelled" = actually churned (cancel date in the PAST). A FUTURE
    // cancelled_at is cancel-at-period-end: still paying, still getting
    // letters, so it falls through to the Paying row below — matches
    // hasActiveAccess, the single source of truth the cron + access gates use
    // (and the same rule gatherStats applies to the stat tile above).
    if (u.cancelled_at && !hasActiveAccess(u.cancelled_at)) return { label: "Cancelled", color: "var(--ink-soft)" };
    if (u.subscribed_at && u.stripe_customer_id) return { label: "Paying", color: "var(--ink)" };
    if (u.subscribed_at && !u.stripe_customer_id) return { label: "Free (granted)", color: "var(--ink)" };
    return { label: "Not subscribed", color: "var(--ink-soft)" };
  }

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
        <div className="flex items-baseline justify-between mb-2">
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
              {users.length} SHOWN{stats ? ` OF ${stats.totalUsers}${statsStale ? " (unverified)" : ""}` : ""}
            </span>
          )}
        </div>
        <p className="alpha-ui text-sm mb-6" style={{ color: "var(--ink-soft)" }}>
          Admin-only. Everyone who has signed up for alpha. Grant free, delete, or just look.
        </p>

        <form onSubmit={runSearch} className="flex gap-3 mb-10">
          <input
            type="email"
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
            className="alpha-ui text-sm flex-1 px-3 py-2 border"
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
              <Stat label="Paying" value={stats.paying} />
              <Stat label="Free (granted)" value={stats.freeGranted} />
              <Stat label="Cancelled" value={stats.cancelled} />
              <Stat label="Unsubscribed" value={stats.unsubscribed} />
              <Stat
                label="Latest issue"
                value={stats.latestIssueWeekOf || "—"}
                sub={
                  stats.latestIssueWeekOf
                    ? `${stats.latestIssueCount} sent`
                    : undefined
                }
              />
              <Stat
                label="Email"
                value="Resend"
                sub="alpha@everyday.report"
              />
              <Stat
                label="Send cron"
                value="armed"
                sub="Daily, 14:00 UTC"
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

        {/* alpha-drift-r32-04 (2026-08-14): sr-only, announces act()'s
            result -- see the state comment above. */}
        <p role="status" aria-live="polite" className="sr-only">
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
            Nobody yet.
          </p>
        )}

        {users && users.length > 0 && (
          <ul className="space-y-4">
            {users.map((u) => {
              const status = statusLabel(u);
              const theme = u.theme ? THEMES.find((t) => t.id === u.theme)?.label || u.theme : "—";
              const topics = (u.topics || [])
                .map((id) => topicLabel(id))
                .filter(Boolean)
                .join(" · ");
              const created = new Date(u.created_at).toLocaleDateString();
              const isGranted = !!u.subscribed_at && !u.stripe_customer_id;
              const isBusy = busyRows.has(u.id);
              // alpha-drift-r20-06: deliverability suppression is orthogonal
              // to billing status (statusLabel above) -- a Paying subscriber
              // can be silently bounce-suppressed too, so this is its own
              // badge, not folded into status.label.
              const isSuppressed = !!u.bounced_at || !!u.complained_at;
              return (
                <li
                  key={u.id}
                  className="border-b pb-4"
                  style={{ borderColor: "var(--rule)" }}
                >
                  <div className="flex items-baseline justify-between gap-4 mb-1">
                    <div>
                      <span className="alpha-display text-lg font-semibold">
                        {u.first_name || "—"}
                      </span>
                      <span
                        className="alpha-ui text-sm ml-3"
                        style={{ color: "var(--ink-soft)" }}
                      >
                        {u.email}
                      </span>
                    </div>
                    <span className="flex items-center gap-2 shrink-0">
                      {isSuppressed && (
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
                          ].filter(Boolean).join(" · ")}
                        >
                          SUPPRESSED
                        </span>
                      )}
                      <span
                        className="alpha-mono text-xs"
                        style={{ color: status.color }}
                      >
                        {status.label.toUpperCase()}
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
                  <div className="flex gap-3 mt-3">
                    {!u.subscribed_at && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            "grant_free",
                            `Grant ${u.email} a free alpha. subscription?`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                        style={{
                          color: "var(--ink)",
                          opacity: isBusy ? 0.4 : 1,
                        }}
                      >
                        Grant free
                      </button>
                    )}
                    {isGranted && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            "revoke_free",
                            `Revoke ${u.email}'s free subscription?`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                        style={{ color: "var(--ink-soft)", opacity: isBusy ? 0.4 : 1 }}
                      >
                        Revoke free
                      </button>
                    )}
                    {isSuppressed && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            u.email,
                            "clear_suppression",
                            `Clear delivery suppression for ${u.email}? Their next send will go through normally.`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                        style={{ color: "var(--ink)", opacity: isBusy ? 0.4 : 1 }}
                      >
                        Clear suppression
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        act(
                          u.id,
                          u.email,
                          "delete",
                          `Permanently delete ${u.email}? This removes auth + their letters. Cannot be undone.`
                        )
                      }
                      className="alpha-ui text-xs underline underline-offset-4 py-2 -my-2"
                      style={{ color: "var(--ink)", opacity: isBusy ? 0.4 : 1 }}
                    >
                      Delete
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
            disabled={loadingMore}
            onClick={loadMore}
            className="alpha-ui text-sm mt-6 underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--ink)", opacity: loadingMore ? 0.4 : 1 }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
      <Footer />
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
