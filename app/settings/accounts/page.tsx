"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Footer } from "@/components/Footer";
import { topicLabel } from "@/lib/topics";
import { THEMES } from "@/lib/themes";

interface AdminUserRow {
  id: string;
  email: string;
  first_name: string | null;
  city: string | null;
  theme: string | null;
  topics: string[] | null;
  stripe_customer_id: string | null;
  subscribed_at: string | null;
  cancelled_at: string | null;
  unsubscribed_at: string | null;
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

  async function load() {
    try {
      const res = await fetch("/alpha/api/admin/users");
      if (res.status === 401) {
        setErr("Sign in first.");
        return;
      }
      if (res.status === 403) {
        setErr("Not authorized.");
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers(data.users);
      if (data.stats) setStats(data.stats);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load users.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function act(userId: string, action: "delete" | "grant_free" | "revoke_free", confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(userId);
    try {
      const res = await fetch("/alpha/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, userId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  function statusLabel(u: AdminUserRow): { label: string; color: string } {
    if (u.unsubscribed_at) return { label: "Unsubscribed", color: "var(--ink-soft)" };
    if (u.cancelled_at) return { label: "Cancelled", color: "var(--ink-soft)" };
    if (u.subscribed_at && u.stripe_customer_id) return { label: "Paying", color: "var(--accent-ink)" };
    if (u.subscribed_at && !u.stripe_customer_id) return { label: "Free (granted)", color: "var(--accent-ink)" };
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
          alpha<span style={{ color: "var(--accent)" }}>.</span>
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
              {users.length} TOTAL
            </span>
          )}
        </div>
        <p className="alpha-ui text-sm mb-10" style={{ color: "var(--ink-soft)" }}>
          Admin-only. Everyone who has signed up for Alpha. Grant free, delete, or just look.
        </p>

        {stats && (
          <div
            className="alpha-card p-5 mb-10"
            style={{
              borderColor: "var(--rule)",
              borderRadius: "var(--radius-card)",
              background: "var(--paper-deep)",
            }}
          >
            <div className="alpha-mono mb-4" style={{ color: "var(--accent-ink)" }}>
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
                sub="alpha@youngalgy.com"
              />
              <Stat
                label="Send cron"
                value="armed"
                sub="Sun/Tue/Thu"
              />
              <Stat label="Total users" value={stats.totalUsers} />
            </div>
          </div>
        )}

        {err && (
          <p className="alpha-ui text-sm mb-6" style={{ color: "var(--accent-ink)" }}>
            {err}
          </p>
        )}

        {!users && !err && (
          <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
            Loading…
          </p>
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
                    <span
                      className="alpha-mono text-xs"
                      style={{ color: status.color }}
                    >
                      {status.label.toUpperCase()}
                    </span>
                  </div>
                  <div
                    className="alpha-ui text-xs space-x-3"
                    style={{ color: "var(--ink-soft)" }}
                  >
                    <span>Joined {created}</span>
                    {u.city && <span>· {u.city}</span>}
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
                            `Grant ${u.email} a free Alpha subscription?`
                          )
                        }
                        className="alpha-ui text-xs underline underline-offset-4"
                        style={{
                          color: "var(--accent-ink)",
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
                      style={{ color: "var(--accent-ink)", opacity: isBusy ? 0.4 : 1 }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <Footer />
    </main>
  );
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
