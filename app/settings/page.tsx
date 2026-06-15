"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useOnboarding } from "@/lib/onboarding-state";
import { topicLabel, topicEmoji } from "@/lib/topics";
import { Footer } from "@/components/Footer";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { deleteUserAccount } from "@/lib/user-sync";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { hasActiveAccess } from "@/lib/access";

const ADMIN_EMAIL = "youngalgy@gmail.com";

export default function SettingsPage() {
  const { state, reset } = useOnboarding();
  const [isAdmin, setIsAdmin] = useState(false);
  // Topic-quota state: quota = max topics they can pick (5/10/15/20/25),
  // priceCents = current monthly bill in cents. Both come from public.users
  // (mirror of Stripe subscription quantity × $5).
  const [topicQuota, setTopicQuota] = useState<number>(5);
  // The reader's ranked topic POOL from the DB (source of truth). The top
  // `topicQuota` are favorites that fill the letter; the rest are free backups.
  // Falls back to onboarding localStorage when the DB row hasn't loaded.
  const [topics, setTopics] = useState<string[] | null>(null);
  const [busyTier, setBusyTier] = useState<"up" | "down" | null>(null);
  // In-page billing feedback (replaces jarring/off-brand alert() dialogs).
  const [billingMsg, setBillingMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Whether the user has an active PAID Stripe subscription. Account deletion
  // removes the app account but does NOT cancel Stripe billing (the delete
  // endpoint can't, and the cancelled account can't reach the portal after) —
  // so we warn paying users to cancel first or keep getting charged.
  const [hasPaidSub, setHasPaidSub] = useState(false);
  // The signed-in user's real email (auth session = source of truth). The
  // onboarding-state email in localStorage is only present for users who came
  // through the funnel on this device — admin-granted / fresh-device sign-ins
  // have none, which showed a bare "—" here.
  const [authEmail, setAuthEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return;
        setAuthEmail(user.email ?? null);
        if (user.email === ADMIN_EMAIL) setIsAdmin(true);
        const { data: row } = await sb
          .from("users")
          .select("topic_quota, topics, subscribed_at, cancelled_at, stripe_customer_id")
          .eq("id", user.id)
          .maybeSingle();
        if (row?.topic_quota && typeof row.topic_quota === "number") {
          setTopicQuota(Math.max(5, Math.min(25, row.topic_quota)));
        }
        if (Array.isArray(row?.topics) && row.topics.length > 0) {
          setTopics(row.topics as string[]);
        }
        // Paid + active = subscribed, has a Stripe customer, and not past a
        // cancellation date. (Free admin-granted accounts have no customer id.)
        if (row?.subscribed_at && row?.stripe_customer_id && hasActiveAccess(row.cancelled_at)) {
          setHasPaidSub(true);
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
        : `Drop 5 topics? Your bill goes down $5/mo. Your letter covers 5 fewer each week. Extra picks stay on as free backups.`;
    if (!confirm(confirmMsg)) return;
    setBusyTier(direction);
    setBillingMsg(null);
    try {
      const res = await fetch("/alpha/api/stripe/update-quantity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTopicQuota(data.topicQuota);
      const dollars = (data.topicQuota / 5) * 5;
      setBillingMsg({
        kind: "ok",
        text:
          direction === "up"
            ? `Added. You're now on ${data.topicQuota} topics, $${dollars}/mo. Pick the new ones from Change topics.`
            : `Dropped. You're now on ${data.topicQuota} topics, $${dollars}/mo.`,
      });
    } catch (e) {
      setBillingMsg({ kind: "err", text: e instanceof Error ? e.message : "Couldn't update plan." });
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
          {(() => {
            const all = topics ?? state.topics ?? [];
            const favorites = all.slice(0, topicQuota);
            const backups = all.slice(topicQuota);
            return (
              <>
                <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
                  {backups.length > 0
                    ? `The ${topicQuota} things your letter focuses on each week, plus ${backups.length} backup${backups.length > 1 ? "s" : ""} we swap in when a favorite is quiet.`
                    : topicQuota === 5
                      ? "The five things your letter focuses on each week."
                      : `The ${topicQuota} things your letter focuses on each week.`}
                </p>
                <ul className="space-y-1 mb-3">
                  {favorites.map((id) => (
                    <li key={id} className="alpha-display text-base">
                      {topicEmoji(id)} {topicLabel(id)}
                    </li>
                  ))}
                </ul>
                {backups.length > 0 && (
                  <>
                    <p className="alpha-mono text-xs mb-2" style={{ color: "var(--ink-soft)" }}>
                      BACKUPS
                    </p>
                    <ul className="space-y-1 mb-3">
                      {backups.map((id) => (
                        <li key={id} className="alpha-display text-base" style={{ color: "var(--ink-soft)" }}>
                          {topicEmoji(id)} {topicLabel(id)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <Link
                  href="/topics"
                  className="alpha-ui text-sm underline underline-offset-4"
                  style={{ color: "var(--accent-ink)" }}
                >
                  Change topics →
                </Link>
              </>
            );
          })()}
        </Section>

        <Section title="Theme">
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            Your whole experience in this look. Changes apply everywhere
            instantly.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <ThemeSwitcher />
            <Link
              href="/theme"
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              See all looks →
            </Link>
          </div>
        </Section>

        <Section title="Email">
          <p className="alpha-display text-base mb-3">{authEmail || state.email || "—"}</p>
          <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
            Your letters and sign-in code go here. Need to change it?{" "}
            <Link
              href="/support"
              className="underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              Send us a note
            </Link>{" "}
            and we&apos;ll move your subscription over.
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
          {billingMsg && (
            <p
              role="status"
              aria-live="polite"
              className="alpha-ui text-sm mb-3"
              style={{ color: billingMsg.kind === "err" ? "var(--accent-ink)" : "var(--ink-soft)" }}
            >
              {billingMsg.text}
            </p>
          )}
          <button
            type="button"
            onClick={async () => {
              setBillingMsg(null);
              try {
                const res = await fetch("/alpha/api/stripe/portal", { method: "POST" });
                const data = await res.json();
                if (res.status === 401) {
                  setBillingMsg({ kind: "err", text: "Sign in first to manage billing." });
                  return;
                }
                if (res.status === 400) {
                  setBillingMsg({ kind: "err", text: data.error || "Subscribe first." });
                  return;
                }
                if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
                window.location.href = data.url;
              } catch (e) {
                setBillingMsg({ kind: "err", text: e instanceof Error ? e.message : "Couldn't open billing." });
              }
            }}
            className="alpha-ui text-sm underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            Manage subscription →
          </button>
          <p className="alpha-ui text-xs mt-2" style={{ color: "var(--ink-soft)" }}>
            Update card, cancel, see invoices. All in Stripe.
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
                // Paying users: deletion does NOT stop Stripe billing, and a
                // deleted account can't reach the portal afterward — so warn
                // them to cancel first or they'll keep being charged.
                const confirmMsg = hasPaidSub
                  ? `Delete your Alpha account?\n\nThis removes your letters and profile and can't be undone.\n\n⚠️ It does NOT cancel your $${monthlyDollars}/mo subscription. Stripe will keep charging you, and a deleted account can't cancel it. Cancel your subscription first via "Manage subscription" above, then delete.\n\nDelete anyway?`
                  : "Delete your Alpha account? This removes your saved letters and profile. Can't be undone.";
                if (!confirm(confirmMsg)) return;
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
