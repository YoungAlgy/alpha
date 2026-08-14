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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  useEffect(() => () => { mountedRef.current = false; }, []);

  async function load(opts?: { search?: string; before?: string; append?: boolean }) {
    try {
      const params = new URLSearchParams();
      if (opts?.search) params.set("q", opts.search);
      else if (opts?.before) params.set("before", opts.before);
      const res = await fetch(`/api/admin/users${params.toString() ? `?${params}` : ""}`);
      if (!mountedRef.current) return;
      if (res.status === 401) {
        setErr("Sign in first.");
        return;
      }
      if (res.status === 403) {
        setErr("Not authorized.");
        return;
      }
      const data = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers((prev) => (opts?.append && prev ? [...prev, ...data.users] : data.users));
      if (data.stats) setStats(data.stats);
      // The API caps every response at 200 rows — fewer than that back means
      // we've hit the end of the table (or, for a search, all the matches).
      setHasMore(data.users.length === 200);
    } catch (e) {
      if (mountedRef.current) setErr(e instanceof Error ? e.message : "Couldn't load users.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setActiveSearch(q);
    load({ search: q });
  }

  function clearSearch() {
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

  async function act(userId: string, action: "delete" | "grant_free" | "revoke_free" | "clear_suppression", confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(userId);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Reload through whatever search was active, so acting on a result found
      // past the newest-200 window doesn't bounce the admin back to page one.
      await load(activeSearch ? { search: activeSearch } : undefined);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
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
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          ← Back to settings
        </Link>
      </nav>

      <section className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full">
        <div className="flex items-baseline justify-between mb-2">
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight">
            Accounts
          </h1>
          {users && (
            <span className="alpha-mono" style={{ color: "var(--ink-soft)" }}>
              {users.length} SHOWN{stats ? ` OF ${stats.totalUsers}` : ""}
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
            className="alpha-ui text-sm flex-1 px-3 py-2 border"
            style={{ borderColor: "var(--rule)", borderRadius: "var(--radius-card)", background: "var(--paper)" }}
          />
          <button
            type="submit"
            className="alpha-ui text-sm px-4 py-2 underline underline-offset-4"
            style={{ color: "var(--ink)" }}
          >
            Search
          </button>
          {activeSearch && (
            <button
              type="button"
              onClick={clearSearch}
              className="alpha-ui text-sm px-4 py-2 underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Clear
            </button>
          )}
        </form>

        {stats && (
          <div
            className="alpha-card p-5 mb-10"
            style={{
              borderColor: "var(--rule)",
              borderRadius: "var(--radius-card)",
              background: "var(--paper-deep)",
            }}
          >
            <div className="alpha-mono mb-4" style={{ color: "var(--ink)" }}>
              OPERATIONAL STATE
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
              const isBusy = busy === u.id;
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
                          title={u.bounced_at ? `Bounced ${new Date(u.bounced_at).toLocaleDateString()}` : `Complained ${new Date(u.complained_at!).toLocaleDateString()}`}
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
                  <div className="flex gap-3 mt-3">
                    {!u.subscribed_at && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          act(
                            u.id,
                            "grant_free",
                            `Grant ${u.email} a free alpha. subscription?`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4"
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
                            "revoke_free",
                            `Revoke ${u.email}'s free subscription?`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4"
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
                            "clear_suppression",
                            `Clear delivery suppression for ${u.email}? Their next send will go through normally.`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4"
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
                          "delete",
                          `Permanently delete ${u.email}? This removes auth + their letters. Cannot be undone.`
                        )
                      }
                      className="alpha-ui text-xs underline underline-offset-4"
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
            className="alpha-ui text-sm mt-6 underline underline-offset-4"
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
