"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPIC_BY_ID } from "@/lib/topics";
import { THEMES } from "@/lib/themes";
import { Footer } from "@/components/Footer";
import { deleteUserAccount } from "@/lib/user-sync";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";

const ADMIN_EMAIL = "youngalgy@gmail.com";

export default function SettingsPage() {
  const { state, reset } = useOnboarding();
  const themeLabel = state.theme
    ? THEMES.find((t) => t.id === state.theme)?.label
    : "Forest";
  const [isAdmin, setIsAdmin] = useState(false);
  // Topic-quota state: quota = max topics they can pick (5/10/15/20/25),
  // priceCents = current monthly bill in cents. Both come from public.users
  // (mirror of Stripe subscription quantity × $5).
  const [topicQuota, setTopicQuota] = useState<number>(5);
  const [busyTier, setBusyTier] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        if (user.email === ADMIN_EMAIL) setIsAdmin(true);
        const { data: row } = await sb
          .from("users")
          .select("topic_quota")
          .eq("id", user.id)
          .maybeSingle();
        if (row?.topic_quota && typeof row.topic_quota === "number") {
          setTopicQuota(Math.max(5, Math.min(25, row.topic_quota)));
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  async function changeTier(direction: "up" | "down") {
    const confirmMsg =
      direction === "up"
        ? `Add 5 more topics? Your bill goes up $5/mo (prorated this cycle).`
        : `Drop 5 topics? Your bill goes down $5/mo. Already-selected topics over the new cap will need to be unpicked next time you visit Topics.`;
    if (!confirm(confirmMsg)) return;
    setBusyTier(direction);
    try {
      const res = await fetch("/alpha/api/stripe/update-quantity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTopicQuota(data.topicQuota);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Couldn't update plan.");
    } finally {
      setBusyTier(null);
    }
  }

  const monthlyDollars = (topicQuota / 5) * 5;
  const canAdd = topicQuota < 25;
  const canRemove = topicQuota > 5;

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-3xl mx-auto w-full flex items-center justify-between">
        <Link
          href="/inbox"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
        <Link
          href="/inbox"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          ← Back to inbox
        </Link>
      </nav>

      <section className="flex-1 max-w-2xl mx-auto px-6 py-10 w-full">
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-12">
          Settings
        </h1>

        <Section title="Your topics">
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            The five things your letter focuses on each week.
          </p>
          <ul className="space-y-1 mb-3">
            {(state.topics || []).map((id) => {
              const t = TOPIC_BY_ID[id];
              return (
                <li key={id} className="alpha-display text-base">
                  {t ? `${t.emoji} ${t.label}` : id}
                </li>
              );
            })}
          </ul>
          <Link
            href="/topics"
            className="alpha-ui text-sm underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            Change topics →
          </Link>
        </Section>

        <Section title="Theme">
          <p className="alpha-display text-base mb-3">
            {themeLabel}
          </p>
          <Link
            href="/theme"
            className="alpha-ui text-sm underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            Change theme →
          </Link>
        </Section>

        <Section title="Email">
          <p className="alpha-display text-base mb-3">{state.email || "—"}</p>
          <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
            Email change requires verification. Coming soon.
          </p>
        </Section>

        <Section title="Billing">
          <p className="alpha-display text-base mb-1">
            Alpha · ${monthlyDollars} / month
          </p>
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            {topicQuota} topics this cycle
          </p>
          <div className="flex flex-wrap gap-4 mb-3">
            {canAdd && (
              <button
                type="button"
                disabled={busyTier !== null}
                onClick={() => changeTier("up")}
                className="alpha-ui text-sm underline underline-offset-4"
                style={{
                  color: "var(--accent-ink)",
                  opacity: busyTier ? 0.4 : 1,
                }}
              >
                {busyTier === "up" ? "Adding…" : "Add 5 more topics (+$5/mo) →"}
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                disabled={busyTier !== null}
                onClick={() => changeTier("down")}
                className="alpha-ui text-sm underline underline-offset-4"
                style={{
                  color: "var(--ink-soft)",
                  opacity: busyTier ? 0.4 : 1,
                }}
              >
                {busyTier === "down" ? "Dropping…" : "Drop 5 topics (−$5/mo)"}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                const res = await fetch("/alpha/api/stripe/portal", { method: "POST" });
                const data = await res.json();
                if (res.status === 401) {
                  alert("Sign in first to manage billing.");
                  return;
                }
                if (res.status === 400) {
                  alert(data.error || "Subscribe first.");
                  return;
                }
                if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
                window.location.href = data.url;
              } catch (e) {
                alert(e instanceof Error ? e.message : "Couldn't open billing.");
              }
            }}
            className="alpha-ui text-sm underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            Manage subscription →
          </button>
          <p className="alpha-ui text-xs mt-2" style={{ color: "var(--ink-soft)" }}>
            Update card, cancel, see invoices — all in Stripe.
          </p>
        </Section>

        {isAdmin && (
          <Section title="Accounts (admin)">
            <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
              See everyone who's signed up. Grant free subscriptions or remove users.
            </p>
            <Link
              href="/settings/accounts"
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              Manage all users →
            </Link>
          </Section>
        )}

        <Section title="What's new">
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            Recent improvements, additions, and fixes.
          </p>
          <Link
            href="/settings/changelog"
            className="alpha-ui text-sm underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            Changelog →
          </Link>
        </Section>

        <Section title="Account">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => {
                const blob = new Blob([JSON.stringify(state, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "alpha-export.json";
                a.click();
              }}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              Download my data
            </button>
            <br />
            <button
              type="button"
              onClick={async () => {
                if (!confirm("Delete your Alpha account? This removes your saved letters and profile. Can't be undone.")) return;
                const result = await deleteUserAccount();
                if (!result.ok) {
                  alert(`Couldn't delete: ${result.error}\nLocal data will still clear.`);
                }
                reset();
                localStorage.removeItem("alpha-first-issue");
                localStorage.removeItem("alpha-theme");
                window.location.href = "/welcome";
              }}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Delete my account
            </button>
          </div>
        </Section>
      </section>
      <Footer />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="py-8 border-b"
      style={{ borderColor: "var(--rule)" }}
    >
      <h2
        className="alpha-mono mb-4"
        style={{ color: "var(--accent-ink)" }}
      >
        {title.toUpperCase()}
      </h2>
      {children}
    </div>
  );
}
