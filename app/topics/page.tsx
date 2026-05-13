"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPICS } from "@/lib/topics";
import { tap, unselect, confirm } from "@/lib/audio";
import type { TopicId } from "@/lib/types";

const TARGET = 5;

export default function TopicsPage() {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();
  const [picked, setPicked] = useState<TopicId[]>([]);

  useEffect(() => {
    if (loaded && state.topics) setPicked(state.topics);
  }, [loaded, state.topics]);

  function toggle(id: TopicId) {
    setPicked((prev) => {
      if (prev.includes(id)) {
        unselect();
        return prev.filter((t) => t !== id);
      }
      if (prev.length >= TARGET) return prev;
      tap();
      return [...prev, id];
    });
  }

  function submit() {
    if (picked.length !== TARGET) return;
    confirm();
    update({ topics: picked });
    router.push("/theme" as never);
  }

  const remaining = TARGET - picked.length;

  return (
    <StepShell stepIndex={6} prevPath="focus">
      <div className="space-y-8">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            Pick five things you want to stay sharp on.
          </h1>
          <p
            className="alpha-ui text-sm md:text-base"
            style={{ color: "var(--ink-soft)" }}
          >
            You can swap any of these later, anytime.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {TOPICS.map((t) => {
            const isPicked = picked.includes(t.id);
            const atLimit = picked.length >= TARGET && !isPicked;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.id)}
                disabled={atLimit}
                className="topic-card text-left p-4 rounded-lg"
                data-picked={isPicked}
                data-at-limit={atLimit}
                style={{
                  background: isPicked ? "var(--callout-bg)" : "transparent",
                  border: `1.5px solid ${
                    isPicked ? "var(--accent)" : "var(--rule)"
                  }`,
                  opacity: atLimit ? 0.4 : 1,
                  cursor: atLimit ? "not-allowed" : "pointer",
                  color: "var(--ink)",
                }}
              >
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="alpha-display text-base font-semibold leading-tight">
                    {t.emoji} {t.label}
                  </span>
                  {isPicked && (
                    <span
                      className="alpha-mono"
                      style={{ color: "var(--accent-ink)" }}
                    >
                      ✓
                    </span>
                  )}
                </div>
                <p
                  className="alpha-ui text-xs leading-snug"
                  style={{ color: "var(--ink-soft)" }}
                >
                  {t.blurb}
                </p>
              </button>
            );
          })}
        </div>

        <div className="sticky bottom-4 flex items-center justify-between gap-4 pt-4">
          <span
            className="alpha-ui text-sm"
            style={{ color: "var(--ink-soft)" }}
          >
            {remaining > 0
              ? `Pick ${remaining} more`
              : `5 of 5 — ready to continue`}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={picked.length !== TARGET}
            className="alpha-button"
            style={{
              opacity: picked.length === TARGET ? 1 : 0.3,
              cursor: picked.length === TARGET ? "pointer" : "not-allowed",
            }}
          >
            Continue →
          </button>
        </div>
      </div>
    </StepShell>
  );
}
