"use client";

import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPIC_BY_ID } from "@/lib/topics";
import { THEMES } from "@/lib/themes";

export default function CheckoutPage() {
  const router = useRouter();
  const { state, update } = useOnboarding();

  function subscribe() {
    // Stripe wiring lands later. For V0 we mark as paid + jump to the writing screen.
    update({ paid: true, completedAt: new Date().toISOString() });
    router.push("/writing" as never);
  }

  const firstName = state.firstName || "you";
  const themeLabel = state.theme
    ? THEMES.find((t) => t.id === state.theme)?.label
    : "Forest";

  return (
    <StepShell stepIndex={10} prevPath="email">
      <div className="space-y-10">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            Almost there, {firstName}.
          </h1>
          <p
            className="alpha-display text-lg md:text-xl leading-relaxed"
            style={{ color: "var(--ink-soft)" }}
          >
            Your first letter is ready to write. Subscribe to publish it.
          </p>
        </div>

        <div
          className="alpha-card p-6 space-y-5"
          style={{ borderColor: "var(--rule)", borderRadius: "var(--radius-card)" }}
        >
          <SummaryRow label="Topics" value={
            (state.topics || []).map((id) => {
              const t = TOPIC_BY_ID[id];
              return t ? `${t.emoji} ${t.label}` : id;
            }).join(" · ") || "—"
          } />
          <SummaryRow label="Theme" value={themeLabel || "Forest"} />
          {state.city && <SummaryRow label="City" value={state.city} />}
          {state.email && <SummaryRow label="Email" value={state.email} />}
        </div>

        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            background: "var(--paper-deep)",
            borderRadius: "var(--radius-card)",
          }}
        >
          <div className="flex items-baseline gap-3">
            <span className="alpha-display text-5xl font-bold">$5</span>
            <span
              className="alpha-ui text-base"
              style={{ color: "var(--ink-soft)" }}
            >
              per month · cancel anytime
            </span>
          </div>
          <button
            type="button"
            onClick={subscribe}
            className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
          >
            Subscribe &amp; write my first letter →
          </button>
          <p
            className="alpha-ui text-xs text-center"
            style={{ color: "var(--ink-soft)" }}
          >
            Secured by Stripe · billed monthly · cancel from settings · no ads
          </p>
        </div>
      </div>
    </StepShell>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span
        className="alpha-mono"
        style={{ color: "var(--ink-soft)" }}
      >
        {label.toUpperCase()}
      </span>
      <span
        className="alpha-display text-sm md:text-base text-right"
        style={{ color: "var(--ink)" }}
      >
        {value}
      </span>
    </div>
  );
}
