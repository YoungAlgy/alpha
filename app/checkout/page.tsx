"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { topicLabel, topicEmoji } from "@/lib/topics";
import { THEMES } from "@/lib/themes";
import { track } from "@/lib/analytics";
import type { ThemeId } from "@/lib/types";

const SWATCHES: Record<ThemeId, { paper: string; ink: string; accent: string }> = {
  soft: { paper: "#FBF6EC", ink: "#3A2E26", accent: "#F4A57D" },
  linen: { paper: "#FAF6EE", ink: "#1A1A1A", accent: "#C75D3F" },
  ink: { paper: "#FFFFFF", ink: "#000000", accent: "#B3162F" },
  cottage: { paper: "#ECEEDA", ink: "#3D3528", accent: "#A86B4F" },
  arcade: { paper: "#FFF8E7", ink: "#2D1E47", accent: "#FF6B9D" },
  marina: { paper: "#F4ECD8", ink: "#2D3A4A", accent: "#E89B6A" },
  midnight: { paper: "#0F1419", ink: "#E8D5A8", accent: "#7BA7D9" },
  forest: { paper: "#F4EFE0", ink: "#1F3D2E", accent: "#C9A961" },
  mono: { paper: "#FFFFFF", ink: "#000000", accent: "#FF0000" },
  sunset: { paper: "#FAEBD7", ink: "#5E3B5A", accent: "#E87C3E" },
  mitch: { paper: "#0A0A0B", ink: "#ECE6D8", accent: "#D4B373" },
};

export default function CheckoutPage() {
  const router = useRouter();
  const { state, update } = useOnboarding();

  const [subscribing, setSubscribing] = useState(false);
  const [stripeErr, setStripeErr] = useState<string | null>(null);
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);

  async function subscribe() {
    setSubscribing(true);
    setStripeErr(null);
    track("checkout_started", { topics: state.topics?.length ?? 0 });
    try {
      const res = await fetch("/alpha/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: state.email,
          firstName: state.firstName,
          city: state.city,
        }),
      });
      const data = await res.json();
      if (res.status === 503) {
        // Stripe env not set — fall back to V0 stub flow
        update({ paid: true, completedAt: new Date().toISOString() });
        router.push("/writing" as never);
        return;
      }
      if (res.status === 409) {
        // Already an active subscriber — refuse to create a second
        // subscription. Show the "you're already in" state, not the retry
        // error (telling them to "try again" would invite a double charge).
        setSubscribing(false);
        setAlreadySubscribed(true);
        return;
      }
      if (!res.ok || !data.url) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      window.location.href = data.url;
    } catch (e) {
      setSubscribing(false);
      setStripeErr(e instanceof Error ? e.message : "Checkout failed.");
    }
  }

  const firstName = state.firstName || "you";
  const themeId = (state.theme || "forest") as ThemeId;
  const themeLabel = THEMES.find((t) => t.id === themeId)?.label || "Forest";
  const sw = SWATCHES[themeId];

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
            Subscribe and we&apos;ll write your first letter on the spot.
          </p>
        </div>

        <div className="grid md:grid-cols-[160px_1fr] gap-5 items-stretch">
          <div
            className="rounded-lg overflow-hidden p-4 flex flex-col justify-between"
            style={{
              background: sw.paper,
              border: "1.5px solid var(--rule)",
              aspectRatio: "4 / 5",
            }}
            aria-hidden
          >
            <div>
              <div
                className="text-[8px] tracking-widest"
                style={{ color: sw.ink, opacity: 0.5 }}
              >
                SUNDAY · MAY 17
              </div>
              <div
                className="text-base font-bold mt-2"
                style={{
                  color: sw.ink,
                  fontFamily:
                    themeId === "arcade"
                      ? "var(--font-pixelify)"
                      : "var(--font-display)",
                }}
              >
                Hi {firstName},
              </div>
              <div
                className="text-[8px] leading-snug mt-1"
                style={{ color: sw.ink, opacity: 0.7 }}
              >
                Two things pulling at me this week. The recruiting signals…
              </div>
            </div>
            <div className="flex items-center justify-between mt-2">
              <div
                className="text-[9px] font-bold"
                style={{ color: sw.ink }}
              >
                {themeLabel}
              </div>
              <div className="flex gap-0.5">
                <span style={{ background: sw.paper, width: 6, height: 6, borderRadius: 1, border: `1px solid ${sw.ink}33` }} />
                <span style={{ background: sw.ink, width: 6, height: 6, borderRadius: 1 }} />
                <span style={{ background: sw.accent, width: 6, height: 6, borderRadius: 1 }} />
              </div>
            </div>
          </div>

          <div
            className="alpha-card p-5 space-y-4"
            style={{ borderColor: "var(--rule)", borderRadius: "var(--radius-card)" }}
          >
            <div>
              <div className="alpha-mono mb-2" style={{ color: "var(--ink-soft)" }}>
                YOUR TOPICS
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(state.topics || []).map((id) => (
                  <span
                    key={id}
                    className="alpha-ui text-xs px-2 py-1 rounded-full"
                    style={{
                      background: "var(--callout-bg)",
                      color: "var(--ink)",
                    }}
                  >
                    {topicEmoji(id)} {topicLabel(id)}
                  </span>
                ))}
              </div>
            </div>
            {state.city && <MiniRow label="City" value={state.city} />}
            {state.email && <MiniRow label="Email" value={state.email} />}
          </div>
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
          {alreadySubscribed ? (
            <div className="space-y-3">
              <p
                className="alpha-ui text-sm text-center"
                style={{ color: "var(--ink)" }}
              >
                You&apos;re already subscribed. No need to pay again.
              </p>
              <button
                type="button"
                onClick={() => router.push("/inbox" as never)}
                className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
              >
                Go to your letters →
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={subscribe}
              disabled={subscribing}
              className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
              style={{ opacity: subscribing ? 0.6 : 1 }}
            >
              {subscribing ? "Taking you to checkout…" : "Subscribe & get my first letter →"}
            </button>
          )}
          {stripeErr && (
            <p
              role="alert"
              className="alpha-ui text-xs text-center"
              style={{ color: "var(--accent-ink)" }}
            >
              {stripeErr}. Try again, or email youngalgy@gmail.com.
            </p>
          )}
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

function MiniRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="alpha-mono" style={{ color: "var(--ink-soft)" }}>
        {label.toUpperCase()}
      </span>
      <span
        className="alpha-display text-sm text-right truncate max-w-[60%]"
        style={{ color: "var(--ink)" }}
      >
        {value}
      </span>
    </div>
  );
}
