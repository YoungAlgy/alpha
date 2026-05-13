"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useOnboarding } from "@/lib/onboarding-state";
import { stepDone, fanfare } from "@/lib/audio";
import { TOPIC_BY_ID } from "@/lib/topics";
import { THEME_BY_ID } from "@/lib/themes";
import type { Issue, UserProfile, TopicId, ThemeId } from "@/lib/types";

function personalizedSteps(
  topics: TopicId[] | undefined,
  theme: ThemeId | undefined,
  firstName: string | undefined
): string[] {
  const topicLabels = (topics || [])
    .map((id) => TOPIC_BY_ID[id]?.label)
    .filter(Boolean) as string[];
  const themeLabel = theme ? THEME_BY_ID[theme]?.label : "Forest";
  const sourceTopic = topicLabels[0] || "your topics";
  const noteTopic = topicLabels[1] || sourceTopic;
  return [
    `Pulling signal on ${sourceTopic}`,
    `Reading sources for ${noteTopic}`,
    firstName
      ? `Drafting your editor's note for ${firstName}`
      : "Drafting your editor's note",
    `Setting the page in ${themeLabel}`,
    "Almost there",
  ];
}

const STORAGE_KEY_ISSUE = "alpha-first-issue";

export default function WritingPage() {
  const router = useRouter();
  const { state, loaded } = useOnboarding();
  const [currentStep, setCurrentStep] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const steps = personalizedSteps(state.topics, state.theme, state.firstName);

  useEffect(() => {
    if (!loaded || startedRef.current) return;
    if (!state.firstName || !state.topics || state.topics.length === 0) {
      router.push("/welcome" as never);
      return;
    }
    startedRef.current = true;

    // Drive fake-but-paced progress UI while the real engine runs.
    const stepTimer = setInterval(() => {
      setCurrentStep((s) => {
        const next = Math.min(s + 1, steps.length - 1);
        if (next !== s) stepDone(next);
        return next;
      });
    }, 4000);

    const profile: UserProfile = {
      firstName: state.firstName,
      city: state.city || "",
      jobBlurb: state.jobBlurb,
      projectBlurb: state.projectBlurb,
      funBlurb: state.funBlurb,
      topics: state.topics,
      theme: state.theme || "forest",
    };

    fetch("/alpha/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { issue: Issue }) => {
        clearInterval(stepTimer);
        setCurrentStep(steps.length - 1);
        localStorage.setItem(STORAGE_KEY_ISSUE, JSON.stringify(data.issue));
        // Mark inbox to play the arrival fanfare exactly once
        localStorage.setItem("alpha-just-generated", "1");
        setDone(true);
        fanfare();
        setTimeout(() => router.push("/inbox" as never), 1200);
      })
      .catch((e) => {
        clearInterval(stepTimer);
        setError(e.message || "Something went wrong.");
      });

    return () => clearInterval(stepTimer);
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
        <div
          className="w-48 mx-auto h-[3px] rounded-full overflow-hidden"
          style={{ background: "var(--rule)" }}
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
          <p
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
                : `Hi ${state.firstName}. Sit tight — about a minute.`}
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
                    color:
                      status === "done"
                        ? "var(--accent-ink)"
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
          <p
            className="alpha-ui text-sm"
            style={{ color: "var(--accent-ink)" }}
          >
            {error} — try refreshing.
          </p>
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
