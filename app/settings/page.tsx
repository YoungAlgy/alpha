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

  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user?.email === ADMIN_EMAIL) setIsAdmin(true);
      } catch {
        // ignore
      }
    })();
  }, []);

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
          <p className="alpha-display text-base mb-3">Alpha · $5 / month</p>
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
