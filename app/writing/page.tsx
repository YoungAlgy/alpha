"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "@/lib/onboarding-state";
import { stepDone, fanfare } from "@/lib/audio";
import { track } from "@/lib/analytics";
import { topicLabel } from "@/lib/topics";
import { THEME_BY_ID } from "@/lib/themes";
import type { Issue, UserProfile, TopicId, ThemeId } from "@/lib/types";

function personalizedSteps(
  topics: TopicId[] | undefined,
  theme: ThemeId | undefined,
  firstName: string | undefined
): string[] {
  const topicLabels = (topics || [])
    .map((id) => topicLabel(id))
    .filter(Boolean) as string[];
  const themeLabel = theme ? THEME_BY_ID[theme]?.label : "Forest";
  // One "reading" beat per chosen topic (named, so it feels like real work on
  // THEIR topics), then the note + theme + a final hold. More, finer steps +
  // a slower cadence keep the progress bar moving through the full ~45s cold
  // generation instead of stalling at 80% on "Almost there" for half the wait.
  const shown = topicLabels.slice(0, 4);
  const steps: string[] = shown.map((l) => `Reading the latest on ${l}`);
  if (steps.length === 0) steps.push("Reading the latest on your topics");
  if (topicLabels.length > 4) {
    steps.push(`Pulling signal on ${topicLabels.length - 4} more`);
  }
  steps.push(
    firstName ? `Drafting your editor's note, ${firstName}` : "Drafting your editor's note"
  );
  steps.push(`Setting the page in ${themeLabel}`);
  steps.push("Almost ready");
  return steps;
}

const STORAGE_KEY_ISSUE = "alpha-first-issue";

