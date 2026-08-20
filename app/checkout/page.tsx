"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { topicLabel, topicEmoji } from "@/lib/topics";
import { THEMES, SWATCHES, coerceThemeId } from "@/lib/themes";
import { track } from "@/lib/analytics";
import { isProfileComplete } from "@/lib/checkout-guards";
import type { ThemeId } from "@/lib/types";

export default function CheckoutPage() {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();

  const [subscribing, setSubscribing] = useState(false);
  const [stripeErr, setStripeErr] = useState<string | null>(null);
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  // alpha-drift-r39-04 (2026-08-19): a 409 unmounts the focused Subscribe
  // button (the ternary swaps its whole branch) and replaces it with this
  // "already subscribed" block -- with no ref/focus management, the browser
  // drops focus to <body> with zero signal to a keyboard user on the
  // highest-stakes page in the funnel. Same unmount-without-focus-restore
  // class already fixed for EmailChanger.tsx and app/settings/page.tsx's
  // confirmHeadingRef/billingHeadingRef.
  const alreadySubscribedHeadingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (alreadySubscribed) alreadySubscribedHeadingRef.current?.focus();
  }, [alreadySubscribed]);

  // alpha-drift-r46-02 (2026-08-19): subscribe() had no cancellation guard
  // at all, unlike every other async flow in this funnel that touches
  // navigation or shared state (app/writing/page.tsx's own `cancelled`
  // closure flag, app/topics/page.tsx, app/settings/accounts/page.tsx's
  // mountedRef, app/auth/callback/page.tsx). A reader could click Subscribe,
  // then navigate away via StepShell's Back button before the fetch
  // resolved -- the in-flight promise kept running, and its resolution
  // (window.location.href to Stripe, or router.push("/writing") on the
  // 503 stub path) still fired on top of wherever they'd since gone. Paired
  // with StepShell's new backDisabled prop below, which closes the trigger
  // for this at the UI level too.
  //
  // alpha-drift-r47-02 (2026-08-20, self-audit + stale-closure-sweep, found
  // independently by two dimensions): this was written as a cleanup-only
  // effect (`useEffect(() => () => { cancelledRef.current = true; }, [])`)
  // -- the EXACT bug shape this same round-46 commit set had just fixed for
  // mountedRef in app/settings/accounts/page.tsx. Under Next's
  // reactStrictMode:true (confirmed in next.config.ts), React dev-mode
  // mounts every component's effects, cleans them up, then mounts again on
  // the same initial render -- the phantom first mount's cleanup flipped
  // this to true, and nothing in the real second mount's effect body ever
  // reset it back to false, since the body did nothing but return a cleanup
  // closure. Stuck permanently true in local dev, every real Subscribe
  // click hit the `if (cancelledRef.current) return;` guards immediately
  // and silently did nothing. Now resets to false in the effect body on
  // mount, matching the already-fixed mountedRef pattern exactly.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  // Same completeness gate /api/stripe/checkout itself enforces server-side
  // (lib/checkout-guards.ts's isProfileComplete) — checked here too so a
  // direct link, cleared localStorage, or a back-button race never gets as
  // far as a real Stripe charge for an incomplete profile. Reusing the real
  // function, not a hand-copied subset of its checks: alpha-drift-r16-05
  // (found+fixed 2026-08-07) — this used to check only firstName+topics,
  // missing the email check the server-side gate requires. A visitor who
  // reached /checkout with those two set but no email (a direct link
  // skipping past /email) saw a fully rendered, payable page; clicking
  // Subscribe then hit the server gate's generic "finish setting up your
  // profile" error with no indication the problem was a missing email and
  // no redirect back to fix it — a self-inflicted dead end from the two
  // gates disagreeing. router.replace, not push (alpha-drift-r16-06): a
  // push here meant Back from /welcome landed right back on this same
  // incomplete state, which immediately bounced forward again -- the
  // browser back button was effectively non-functional at that point in
  // the flow. Matches every other incomplete-state bounce in the funnel
  // (app/welcome/page.tsx, components/onboarding/QuestionStep.tsx,
  // app/you/page.tsx), which already use replace for the same reason.
  useEffect(() => {
    if (!loaded) return;
    if (!isProfileComplete({ firstName: state.firstName, topics: state.topics, email: state.email })) {
      router.replace("/welcome" as never);
    }
  }, [loaded, state, router]);

  async function subscribe() {
    setSubscribing(true);
    setStripeErr(null);
    track("checkout_started", { topics: state.topics?.length ?? 0 });
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: state.email,
          firstName: state.firstName,
          city: state.city,
          topics: state.topics,
        }),
      });
      const data = await res.json();
      if (cancelledRef.current) return;
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
      if (cancelledRef.current) return;
      setSubscribing(false);
      setStripeErr(e instanceof Error ? e.message : "Checkout failed.");
    }
  }

  const firstName = state.firstName || "you";
  const themeId = coerceThemeId(state.theme) ?? "forest";
  const themeLabel = THEMES.find((t) => t.id === themeId)?.label || "Forest";
  const sw = SWATCHES[themeId];

  return (
    <StepShell stepIndex={11} prevPath="email" backDisabled={subscribing}>
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
                Two things pulling at me today. The recruiting signals…
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
            <div className="space-y-3" role="status">
              <p
                ref={alreadySubscribedHeadingRef}
                tabIndex={-1}
                className="alpha-ui text-sm text-center"
                style={{ color: "var(--ink)", outline: "none" }}
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
              // alpha-drift-r23-02 (found+fixed 2026-08-14): --accent-ink
              // fails WCAG AA 4.5:1 against --paper in 12+ themes -- --ink
              // clears every theme, same swap round 21 already made for
              // the admin page's own error text.
              style={{ color: "var(--ink)" }}
            >
              {/* Every server-side error message here already ends in a
                  period (see /api/stripe/checkout's own error strings) --
                  appending another produced a visible ".." */}
              {stripeErr} Try again, or email youngalgy@gmail.com.
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
