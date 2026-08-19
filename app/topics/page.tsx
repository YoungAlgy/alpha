"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { TOPICS, SUBTOPICS, PARENT_TOPIC, makeCustomTopic, isCustomTopic, customTopicText, topicLabel, topicEmoji, suggestCuratedTopic } from "@/lib/topics";
import type { FixedTopicId } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";
import { tap, unselect, confirm } from "@/lib/audio";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import type { TopicId } from "@/lib/types";
import { clampQuota } from "@/lib/types";

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
  // alpha-drift-r32-02 (2026-08-14): move()/removeAt() only ever changed
  // visual state (color/opacity/position) -- a screen reader user got no
  // feedback at all that a reorder or remove even happened, unlike this
  // page's own custom-topic error (role="alert") and Zodiac warning
  // (role="status"). One shared live region announces the result of both.
  const [announcement, setAnnouncement] = useState("");
  // alpha-drift-r19-01 (found+fixed 2026-08-07): the signed-in hydrate below
  // is a real network round trip with no loading gate. For a base-tier
  // (5-topic) subscriber revisiting Settings -> Change topics on the SAME
  // device they onboarded on, onboarding's own localStorage prefill
  // (picked=5, just below) can already satisfy `ready` in submit() before
  // this hydrate flips `signedIn` true -- so a click in that window takes
  // the UNSIGNED branch: never POSTs the edit (silently never persisted, no
  // error shown) and pushes an already-onboarded, paying subscriber into
  // /fun (onboarding) instead of back to /settings. Starts true only when
  // there's no hydrate to wait for at all (supabaseConfigured() false).
  const [topicsHydrated, setTopicsHydrated] = useState(!supabaseConfigured());
  // alpha-drift-r19-01: submit()'s re-entry guard used plain React state
  // (saving), the same race this codebase's own sibling save actions
  // document and fix elsewhere (ProfileEditor.tsx's saveInFlight, settings/
  // page.tsx's confirmInFlight/resumeInFlight/deleteInFlight) -- a
  // sub-16ms double click or a duplicate touch event can fire two
  // concurrent POST /api/account/topics requests before React flushes the
  // disabled prop. A synchronous ref latch closes the window state can't.
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (loaded && state.topics) setPicked(state.topics);
  }, [loaded, state.topics]);

  // Edit-from-settings detection: signed-in users go back to /settings on save.
  // Also fetch their topic_quota so the picker matches what they've paid for.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (cancelled) return;
        if (!session) return;
        const { data: row } = await sb
          .from("users")
          .select("topic_quota, topics, birthday")
          .eq("id", session.user.id)
          .maybeSingle();
        if (cancelled) return;
        // Flip signedIn in the same batch as the row's picked/target values below
        // (not right after getSession) so submit()'s signedIn check never sees a
        // render where signedIn is true but `picked` still holds stale
        // localStorage topics -- that window let a stale POST clobber a newer
        // save from another device.
        setSignedIn(true);
        setUserBirthday(row?.birthday ?? null);
        if (row?.topic_quota && typeof row.topic_quota === "number") {
          setTarget(clampQuota(row.topic_quota));
        }
        // Prefer the DB's saved order (the user's ranking) over whatever
        // onboarding localStorage happens to hold on this device.
        if (Array.isArray(row?.topics) && row.topics.length > 0) {
          setPicked(row.topics as TopicId[]);
        }
      } catch (e) {
        // Logged, not silent: if this throws, signedIn never flips true, so
        // submit() below takes the UNSIGNED branch on a signed-in user's
        // Continue click -- it skips the POST to /api/account/topics
        // entirely and just updates local onboarding state instead. A
        // recurring failure here would otherwise look like a successful
        // save to the reader while silently writing nothing to the DB.
        console.warn("[topics] signed-in hydrate failed:", e instanceof Error ? e.message : e);
      } finally {
        // Unconditional: reached whether a session existed, the row fetch
        // succeeded, or it threw -- every one of those is "we now know
        // everything we're going to know," so submit() is safe from here.
        if (!cancelled) setTopicsHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // alpha-drift-r36-11 (2026-08-14): components/onboarding/QuestionStep.tsx
  // (every other step past /name) bounces to /welcome when firstName is
  // missing, since a URL a browser will happily load with empty/partial
  // localStorage means the visitor never went through /name at all. /topics
  // sits at step 7 of the same funnel with no equivalent check -- an
  // unsigned visitor reaching it directly could pick and save a full topic
  // pool onto onboarding state already known to be incomplete, only caught
  // by the NEXT step downstream. Gated on topicsHydrated (so this doesn't
  // fire before we know whether the reader is actually a signed-in editor,
  // who legitimately has no firstName in LOCAL onboarding state at all) and
  // !signedIn (a signed-in editor's session IS their completeness signal,
  // same exception QuestionStep/app/you already carve out).
  useEffect(() => {
    if (topicsHydrated && !signedIn && loaded && !state.firstName) {
      router.replace("/welcome" as never);
    }
  }, [topicsHydrated, signedIn, loaded, state.firstName, router]);

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
    setAnnouncement(`${topicLabel(id)} removed from your lineup.`);
    setPicked((prev) => prev.filter((t) => t !== id));
  }

  // Reorder the pool — order IS the ranking (index 0 = top). Moving an item
  // across the favorites/backups line just changes whether it fills the letter.
  function move(from: number, dir: -1 | 1) {
    const to = from + dir;
    if (to < 0 || to >= picked.length) return;
    // alpha-drift-r32-02: computed from the closure's own `picked`/`quota`
    // (both already in scope every render) rather than inside the setPicked
    // updater below -- an updater can run twice under dev Strict Mode, and
    // a setState call nested in another setState's updater is the kind of
    // side effect React explicitly warns updaters should stay free of.
    const item = picked[from];
    const wasFav = from < quota;
    const isFav = to < quota;
    const statusChange = wasFav === isFav ? "" : isFav ? ", now a favorite" : ", now a backup";
    setAnnouncement(`${topicLabel(item)} moved to position ${to + 1} of ${picked.length}${statusChange}.`);
    setPicked((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    tap();
  }

  const customPicks = picked.filter(isCustomTopic);

  async function submit() {
    // Onboarding picks exactly the quota; signed-in editors must at least fill
    // their favorites (backups are optional extras).
    const ready = signedIn ? picked.length >= quota : picked.length === quota;
    // topicsHydrated: see its own comment on the state declaration above
    // (alpha-drift-r19-01) -- without it this could fire with `signedIn`
    // still at its pre-hydrate default. saveInFlight.current: the
    // synchronous re-entry guard `saving` (React state) can't provide on
    // its own -- see that ref's own comment.
    if (!ready || saving || !topicsHydrated || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaveError(null);
    try {
      if (signedIn && supabaseConfigured()) {
        // Persist the ranked pool to the DB FIRST. If the write fails, stay on
        // the page with an error instead of navigating away as if it saved
        // (the letter reads topics from the DB, so a silent failure would
        // lose the change). Only mirror to local state + leave once the DB
        // write lands. Routed through the server (service role) rather than
        // a direct browser write, matching every other mutation in the app
        // -- see app/api/account/topics/route.ts.
        setSaving(true);
        try {
          const res = await fetch("/api/account/topics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topics: picked }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error || "save failed");
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
    } finally {
      // Unconditional: every return path above (save failed, save succeeded
      // and navigated, or the unsigned onboarding path) needs the latch
      // released, not just the failure path -- a navigate-away doesn't
      // synchronously unmount this component, so leaving it stuck true
      // would silently disable a real re-attempt if the user stayed put.
      saveInFlight.current = false;
    }
  }

  const onbRemaining = quota - picked.length;
  const favRemaining = quota - favCount;
  const ready = signedIn ? picked.length >= quota : picked.length === quota;

  return (
    <StepShell stepIndex={7} prevPath={signedIn ? "settings" : "focus"}>
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
            {/* alpha-drift-r35-12 (2026-08-14): "later" and "anytime" said
                the same thing stacked together -- every other reassurance
                in this flow is single-beat ("Change anytime.", "Never
                shared."). */}
            {signedIn
              ? `Your top ${quota} fill your letter each day. Add backups below them. We swap one in when a favorite has no fresh news that day.`
              : "You can swap any of these anytime."}
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
                            // alpha-drift-r20-11 (found+fixed 2026-08-13):
                            // same touch-target bump as the gender toggles.
                            className="alpha-ui text-sm px-3 py-2.5 rounded-full inline-flex items-center gap-1.5"
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
              &quot;AI in radiology.&quot; We&apos;ll hunt the real signal on it for you every day.
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
                    className="alpha-mono leading-none p-2 -m-2"
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
              // alpha-drift-r20-10 (found+fixed 2026-08-13): live-measured at
              // 27x20px, under the WCAG 2.5.8 AA 24x24 minimum. p-2/-m-2
              // grows the tap target without shifting the visual glyph or
              // its position relative to the input -- same pattern this
              // file already uses on the topic-pill remove button above.
              className="alpha-ui text-sm underline underline-offset-4 p-2 -m-2"
              style={{
                color: "var(--accent-ink)",
                opacity: picked.length >= poolMax || !customText.trim() ? 0.4 : 1,
                cursor: picked.length >= poolMax || !customText.trim() ? "not-allowed" : "pointer",
              }}
            >
              Add
            </button>
          </form>
          {/* alpha-drift-r23-02 (found+fixed 2026-08-14): --accent-ink
              fails WCAG AA 4.5:1 against --paper in 12+ themes -- --ink
              clears every theme. */}
          {customErr && (
            <p role="alert" aria-live="assertive" className="alpha-ui text-xs" style={{ color: "var(--ink)" }}>
              {customErr}
            </p>
          )}
          {/* If their custom text matches a curated topic, nudge them to it —
              better sources than a free-text topic, and helps them find topics
              they didn't know existed (e.g. "Islam and Quran" -> the Islam topic). */}
          {(() => {
            const sug = customText.trim().length >= 2 ? suggestCuratedTopic(customText) : null;
            // Hide it if already picked, if its parent umbrella is already picked
            // (so we don't nudge "Islam" when "All faith" is selected), or at the
            // pool limit.
            const sugParent = sug ? PARENT_TOPIC[sug] : undefined;
            if (!sug || picked.includes(sug) || (sugParent && picked.includes(sugParent)) || picked.length >= poolMax) return null;
            return (
              <p className="alpha-ui text-xs" style={{ color: "var(--ink-soft)" }}>
                We have a curated topic for that:{" "}
                <button
                  type="button"
                  onClick={() => {
                    tap();
                    setPicked((p) => (p.includes(sug) ? p : [...p, sug]));
                    setCustomText("");
                    setCustomErr(null);
                  }}
                  className="underline underline-offset-4 font-semibold"
                  style={{ color: "var(--accent-ink)" }}
                >
                  {topicEmoji(sug)} {topicLabel(sug)} →
                </button>{" "}
                It pulls from sources we trust, deeper than a quick search.
              </p>
            );
          })()}
        </div>

        {/* Your lineup — ranked favorites + backups (signed-in editing only) */}
        {signedIn && picked.length > 0 && (
          <div className="space-y-3 pt-2">
            <div>
              <h2 className="alpha-display text-lg font-semibold">Your lineup</h2>
              <p className="alpha-ui text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>
                Order is the ranking. Move things up or down. The top {quota} fill
                your letter. Anything below the line is a backup.
              </p>
            </div>

            {/* alpha-drift-r32-02 (2026-08-14): sr-only, announces move()/
                removeAt() results -- see the state comment above. */}
            <p role="status" aria-live="polite" className="sr-only">
              {announcement}
            </p>
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
                        {/* alpha-drift-r32-02 (2026-08-14): the rank number and
                            favorite-vs-backup status above were both
                            aria-hidden/color-only -- a screen reader heard
                            nothing but the bare topic name. sr-only prefix
                            restores both without changing the visual line. */}
                        <span className="sr-only">
                          {isFav ? `Favorite ${i + 1}` : `Backup ${i + 1 - quota}`}:{" "}
                        </span>
                        {topicEmoji(id)} {topicLabel(id)}
                      </span>
                      {/* Reorder pair and remove are separated (ml-2 gap) and each button
                          gets a min-w/min-h-[40px] hit area so a mistap can't remove a
                          paid pick while trying to reorder it -- the glyph stays small,
                          only the tappable box grows. */}
                      {/* alpha-drift-r35-04 (2026-08-14): these used the native
                          `disabled` attribute at the boundary -- setting
                          `disabled` on a FOCUSED control immediately blurs it
                          and pulls it out of the tab order, with no visible
                          indicator of where focus went. A keyboard user
                          promoting a topic to the very top (or bottom) hit
                          Enter, the button they were on disabled itself, and
                          their next keypress silently did nothing. move()
                          already no-ops safely at the boundary (`to < 0 ||
                          to >= picked.length`), so `disabled` was never load-
                          bearing for correctness here -- switched to
                          aria-disabled, which keeps the same dimmed/
                          default-cursor styling and announces the state to
                          assistive tech without ever removing the control
                          from the tab order or stealing focus mid-interaction. */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => move(i, -1)}
                          aria-disabled={i === 0}
                          aria-label={`Move ${topicLabel(id)} up`}
                          className="alpha-mono text-sm leading-none min-w-[40px] min-h-[40px] flex items-center justify-center"
                          style={{ color: "var(--ink-soft)", opacity: i === 0 ? 0.25 : 1, cursor: i === 0 ? "default" : "pointer" }}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => move(i, 1)}
                          aria-disabled={i === picked.length - 1}
                          aria-label={`Move ${topicLabel(id)} down`}
                          className="alpha-mono text-sm leading-none min-w-[40px] min-h-[40px] flex items-center justify-center"
                          style={{ color: "var(--ink-soft)", opacity: i === picked.length - 1 ? 0.25 : 1, cursor: i === picked.length - 1 ? "default" : "pointer" }}
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => removeAt(id)}
                          aria-label={`Remove ${topicLabel(id)}`}
                          className="alpha-mono text-sm leading-none min-w-[40px] min-h-[40px] flex items-center justify-center ml-2"
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

        {/* alpha-drift-r24-01 (found+fixed 2026-08-14, self-audit): round
            23's own --accent-ink -> --ink contrast sweep in THIS file fixed
            the custom-topic error and the save-error status bar below, but
            missed this third, structurally identical warning -- same
            failing token (fails WCAG AA 4.5:1 against --paper in 12+
            themes), same genuinely-important copy (tells the reader why
            part of their letter will silently be skipped, not decoration). */}
        {signedIn && picked.includes("zodiac" as TopicId) && !userBirthday && (
          <p className="alpha-ui text-xs" role="status" aria-live="polite" style={{ color: "var(--ink)" }}>
            Zodiac needs your birthday to read your sign. Add it in Settings under Your details, or that section gets skipped.
          </p>
        )}

        {/* alpha-drift-r20-09 (found+fixed 2026-08-13): this bar had no
            background at all -- just position:sticky with transparent
            content -- so scrolling pill cards visually overlapped the
            Continue/Save button for nearly the entire scroll on mobile.
            alpha-card (solid paper background + border + shadow) is the
            same "floating over content" treatment InstallPrompt.tsx already
            uses for its own fixed bottom banner. */}
        <div className="alpha-card sticky bottom-4 flex items-center justify-between gap-4 p-4">
          {/* alpha-drift-r23-02 (found+fixed 2026-08-14): --accent-ink
              fails WCAG AA 4.5:1 against --paper in 12+ themes -- --ink
              clears every theme. */}
          <span
            role="status"
            aria-live="polite"
            className="alpha-ui text-sm"
            style={{ color: saveError ? "var(--ink)" : "var(--ink-soft)" }}
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
            disabled={!ready || saving || !topicsHydrated}
            className="alpha-button"
            style={{
              opacity: ready && !saving && topicsHydrated ? 1 : 0.3,
              cursor: ready && !saving && topicsHydrated ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "Saving…" : signedIn ? "Save" : "Continue →"}
          </button>
        </div>
      </div>
    </StepShell>
  );
}