export default function WritingPage() {
  const router = useRouter();
  const { state, loaded, reset } = useOnboarding();
  const [currentStep, setCurrentStep] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const steps = personalizedSteps(state.topics, state.theme, state.firstName);

  const [showEscape, setShowEscape] = useState(false);

  useEffect(() => {
    if (!loaded || startedRef.current) return;
    if (!state.firstName || !state.topics || state.topics.length === 0) {
      // alpha-drift-r16-06 (found+fixed 2026-08-07): replace, not push --
      // see app/checkout/page.tsx's matching gate for the full back-button-
      // trap reasoning. A push here meant Back from /welcome landed right
      // back on this same incomplete state, which immediately bounced
      // forward again.
      router.replace("/welcome" as never);
      return;
    }
    startedRef.current = true;

    // After 90s the generation is unusually slow — give them a way out
    const escapeTimer = setTimeout(() => setShowEscape(true), 90000);

    // Drive fake-but-paced progress UI while the real engine runs. ~6s cadence
    // over ~8 steps spans ~42s — matched to a cold first-letter generation, so
    // the bar keeps climbing instead of stalling. A fast (cached) generation
    // short-circuits via `done`, which jumps the bar to 100%.
    const stepTimer = setInterval(() => {
      setCurrentStep((s) => {
        const next = Math.min(s + 1, steps.length - 1);
        if (next !== s) stepDone(next);
        return next;
      });
    }, 6000);

    const profile: UserProfile = {
      firstName: state.firstName,
      city: state.city || "",
      jobBlurb: state.jobBlurb,
      projectBlurb: state.projectBlurb,
      funBlurb: state.funBlurb,
      // Carry birthday + gender so the PAID first letter tones correctly and the
      // zodiac section (which onboarding just forced a birthday for) actually
      // ships. Without these the first letter falls back to the neutral voice and
      // silently drops zodiac until the cron self-heals from the DB on send 2.
      birthday: state.birthday,
      gender: state.gender,
      topics: state.topics,
      theme: state.theme || "forest",
      email: state.email,
    };

    // Stripe Checkout drops the user here as /writing?session_id=cs_... — pass
    // it to the generate API so it can confirm the first letter was paid for.
    //
    // alpha-drift-r32-03 (2026-08-14, considered + rejected a URL-bar scrub
    // here): unlike auth/callback's `code`, this page's "Try again" button
    // (below) calls window.location.reload() -- a REAL navigation that
    // re-reads session_id from window.location.search on the fresh load, not
    // just from this closure. Scrubbing the query string the way
    // auth/callback does would make that reload lose session_id entirely,
    // and for the first-time/not-yet-signed-in purchaser this page exists
    // for, that's the ONLY thing that gets them past /api/generate's payment
    // gate (verifyPaid in app/api/generate/route.ts 402s with no sessionId
    // and no active session) -- "Try again" would wrongly bounce an
    // already-paid customer to /checkout. Fixed at the redaction layer
    // instead (lib/analytics.ts's redactValue now strips session_id= from
    // any captured property, including autocapture's $current_url), which
    // closes the actual leak-to-PostHog without touching page behavior.
    const sessionId =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("session_id") || undefined
        : undefined;

    // Guards every setState call below against firing after this effect's
    // cleanup has run (back button, fast re-render) -- without it a slow/
    // retried generate call whose response arrives post-unmount still writes
    // state on a torn-down component and can duplicate a no-longer-needed
    // request's side effects (the magic-link redirect in particular).
    let cancelled = false;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // alpha-drift-r22-04 (found+fixed 2026-08-14): a 400 here can only mean
    // BodySchema.parse() rejected the profile -- and for an already-charged
    // subscriber (topics/firstName/email are already gated before checkout,
    // so they can't be the cause), the only fields left that carry extra
    // validation are the two demographic ones onboarding never re-checks
    // itself: birthday and gender. /you now gates on the same rule
    // server-side, so this should be unreachable going forward, but a stale
    // pre-fix localStorage value could still carry a bad one in. Self-heal
    // ONCE by dropping them and retrying, rather than stranding a paid
    // customer -- who has no session yet, since sign-in only happens inside
    // a SUCCESSFUL generate call -- on a 400 that will repeat forever.
    let demographicsStripped = false;

    // Retry once with a backoff if the first attempt fails. The engine can
    // hiccup on Brave rate-limit / a flaky Claude call / a cold Worker start
    // (this app has run on Cloudflare Workers, not AWS/Vercel Lambda, since
    // 2026-08-05); these are usually transient. After two failures we
    // surface the recovery UI so the user isn't stranded staring at a
    // writing animation.
    async function attemptGenerate(retriesLeft: number): Promise<void> {
      try {
        const requestProfile = demographicsStripped
          ? { ...profile, birthday: undefined, gender: undefined }
          : profile;
        const r = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: requestProfile, sessionId }),
        });
        if (cancelled) return;
        if (r.status === 402) {
          // Payment gate — they reached /writing without a paid session.
          // Send them to checkout rather than the generic retry card.
          clearInterval(stepTimer);
          router.push("/checkout" as never);
          return;
        }
        if (
          r.status === 400 &&
          !demographicsStripped &&
          (profile.birthday || profile.gender)
        ) {
          console.warn("[writing] generate 400'd, retrying once without birthday/gender");
          demographicsStripped = true;
          retryTimer = setTimeout(() => attemptGenerate(retriesLeft), 0);
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { issue: Issue; signedIn?: boolean };
        if (cancelled) return;
        clearInterval(stepTimer);
        setCurrentStep(steps.length - 1);
        localStorage.setItem(STORAGE_KEY_ISSUE, JSON.stringify(data.issue));
        localStorage.setItem("alpha-just-generated", "1");
        setDone(true);
        fanfare();
        // Funnel terminal event — the moment a paid subscriber's first letter
        // lands. The conversion the whole funnel exists to produce.
        track("letter_generated");
        // Auto sign-in after checkout: /api/generate already verified the
        // sign-in token server-side and set the Supabase session cookie
        // directly on that response (found in review 2026-08-06 -- the old
        // version shipped the raw token in this JSON body and navigated the
        // browser to it, a live, fully-authenticating bearer credential
        // sitting in a JS-readable fetch response). By the time this fetch()
        // resolved, the cookie is already set -- no separate navigation
        // through a token URL is needed, just go to /inbox. If verifyOtp
        // failed server-side (data.signedIn false, rare), the reader still
        // lands on /inbox same as always; they just aren't signed in yet and
        // can use the normal sign-in flow.
        finishTimer = setTimeout(() => {
          if (cancelled) return;
          // Wipe onboarding answers (name, email, birthday, etc.) now that
          // the account exists and the letter is generated — this is a
          // shared/library-computer risk otherwise (next visitor's forms and
          // even /signin's email field would silently prefill from it).
          reset();
          router.push("/inbox" as never);
        }, 1200);
      } catch (e) {
        if (cancelled) return;
        if (retriesLeft > 0) {
          console.warn(`[writing] generate failed, retrying once:`, e);
          // 4-second backoff before retry — long enough for transient cold
          // starts to recover.
          retryTimer = setTimeout(() => attemptGenerate(retriesLeft - 1), 4000);
          return;
        }
        clearInterval(stepTimer);
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    }
    attemptGenerate(1);

    return () => {
      cancelled = true;
      clearInterval(stepTimer);
      clearTimeout(escapeTimer);
      clearTimeout(finishTimer);
      clearTimeout(retryTimer);
    };
    // steps.length (read inside the interval closure) and reset (a stable
    // useCallback with [] deps) are deliberately left out: startedRef already
    // gates this effect to run its logic once, so neither belongs in the trigger list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, state, router]);

  const pct = Math.min(100, Math.round(((currentStep + (done ? 1 : 0)) / steps.length) * 100));
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 relative overflow-hidden">
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          width: "min(70vmin, 480px)",
          height: "min(70vmin, 480px)",
          background:
            "radial-gradient(circle at center, var(--accent) 0%, transparent 60%)",
          opacity: done ? 0.18 : 0.1,
          filter: "blur(40px)",
          transition: "opacity 600ms ease",
        }}
      />
      <div className="w-full max-w-md text-center space-y-12 relative z-10">
        <div className="flex justify-center">
          <span
            className="alpha-display text-7xl md:text-8xl font-bold inline-block"
            style={{
              color: "var(--accent-ink)",
              animation: done
                ? "alpha-writing-settle 700ms ease-out forwards"
                : "alpha-writing-breathe 3200ms ease-in-out infinite",
              display: "inline-block",
            }}
          >
            α
          </span>
        </div>
        {/* alpha-drift-r23-08 (found+fixed 2026-08-14): this whole ~45s
            automated wait screen had zero ARIA live region and the bar
            carried no role=progressbar -- unlike ProgressDots.tsx, used one
            step earlier in the same funnel, which already gets this right.
            role=progressbar + aria-value* here so assistive tech can query
            real progress on demand, mirroring that component's pattern. */}
        <div
          className="w-48 mx-auto h-[3px] rounded-full overflow-hidden"
          style={{ background: "var(--rule)" }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={done ? "Your letter is ready." : `Writing your letter, ${pct}% done`}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "var(--accent)",
              transition: "width 600ms ease",
            }}
          />
        </div>
        <div>
          {/* aria-live="polite" so the ONE transition that actually matters
              -- writing to ready -- gets announced once, without narrating
              every 6s step change (which would just be noise over a 45s wait). */}
          <p
            role="status"
            aria-live="polite"
            className="alpha-display text-2xl md:text-3xl font-bold tracking-tight mb-2"
          >
            {done ? "Your letter is ready." : "Writing your letter…"}
          </p>
          {state.firstName && (
            <p
              className="alpha-ui text-sm"
              style={{ color: "var(--ink-soft)" }}
            >
              {done
                ? "Opening it now."
                : `Hi ${state.firstName}. Sit tight. About a minute.`}
            </p>
          )}
        </div>
        <ul className="text-left space-y-3">
          {steps.map((label, i) => {
            const status =
              done || i < currentStep
                ? "done"
                : i === currentStep
                ? "active"
                : "pending";
            return (
              <li key={i} className="flex items-start gap-3 alpha-ui text-sm">
                <span
                  className="inline-block mt-1"
                  style={{
                    width: 14,
                    height: 14,
                    // alpha-drift-r23-02 (found+fixed 2026-08-14):
                    // --accent-ink fails WCAG AA 4.5:1 against --paper in
                    // 12+ themes -- --ink clears every theme.
                    color:
                      status === "done"
                        ? "var(--ink)"
                        : "var(--ink-soft)",
                  }}
                >
                  {status === "done"
                    ? "✓"
                    : status === "active"
                    ? "◌"
                    : "·"}
                </span>
                <span
                  style={{
                    color:
                      status === "done"
                        ? "var(--ink)"
                        : status === "active"
                        ? "var(--ink)"
                        : "var(--ink-soft)",
                    fontWeight: status === "active" ? 600 : 400,
                  }}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
        {error && (
          <div
            role="alert"
            className="alpha-card p-5 text-left space-y-3"
            style={{
              borderColor: "var(--rule)",
              borderRadius: "var(--radius-card)",
              background: "var(--paper-deep)",
            }}
          >
            <p className="alpha-display text-base font-semibold">
              Hiccup writing your first letter.
            </p>
            {/* alpha-drift-r35-05 (2026-08-14): "the engine" is internal
                machinery talk -- the funnel around this card personifies a
                writer ("Writing your letter…", "Drafting your editor's
                note"), and "the engine" reads like a log line that leaked
                into the UI at the exact moment (right after a real charge)
                a reader's trust matters most. Kept the human frame. */}
            <p
              className="alpha-ui text-sm leading-relaxed"
              style={{ color: "var(--ink-soft)" }}
            >
              Your subscription is active. Stripe got the payment fine. The
              writing just hit a snag. Try again now, or head to your inbox
              and it'll show up there in a few minutes.
            </p>
            <p
              className="alpha-ui text-xs leading-relaxed"
              style={{ color: "var(--ink-soft)", opacity: 0.7 }}
            >
              Technical: {error}
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="alpha-button"
              >
                Try again →
              </button>
              {/* alpha-drift-r59-04 (2026-08-20, accessibility-resweep-
                  newer-code-round-7): under the WCAG 2.5.8 24px
                  touch-target minimum, this app's actual failure/retry UI. */}
              <button
                type="button"
                onClick={() => router.push("/inbox" as never)}
                className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
                style={{ color: "var(--ink-soft)" }}
              >
                Go to inbox
              </button>
              <a
                href="mailto:youngalgy@gmail.com?subject=alpha%20generate%20failure"
                className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
                style={{ color: "var(--ink-soft)" }}
              >
                Email support
              </a>
            </div>
          </div>
        )}
        {!error && showEscape && !done && (
          <div
            className="alpha-ui text-sm space-y-2"
            style={{ color: "var(--ink-soft)" }}
          >
            {/* alpha-drift-r35-05/06 (2026-08-14): same voice fix as the
                error card above, plus "/inbox" (a route path) was reading as
                a word in reader-facing prose -- no other copy in the app
                does this. */}
            <p>Taking longer than usual. We're still writing it in the background. Your letter will land in your inbox when it's ready.</p>
            {/* alpha-drift-r59-04 (2026-08-20, accessibility-resweep-newer-
                code-round-7): same touch-target fix as the error card's
                controls above. */}
            <button
              type="button"
              onClick={() => router.push("/inbox" as never)}
              className="underline underline-offset-4 py-2 -my-2"
              // alpha-drift-r23-02 (found+fixed 2026-08-14): --accent-ink
              // fails WCAG AA 4.5:1 against --paper in 12+ themes -- --ink
              // clears every theme.
              style={{ color: "var(--ink)" }}
            >
              Wait on the inbox →
            </button>
          </div>
        )}
      </div>
      <style>{`
        @keyframes alpha-writing-breathe {
          0%, 100% { transform: scale(1) rotate(-1deg); opacity: 0.78; }
          50% { transform: scale(1.08) rotate(1deg); opacity: 1; }
        }
        @keyframes alpha-writing-settle {
          0%   { transform: scale(1.08); opacity: 1; }
          60%  { transform: scale(1.18); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </main>
  );
}
