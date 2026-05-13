"use client";

import Link from "next/link";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPIC_BY_ID } from "@/lib/topics";
import { THEMES } from "@/lib/themes";
import { Footer } from "@/components/Footer";

export default function SettingsPage() {
  const { state, reset } = useOnboarding();
  const themeLabel = state.theme
    ? THEMES.find((t) => t.id === state.theme)?.label
    : "Forest";

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
          <p className="alpha-display text-base">Alpha · $5 / month</p>
          <p className="alpha-ui text-sm mt-1" style={{ color: "var(--ink-soft)" }}>
            Billing dashboard arrives with Stripe wiring.
          </p>
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
              onClick={() => {
                if (confirm("Delete your local Alpha data? This cannot be undone.")) {
                  reset();
                  localStorage.removeItem("alpha-first-issue");
                  window.location.href = "/welcome";
                }
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
