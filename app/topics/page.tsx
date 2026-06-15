"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPICS, makeCustomTopic, isCustomTopic, customTopicText, topicLabel } from "@/lib/topics";
import { tap, unselect, confirm } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import type { TopicId } from "@/lib/types";

const DEFAULT_TARGET = 5; // unsigned (first-onboarding) flow always picks 5

export default function TopicsPage() {
  const router = useRouter();
  const { state, update, loaded } = useOnboarding();
  const [picked, setPicked] = useState<TopicId[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  // Quota = how many topics this user is currently paid up for. 5 = base,
  // 10/15/20/25 = +1/+2/+3/+4 add-ons. Unsigned users get the default 5.
  const [target, setTarget] = useState<number>(DEFAULT_TARGET);
  // "Your own thing" — free-text custom topics (stored as custom:<text>).
  const [customText, setCustomText] = useState("");
  const [customErr, setCustomErr] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && state.topics) setPicked(state.topics);
  }, [loaded, state.topics]);

  // Edit-from-settings detection: signed-in users go back to /settings on save.
  // Also fetch their topic_quota so the picker matches what they've paid for.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        setSignedIn(true);
        const { data: row } = await sb
          .from("users")
          .select("topic_quota")
          .eq("id", session.user.id)
          .maybeSingle();
        if (row?.topic_quota && typeof row.topic_quota === "number") {
          setTarget(Math.max(5, Math.min(25, row.topic_quota)));
        }
      } catch {
        // ignore — keep default target
      }
    })();
  }, []);

  function toggle(id: TopicId) {
    setPicked((prev) => {
      if (prev.includes(id)) {
        unselect();
        return prev.filter((t) => t !== id);
      }
      if (prev.length >= target) return prev;
      tap();
      return [...prev, id];
    });
  }

  function addCustom() {
    const id = makeCustomTopic(customText);
    if (!id) {
      setCustomErr("Give it a couple of words. The more specific, the better.");
      return;
    }
    const wanted = customTopicText(id).toLowerCase();
    const dupe =
      picked.some((p) => isCustomTopic(p) && customTopicText(p).toLowerCase() === wanted) ||
      picked.some((p) => !isCustomTopic(p) && topicLabel(p).toLowerCase() === wanted);
    if (dupe) {
      setCustomErr("You've already got that one.");
      return;
    }
    if (picked.length >= target) {
      setCustomErr(`You've picked your ${target}. Remove one to add this.`);
      return;
    }
    tap();
    setPicked((prev) => [...prev, id]);
    setCustomText("");
    setCustomErr(null);
  }

  function removeCustom(id: TopicId) {
    unselect();
    setPicked((prev) => prev.filter((t) => t !== id));
  }

  const customPicks = picked.filter(isCustomTopic);

  async function submit() {
    if (picked.length !== target) return;
    confirm();
    update({ topics: picked });
    if (signedIn && supabaseConfigured()) {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user) {
          await sb.from("users").update({ topics: picked }).eq("id", user.id);
        }
      } catch {
        // best-effort
      }
      router.push("/settings" as never);
      return;
    }
    router.push("/fun" as never);
  }

  const remaining = target - picked.length;

  return (
    <StepShell stepIndex={7} prevPath="focus">
      <div className="space-y-8">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            {target === DEFAULT_TARGET
              ? "Pick five things you want to stay sharp on."
              : `Pick ${target} things you want to stay sharp on.`}
          </h1>
          <p
            className="alpha-ui text-sm md:text-base"
            style={{ color: "var(--ink-soft)" }}
          >
            You can swap any of these later, anytime.
          </p>
        </div>

        <div
          role="group"
          aria-label={`Choose ${target} topics`}
          className="grid grid-cols-2 md:grid-cols-3 gap-3"
        >
          {TOPICS.map((t) => {
            const isPicked = picked.includes(t.id);
            const atLimit = picked.length >= target && !isPicked;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.id)}
                disabled={atLimit}
                aria-pressed={isPicked}
                aria-label={t.label}
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

        {/* Your own thing — a hyper-specific custom topic */}
        <div className="space-y-3 pt-2">
          <div>
            <h2 className="alpha-display text-lg font-semibold">Or add your own thing</h2>
            <p className="alpha-ui text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>
              Get specific. &ldquo;Crypto regulation in Asia,&rdquo; &ldquo;Formula 1 aero,&rdquo;
              &ldquo;AI in radiology.&rdquo; We&apos;ll hunt the real signal on it for you every week.
            </p>
          </div>

          {customPicks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {customPicks.map((id) => (
                <span
                  key={id}
                  className="alpha-ui text-sm px-3 py-1.5 rounded-full inline-flex items-center gap-2"
                  style={{ background: "var(--callout-bg)", color: "var(--ink)", border: "1.5px solid var(--accent)" }}
                >
                  ✨ {topicLabel(id)}
                  <button
                    type="button"
                    onClick={() => removeCustom(id)}
                    aria-label={`Remove ${topicLabel(id)}`}
                    className="alpha-mono leading-none"
                    style={{ color: "var(--accent-ink)" }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              addCustom();
            }}
            className="flex items-center gap-3"
          >
            <input
              value={customText}
              onChange={(e) => {
                setCustomText(e.target.value);
                if (customErr) setCustomErr(null);
              }}
              maxLength={80}
              placeholder="e.g. crypto trends in Asia"
              disabled={picked.length >= target}
              aria-label="Add your own topic"
              className="flex-1 alpha-ui text-base bg-transparent border-b py-2 focus:outline-none focus:border-current placeholder:opacity-40"
              style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
            />
            <button
              type="submit"
              disabled={picked.length >= target || !customText.trim()}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{
                color: "var(--accent-ink)",
                opacity: picked.length >= target || !customText.trim() ? 0.4 : 1,
                cursor: picked.length >= target || !customText.trim() ? "not-allowed" : "pointer",
              }}
            >
              Add
            </button>
          </form>
          {customErr && (
            <p role="alert" aria-live="assertive" className="alpha-ui text-xs" style={{ color: "var(--accent-ink)" }}>
              {customErr}
            </p>
          )}
        </div>

        <div className="sticky bottom-4 flex items-center justify-between gap-4 pt-4">
          <span
            role="status"
            aria-live="polite"
            className="alpha-ui text-sm"
            style={{ color: "var(--ink-soft)" }}
          >
            {remaining > 0
              ? `Pick ${remaining} more`
              : `${target} of ${target}, ready to continue`}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={picked.length !== target}
            className="alpha-button"
            style={{
              opacity: picked.length === target ? 1 : 0.3,
              cursor: picked.length === target ? "pointer" : "not-allowed",
            }}
          >
            Continue →
          </button>
        </div>
      </div>
    </StepShell>
  );
}
