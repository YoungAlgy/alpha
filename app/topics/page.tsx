"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPICS, SUBTOPICS, PARENT_TOPIC, makeCustomTopic, isCustomTopic, customTopicText, topicLabel, topicEmoji } from "@/lib/topics";
import type { FixedTopicId } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";
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
  // Which broad topic's sub-genre chips are expanded in the picker (e.g. tapping
  // Music opens EDM / hip-hop / indie / country). One open at a time.
  const [expandedParent, setExpandedParent] = useState<string | null>(null);
  // Saving the pool to the DB (signed-in editors). Surface failures instead of
  // navigating away as if it saved.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The signed-in reader's birthday, only to warn when they pick Zodiac without
  // one (that section gets skipped). Mirrors the onboarding "you" step gate.
  const [userBirthday, setUserBirthday] = useState<string | null>(null);

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
          .select("topic_quota, topics, birthday")
          .eq("id", session.user.id)
          .maybeSingle();
        setUserBirthday(row?.birthday ?? null);
        if (row?.topic_quota && typeof row.topic_quota === "number") {
          setTarget(Math.max(5, Math.min(25, row.topic_quota)));
        }
        // Prefer the DB's saved order (the user's ranking) over whatever
        // onboarding localStorage happens to hold on this device.
        if (Array.isArray(row?.topics) && row.topics.length > 0) {
          setPicked(row.topics as TopicId[]);
        }
      } catch {
        // ignore — keep default target
      }
    })();
  }, []);

  // The pool a reader may build. Signed-in users rank a deeper pool: the top
  // `target` are favorites (they fill the letter), the rest are free backups
  // that get swapped in when a favorite has no fresh news. Onboarding stays a
  // clean pick-your-N. Cap matches the engine's poolCap so generation + the DB
  // never see more than we'll ever use.
  const quota = target;
  const poolMax = signedIn ? poolCap(quota) : quota;
  const favCount = Math.min(picked.length, quota);
  const backupCount = Math.max(0, picked.length - quota);

  function toggle(id: TopicId) {
    setPicked((prev) => {
      if (prev.includes(id)) {
        unselect();
        return prev.filter((t) => t !== id);
      }
      if (prev.length >= poolMax) return prev;
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
    if (picked.length >= poolMax) {
      setCustomErr(
        signedIn
          ? `That's your max of ${poolMax}. Remove one to add this.`
          : `You've picked your ${quota}. Remove one to add this.`
      );
      return;
    }
    tap();
    setPicked((prev) => [...prev, id]);
    setCustomText("");
    setCustomErr(null);
  }

  function removeAt(id: TopicId) {
    unselect();
    setPicked((prev) => prev.filter((t) => t !== id));
  }

  // Reorder the pool — order IS the ranking (index 0 = top). Moving an item
  // across the favorites/backups line just changes whether it fills the letter.
  function move(from: number, dir: -1 | 1) {
    const to = from + dir;
    setPicked((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    tap();
  }

  const customPicks = picked.filter(isCustomTopic);

  async function submit() {
    // Onboarding picks exactly the quota; signed-in editors must at least fill
    // their favorites (backups are optional extras).
    const ready = signedIn ? picked.length >= quota : picked.length === quota;
    if (!ready || saving) return;
    setSaveError(null);
    if (signedIn && supabaseConfigured()) {
      // Persist the ranked pool to the DB FIRST. If the write fails, stay on the
      // page with an error instead of navigating away as if it saved (the
      // letter reads topics from the DB, so a silent failure would lose the
      // change). Only mirror to local state + leave once the DB write lands.
      setSaving(true);
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user) {
          const { error } = await sb.from("users").update({ topics: picked }).eq("id", user.id);
          if (error) throw new Error(error.message);
        }
      } catch {
        setSaving(false);
        setSaveError("Couldn't save your topics. Check your connection and try again.");
        return;
      }
      confirm();
      update({ topics: picked });
      router.push("/settings" as never);
      return;
    }
    confirm();
    update({ topics: picked });
    router.push("/fun" as never);
  }

  const onbRemaining = quota - picked.length;
  const favRemaining = quota - favCount;
  const ready = signedIn ? picked.length >= quota : picked.length === quota;

  return (
    <StepShell stepIndex={7} prevPath="focus">
      <div className="space-y-8">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            {!signedIn && quota === DEFAULT_TARGET
              ? "Pick five things you want to stay sharp on."
              : signedIn
                ? "Rank what you want to stay sharp on."
                : `Pick ${quota} things you want to stay sharp on.`}
          </h1>
          <p
            className="alpha-ui text-sm md:text-base"
            style={{ color: "var(--ink-soft)" }}
          >
            {signedIn
              ? `Your top ${quota} fill your letter each week. Add backups below them — we swap one in when a favorite has no fresh news that week.`
              : "You can swap any of these later, anytime."}
          </p>
        </div>

        <div
          role="group"
          aria-label={signedIn ? `Choose up to ${poolMax} topics` : `Choose ${quota} topics`}
          className="grid grid-cols-2 md:grid-cols-3 gap-3"
        >
          {/* Child sub-genres don't get their own card; they appear as chips
              under their parent (e.g. EDM lives under Music). */}
          {TOPICS.filter((t) => !PARENT_TOPIC[t.id]).map((t) => {
            const childIds = (SUBTOPICS[t.id] ?? []) as FixedTopicId[];
            const hasSub = childIds.length > 0;
            const groupIds = [t.id, ...childIds];
            const groupPicked = groupIds.filter((id) => picked.includes(id as TopicId)).length;
            const isPicked = hasSub ? groupPicked > 0 : picked.includes(t.id);
            const isExpanded = expandedParent === t.id;
            // The broad-parent card only opens chips; it isn't itself a pick, so
            // it never hits the limit. Normal cards do.
            const atLimit = !hasSub && picked.length >= poolMax && !isPicked;
            return (
              <Fragment key={t.id}>
                <button
                  type="button"
                  onClick={() => (hasSub ? setExpandedParent(isExpanded ? null : t.id) : toggle(t.id))}
                  disabled={atLimit}
                  aria-pressed={hasSub ? undefined : isPicked}
                  aria-expanded={hasSub ? isExpanded : undefined}
                  aria-label={hasSub ? `${t.label}, refine into a style` : t.label}
                  className="topic-card text-left p-4 rounded-lg"
                  data-picked={isPicked}
                  data-at-limit={atLimit}
                  style={{
                    background: isPicked ? "var(--callout-bg)" : "transparent",
                    border: `1.5px solid ${isPicked ? "var(--accent)" : "var(--rule)"}`,
                    opacity: atLimit ? 0.4 : 1,
                    cursor: atLimit ? "not-allowed" : "pointer",
                    color: "var(--ink)",
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="alpha-display text-base font-semibold leading-tight">
                      {t.emoji} {t.label}
                    </span>
                    <span className="alpha-mono shrink-0" style={{ color: "var(--accent-ink)" }}>
                      {hasSub ? `${groupPicked > 0 ? `${groupPicked} ` : ""}${isExpanded ? "▴" : "▾"}` : isPicked ? "✓" : ""}
                    </span>
                  </div>
                  <p className="alpha-ui text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>
                    {hasSub ? "Pick your style, or all of it." : t.blurb}
                  </p>
                </button>

                {hasSub && isExpanded && (
                  <div
                    className="col-span-full -mt-1 mb-1 p-3 rounded-lg"
                    style={{ background: "var(--paper-deep)", border: "1px solid var(--rule)" }}
                  >
                    <p className="alpha-ui text-xs mb-2" style={{ color: "var(--ink-soft)" }}>
                      Each counts as one topic. &quot;All {t.label.toLowerCase()}&quot; gives you the whole category.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {groupIds.map((id) => {
                        const chipPicked = picked.includes(id as TopicId);
                        const chipLabel = id === t.id ? `All ${t.label.toLowerCase()}` : topicLabel(id);
                        const chipAtLimit = picked.length >= poolMax && !chipPicked;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => toggle(id as TopicId)}
                            disabled={chipAtLimit}
                            aria-pressed={chipPicked}
                            className="alpha-ui text-sm px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
                            style={{
                              background: chipPicked ? "var(--callout-bg)" : "transparent",
                              border: `1.5px solid ${chipPicked ? "var(--accent)" : "var(--rule)"}`,
                              color: "var(--ink)",
                              opacity: chipAtLimit ? 0.4 : 1,
                              cursor: chipAtLimit ? "not-allowed" : "pointer",
                            }}
                          >
                            {id === t.id ? "" : `${topicEmoji(id)} `}{chipLabel}
                            {chipPicked && <span style={{ color: "var(--accent-ink)" }}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>

        {/* Your own thing — a hyper-specific custom topic */}
        <div className="space-y-3 pt-2">
          <div>
            <h2 className="alpha-display text-lg font-semibold">Or add your own thing</h2>
            <p className="alpha-ui text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>
              Get specific. &quot;Crypto regulation in Asia,&quot; &quot;Formula 1 aero,&quot;
              &quot;AI in radiology.&quot; We&apos;ll hunt the real signal on it for you three times a week.
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
                    onClick={() => removeAt(id)}
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
              disabled={picked.length >= poolMax}
              aria-label="Add your own topic"
              className="flex-1 alpha-ui text-base bg-transparent border-b py-2 focus:outline-none focus:border-current placeholder:opacity-40"
              style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
            />
            <button
              type="submit"
              disabled={picked.length >= poolMax || !customText.trim()}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{
                color: "var(--accent-ink)",
                opacity: picked.length >= poolMax || !customText.trim() ? 0.4 : 1,
                cursor: picked.length >= poolMax || !customText.trim() ? "not-allowed" : "pointer",
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

        {/* Your lineup — ranked favorites + backups (signed-in editing only) */}
        {signedIn && picked.length > 0 && (
          <div className="space-y-3 pt-2">
            <div>
              <h2 className="alpha-display text-lg font-semibold">Your lineup</h2>
              <p className="alpha-ui text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>
                Order is the ranking. Move things up or down. The top {quota} fill
                your letter; anything below the line is a backup.
              </p>
            </div>

            <div role="list" className="space-y-2">
              {picked.map((id, i) => {
                const isFav = i < quota;
                const showLine = i === quota; // first backup row
                return (
                  <div key={id}>
                    {showLine && (
                      <div className="flex items-center gap-3 py-2" aria-hidden="true">
                        <div className="flex-1 border-t" style={{ borderColor: "var(--rule)" }} />
                        <span
                          className="alpha-ui text-[11px] uppercase tracking-wide"
                          style={{ color: "var(--ink-soft)" }}
                        >
                          Backups
                        </span>
                        <div className="flex-1 border-t" style={{ borderColor: "var(--rule)" }} />
                      </div>
                    )}
                    <div
                      role="listitem"
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                      style={{
                        background: isFav ? "var(--callout-bg)" : "transparent",
                        border: `1.5px solid ${isFav ? "var(--accent)" : "var(--rule)"}`,
                        opacity: isFav ? 1 : 0.85,
                      }}
                    >
                      <span
                        className="alpha-mono text-xs w-5 text-center shrink-0"
                        style={{ color: isFav ? "var(--accent-ink)" : "var(--ink-soft)" }}
                        aria-hidden="true"
                      >
                        {i + 1}
                      </span>
                      <span className="alpha-display text-sm font-semibold flex-1 min-w-0 truncate">
                        {topicEmoji(id)} {topicLabel(id)}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          aria-label={`Move ${topicLabel(id)} up`}
                          className="alpha-mono text-sm px-1.5 leading-none"
                          style={{ color: "var(--ink-soft)", opacity: i === 0 ? 0.25 : 1, cursor: i === 0 ? "default" : "pointer" }}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => move(i, 1)}
                          disabled={i === picked.length - 1}
                          aria-label={`Move ${topicLabel(id)} down`}
                          className="alpha-mono text-sm px-1.5 leading-none"
                          style={{ color: "var(--ink-soft)", opacity: i === picked.length - 1 ? 0.25 : 1, cursor: i === picked.length - 1 ? "default" : "pointer" }}
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => removeAt(id)}
                          aria-label={`Remove ${topicLabel(id)}`}
                          className="alpha-mono text-sm px-1.5 leading-none"
                          style={{ color: "var(--accent-ink)" }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {backupCount === 0 && favRemaining === 0 && picked.length < poolMax && (
              <p className="alpha-ui text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>
                Want a safety net? Add a few more above and they become backups,
                free. We only ever send you {quota}.
              </p>
            )}
          </div>
        )}

        {signedIn && picked.includes("zodiac" as TopicId) && !userBirthday && (
          <p className="alpha-ui text-xs" role="status" aria-live="polite" style={{ color: "var(--accent-ink)" }}>
            Zodiac needs your birthday to read your sign. Add it in Settings under Your details, or that section gets skipped.
          </p>
        )}

        <div className="sticky bottom-4 flex items-center justify-between gap-4 pt-4">
          <span
            role="status"
            aria-live="polite"
            className="alpha-ui text-sm"
            style={{ color: saveError ? "var(--accent-ink)" : "var(--ink-soft)" }}
          >
            {saveError
              ? saveError
              : signedIn
                ? favRemaining > 0
                  ? `Pick ${favRemaining} more to fill your letter`
                  : `${quota} favorites${backupCount > 0 ? ` · ${backupCount} backup${backupCount > 1 ? "s" : ""}` : ""} · ready`
                : onbRemaining > 0
                  ? `Pick ${onbRemaining} more`
                  : `${quota} of ${quota}, ready to continue`}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={!ready || saving}
            className="alpha-button"
            style={{
              opacity: ready && !saving ? 1 : 0.3,
              cursor: ready && !saving ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "Saving…" : signedIn ? "Save" : "Continue →"}
          </button>
        </div>
      </div>
    </StepShell>
  );
}
