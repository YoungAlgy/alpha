"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useOnboarding } from "@/lib/onboarding-state";
import { topicLabel, topicEmoji } from "@/lib/topics";
import { Footer } from "@/components/Footer";
import { Wordmark } from "@/components/Wordmark";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ProfileEditor } from "@/components/ProfileEditor";
import { EmailChanger } from "@/components/EmailChanger";
import { deleteUserAccount } from "@/lib/user-sync";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { hasActiveAccess, ADMIN_EMAIL } from "@/lib/access";
import { clampQuota, TOPICS_PER_BUNDLE, PRICE_PER_BUNDLE_CENTS } from "@/lib/types";
import { poolCap } from "@/lib/engine/select-sections";

export default function SettingsPage() {
  const { state, reset } = useOnboarding();
  const [isAdmin, setIsAdmin] = useState(false);
  // Topic-quota state: quota = max topics they can pick (5/10/15/20/25),
  // priceCents = current monthly bill in cents. Both come from public.users
  // (mirror of Stripe subscription quantity × $5).
  const [topicQuota, setTopicQuota] = useState<number>(5);
  // The authoritative monthly price in cents, straight from Stripe via
  // update-quantity's `monthlyCents` response — not re-derived client-side.
  // null until the reader's first add/drop this session; until then the
  // Billing section estimates from topicQuota using the same
  // PRICE_PER_BUNDLE_CENTS/TOPICS_PER_BUNDLE rate the server falls back to,
  // so there's one number that can drift instead of three copies of it.
  const [monthlyCents, setMonthlyCents] = useState<number | null>(null);
  // True once the Supabase fetch below has resolved (success, failure, or no
  // user) at least once. Gates the Billing section so a reader on a non-5
  // tier never sees the hardcoded default flash before their real quota/price
  // is known.
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  // The reader's ranked topic POOL from the DB (source of truth). The top
  // `topicQuota` are favorites that fill the letter; the rest are free backups.
  // Falls back to onboarding localStorage when the DB row hasn't loaded.
  const [topics, setTopics] = useState<string[] | null>(null);
  const [busyTier, setBusyTier] = useState<"up" | "down" | null>(null);
  // Which tier change the reader is being asked to confirm, shown as an in-app
  // panel instead of a native confirm() dialog (which reads as a browser alert,
  // off-brand for a paid change). null = no panel open.
  const [confirmingTier, setConfirmingTier] = useState<"up" | "down" | null>(null);
  // Synchronous re-entrancy latch for confirmTier(). busyTier is React state, so
  // a sub-16ms double-click can invoke confirmTier twice before the state flush
  // disables/unmounts the button — a ref flips synchronously and blocks the second.
  const confirmInFlight = useRef(false);
  // Focus management for the confirm panel: the trigger button is removed
  // from the DOM the same render the panel appears (and vice versa on
  // cancel/confirm), so the browser drops focus to <body> with no signal to
  // a keyboard/screen-reader user that a billing confirmation appeared.
  //
  // alpha-drift-r36-01 (2026-08-14, self-audit found this via its EmailChanger
  // copy): tierReturnFocusRef used to be populated by capturing e.currentTarget
  // on whichever trigger button ("Add 5 more topics" / "Drop 5 topics") was
  // clicked -- but that whole `{!confirmingTier && (...)}` block unmounts the
  // instant confirmingTier is set, permanently detaching the captured node
  // (React mounts a brand-new button when the block reappears, never reusing
  // the old one), so `.isConnected` was always false and `.focus()` never
  // fired. Worse than EmailChanger's version: there are TWO possible triggers,
  // and which ones are even available (canAdd/canRemove) can flip after a
  // successful tier change, so a specific-button ref can't reliably be right
  // even if it weren't stale. Fixed by returning focus to the price display
  // above the buttons instead (billingHeadingRef) -- always rendered once
  // quotaLoaded (a precondition for confirmingTier to ever be set at all),
  // and contextually correct either way ("here's your plan now").
  const confirmHeadingRef = useRef<HTMLParagraphElement>(null);
  const billingHeadingRef = useRef<HTMLParagraphElement>(null);
  const tierPanelWasOpenRef = useRef(false);
  useEffect(() => {
    if (confirmingTier) {
      confirmHeadingRef.current?.focus();
      tierPanelWasOpenRef.current = true;
      return;
    }
    if (tierPanelWasOpenRef.current) {
      billingHeadingRef.current?.focus();
      tierPanelWasOpenRef.current = false;
    }
  }, [confirmingTier]);
  // After a successful add, surface a "pick your new topics" CTA so the flow
  // finishes where the reader actually uses the topics they just bought.
  const [justAdded, setJustAdded] = useState(false);
  // In-page billing feedback (replaces jarring/off-brand alert() dialogs).
  const [billingMsg, setBillingMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Whether the user has an active PAID Stripe subscription. The delete
  // endpoint cancels their Stripe subscription before removing the account
  // (best-effort, see app/api/account/delete/route.ts) — this just drives the
  // confirm-dialog copy so paying users know billing is handled, not just the
  // app account.
  const [hasPaidSub, setHasPaidSub] = useState(false);
  // The signed-in user's real email (auth session = source of truth). The
  // onboarding-state email in localStorage is only present for users who came
  // through the funnel on this device — admin-granted / fresh-device sign-ins
  // have none, which showed a bare "—" here.
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  // Letters are PAUSED (unsubscribed_at set) but the reader still has live
  // access — i.e. they're paying (or comped) and getting nothing, usually from
  // hitting the inbox provider's one-click unsubscribe. Drives a self-serve
  // "Resume my letters" control so they don't have to email support.
  const [showResume, setShowResume] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  // alpha-drift-r39-05 (2026-08-19): a third unmount-without-focus-restore
  // transition in this same file -- the focused "Resume my letters" button
  // unmounts the instant resumeLetters() succeeds, replaced by a bare
  // status paragraph with no ref/tabIndex, dropping a keyboard user's focus
  // to <body>. Same pattern as confirmHeadingRef/billingHeadingRef above.
  const resumedHeadingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (resumed) resumedHeadingRef.current?.focus();
  }, [resumed]);
  // Same re-entrancy latch as confirmInFlight above and ProfileEditor's
  // saveInFlight -- resumeBusy is React state, so a sub-16ms double-click
  // can invoke resumeLetters twice before the state flush disables the
  // button. This action shared the exact same shape (async POST, busy-state-
  // gated button) as those two but was missing the guard.
  const resumeInFlight = useRef(false);
  // Delete had NO busy state at all (not even React state), so confirm()
  // blocking re-clicks during the dialog was the only guard -- once the user
  // clicks OK, the button stays fully clickable for the entire multi-step
  // await (Stripe cancel, support-ticket delete, then admin.deleteUser) with
  // zero loading feedback. Found in review 2026-08-06.
  const deleteInFlight = useRef(false);
  // alpha-drift-r46-04 (2026-08-19): deleteInFlight (above) only ever
  // blocked a second click of THIS button -- it did nothing to disable it
  // visually or communicate that work was happening, unlike every other
  // mutation control on this page (Save details, Send confirmation, Resume
  // my letters) which all dim/disable and swap to an in-progress label.
  // With nothing on screen indicating the multi-step delete (Stripe cancel,
  // support-ticket delete, admin.deleteUser) was running, a reader could
  // click elsewhere on the page (e.g. Back to inbox) while it was still in
  // flight -- the eventual reset()/localStorage-clear/redirect to /welcome
  // still fires afterward regardless of where they'd since navigated.
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!supabaseConfigured()) {
      setQuotaLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (cancelled) return;
        if (!user) return;
        setAuthEmail(user.email ?? null);
        if (user.email === ADMIN_EMAIL) setIsAdmin(true);
        // alpha-drift-r63-05 (2026-08-21, silent-catch-audit-r9 +
        // form-validation-consistency-audit-r8, found independently by both):
        // used to discard `error` -- supabase-js resolves rather than
        // throws on a query error, so the catch below was structurally
        // blind to it, and a real failure rendered identically to a
        // genuinely-empty free account (wrong plan/price shown, the
        // "Drop N topics" downgrade control hidden, "Resume my letters"
        // hidden from a real paused-but-paying reader) with zero trace.
        // Logged only -- no write path consumes this state (confirmTier()
        // POSTs only {direction}; the server re-derives/re-reads), so
        // there's no data-loss risk requiring ProfileEditor's behavioral
        // Save-block treatment.
        const { data: row, error: rowErr } = await sb
          .from("users")
          .select("topic_quota, topics, subscribed_at, cancelled_at, stripe_customer_id, unsubscribed_at")
          .eq("id", user.id)
          .maybeSingle();
        if (rowErr) console.warn("[settings] hydrate row fetch failed:", rowErr.message);
        if (cancelled) return;
        if (row?.topic_quota && typeof row.topic_quota === "number") {
          setTopicQuota(clampQuota(row.topic_quota));
        }
        if (Array.isArray(row?.topics) && row.topics.length > 0) {
          setTopics(row.topics as string[]);
        }
        // Paid + active = subscribed, has a Stripe customer, and not past a
        // cancellation date. (Free admin-granted accounts have no customer id.)
        if (row?.subscribed_at && row?.stripe_customer_id && hasActiveAccess(row.cancelled_at)) {
          setHasPaidSub(true);
        }
        // Show "Resume my letters" only when they're paused AND would actually
        // get letters back if they resumed (subscribed + live access — covers
        // comped accounts too, which have no stripe_customer_id). For a reader
        // with no access, resuming wouldn't send anything, so don't offer it.
        if (row?.unsubscribed_at && row?.subscribed_at && hasActiveAccess(row.cancelled_at)) {
          setShowResume(true);
        }
      } catch (e) {
        // alpha-drift-r63-05: logged, not silent -- a thrown failure
        // (getUser()/getSession() throwing on a missing-env misconfig, a
        // network-level exception the row-fetch's own error log above
        // can't cover) used to leave zero trace.
        console.warn("[settings] hydrate threw:", e instanceof Error ? e.message : e);
      } finally {
        if (!cancelled) setQuotaLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function resumeLetters() {
    if (resumeInFlight.current) return;
    resumeInFlight.current = true;
    setResumeBusy(true);
    setResumeErr(null);
    try {
      const res = await fetch("/api/resume", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setResumeErr("Sign in first to resume your letters.");
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResumed(true);
    } catch (e) {
      setResumeErr(e instanceof Error ? e.message : "Couldn't resume. Try again.");
    } finally {
      setResumeBusy(false);
      resumeInFlight.current = false;
    }
  }

  // Open the in-app confirm panel for an add/drop. Re-reads topic_quota from
  // the DB first: the cached topicQuota state can be stale (loaded once on
  // mount, or last written by a previous confirmTier() call) while another
  // tab/device or the webhook has since moved the real subscription. The
  // panel's promised price/quota is derived from topicQuota (see
  // pendingQuota below), so refreshing it here is what keeps that promise
  // matched to what update-quantity/route.ts will actually act on. Best
  // effort — if the read fails, fall back to whatever's already in state
  // rather than blocking the reader from starting a plan change.
  async function requestTier(direction: "up" | "down") {
    setBillingMsg(null);
    setJustAdded(false);
    if (supabaseConfigured()) {
      try {
        const sb = supabaseClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user) {
          // alpha-drift-r63-05: used to discard `error` too -- the
          // fallback behavior below (proceed with the last-known quota) is
          // deliberate and correct, but sibling best-effort reads elsewhere
          // in this app (update-quantity's fresh topics re-read, the
          // cron's Layer-2 backup lookup) still log the discarded error
          // even when the fallback is intentional, so this one should too.
          const { data: row, error: rowErr } = await sb
            .from("users")
            .select("topic_quota")
            .eq("id", user.id)
            .maybeSingle();
          if (rowErr) console.warn("[settings] requestTier quota re-read failed:", rowErr.message);
          if (row?.topic_quota && typeof row.topic_quota === "number") {
            setTopicQuota(clampQuota(row.topic_quota));
          }
        }
      } catch (e) {
        // ignore — panel still opens with the last-known quota
        console.warn("[settings] requestTier hydrate threw:", e instanceof Error ? e.message : e);
      }
    }
    setConfirmingTier(direction);
  }

  // Run the tier change after the reader confirms in the panel.
  async function confirmTier() {
    const direction = confirmingTier;
    if (!direction || confirmInFlight.current) return;
    confirmInFlight.current = true;
    setConfirmingTier(null);
    setBusyTier(direction);
    setBillingMsg(null);
    try {
      const res = await fetch("/api/stripe/update-quantity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTopicQuota(data.topicQuota);
      // alpha-drift-r59-02 (2026-08-20, form-validation-consistency-audit-
      // r4): a downgrade truncates users.topics server-side to
      // poolCap(newQuota) in the same write (alpha-drift-r58-06), but this
      // success branch never kept the client's own `topics` state in sync
      // with it -- so the "Your topics" section below kept rendering
      // backup rows the server had just deleted from the DB (and that will
      // never appear in a generated letter) until the reader reloaded or
      // navigated away and back. Mirrors the server's own poolCap(newQuota)
      // truncation locally, avoiding an extra round trip; a no-op on "up"
      // since poolCap only ever shrinks on a downgrade.
      if (direction === "down") {
        const truncated = topics ? topics.slice(0, poolCap(data.topicQuota)) : null;
        if (truncated) {
          setTopics(truncated);
          // alpha-drift-r68-01 (2026-08-21, form-validation-consistency-
          // audit-r14): components/ProfileEditor.tsx's hasZodiac flag is
          // fetched once at mount and never resynced -- this truncation can
          // silently drop the reader's zodiac pick with no signal to that
          // separate component tree, leaving its "add your birthday or
          // Zodiac gets skipped" hint stale for the rest of this visit.
          // Broadcasts the actual truncated result so it (and any future
          // topics-derived state) can recompute, mirroring lib/theme.ts's
          // setTheme() -> alpha-theme-change pattern (ThemeApplier.tsx's
          // listener is the reference implementation).
          window.dispatchEvent(new CustomEvent("alpha-topics-truncated", { detail: { topics: truncated } }));
        }
      }
      // Trust the server's real Stripe-derived monthlyCents rather than
      // re-deriving dollars from topicQuota — see monthlyCents state comment.
      setMonthlyCents(data.monthlyCents);
      const dollars = (data.monthlyCents / 100).toFixed(2);
      if (direction === "up") {
        setJustAdded(true);
        setBillingMsg({ kind: "ok", text: `Added. You're on ${data.topicQuota} topics, $${dollars}/mo.` });
      } else {
        setBillingMsg({ kind: "ok", text: `Dropped. You're on ${data.topicQuota} topics, $${dollars}/mo.` });
      }
    } catch (e) {
      setBillingMsg({ kind: "err", text: e instanceof Error ? e.message : "Couldn't update plan." });
    } finally {
      setBusyTier(null);
      confirmInFlight.current = false;
    }
  }

  // monthlyCents (Stripe-authoritative, set post-confirm) wins when present;
  // otherwise estimate off topicQuota with the shared per-bundle rate.
  const monthlyDollars = (
    (monthlyCents ?? (topicQuota / TOPICS_PER_BUNDLE) * PRICE_PER_BUNDLE_CENTS) / 100
  ).toFixed(2);
  const canAdd = topicQuota < 25;
  const canRemove = topicQuota > 5;
  // The quota + price the open confirm panel would move the reader to. This
  // is always an estimate — the panel is shown before update-quantity has
  // been called, so there's no live Stripe read yet to base it on.
  const pendingQuota = confirmingTier === "up" ? topicQuota + 5 : topicQuota - 5;
  const pendingDollars = ((pendingQuota / TOPICS_PER_BUNDLE) * PRICE_PER_BUNDLE_CENTS / 100).toFixed(2);

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-3xl mx-auto w-full flex items-center justify-between">
        <Link
          href="/inbox"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          <Wordmark />
        </Link>
        <Link
          href="/inbox"
          className="alpha-ui text-sm py-3 -my-3"
          style={{ color: "var(--ink-soft)" }}
        >
          ← Back to inbox
        </Link>
      </nav>

      <section className="flex-1 max-w-2xl mx-auto px-6 py-10 w-full">
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-12">
          Settings
        </h1>

        {(showResume || resumed) && (
          <Section title="Letters">
            {/* alpha-drift-r35-07 (2026-08-14): the daily send fires at
                14:00 UTC (SEND_HOUR_UTC) -- a reader resuming any morning
                before ~10am ET is back in TODAY's send, so "tomorrow"
                undersold by a day for a real slice of resumes. Dropped
                the specific day rather than duplicating the inbox's own
                nextSendLabel() UTC-anchor logic here for a settings-page
                confirmation line.
                alpha-drift-r36-02 (2026-08-14, self-audit): r35-07's own
                replacement ("already on the way") swapped one timing
                overpromise for another -- a reader resuming shortly AFTER
                that day's 14:00 UTC send is up to ~24h out, for whom
                "already on the way" is equally inaccurate. Reworded to make
                no claim about how soon at all. */}
            {resumed ? (
              <p
                ref={resumedHeadingRef}
                tabIndex={-1}
                className="alpha-ui text-sm"
                role="status"
                style={{ color: "var(--ink-soft)", outline: "none" }}
              >
                You&apos;re back on. Your daily letters start up again from here.
              </p>
            ) : (
              <>
                <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
                  Your letters are paused. You unsubscribed, so the daily
                  letters aren&apos;t being sent. Your
                  billing is separate and unaffected.
                </p>
                <button
                  type="button"
                  onClick={resumeLetters}
                  disabled={resumeBusy}
                  className="alpha-button alpha-button-accent text-sm"
                  style={{ opacity: resumeBusy ? 0.6 : 1 }}
                >
                  {resumeBusy ? "Resuming…" : "Resume my letters →"}
                </button>
                {resumeErr && (
                  <p
                    // alpha-drift-r56-03 (2026-08-20, accessibility-resweep-
                    // newer-code-round-4): resumeErr is exclusively failure
                    // copy (a success flips `resumed` instead, rendered by a
                    // separate, correctly role="status" heading below) --
                    // role="alert" is this app's established convention for
                    // single-purpose, action-failure-only text, matching its
                    // twin on components/EmailChanger.tsx's err (same fix,
                    // same round). Does NOT apply to the resumed heading or
                    // billingMsg below -- both legitimately carry non-error/
                    // shared success-and-failure copy through the same node.
                    role="alert"
                    className="alpha-ui text-sm mt-3"
                    // alpha-drift-r24-01 (found+fixed 2026-08-14, self-audit
                    // follow-through): same --accent-ink WCAG contrast gap
                    // round 23 fixed elsewhere -- closing the remaining
                    // instances of the class in one pass.
                    style={{ color: "var(--ink)" }}
                  >
                    {resumeErr}
                  </p>
                )}
              </>
            )}
          </Section>
        )}

        <Section title="Your details">
          <ProfileEditor />
        </Section>

        <Section title="Your topics">
          {/* alpha-drift-r44-02 (2026-08-19): matches Billing's own
              quotaLoaded gate below -- `topics ?? state.topics ?? []`
              used to render unconditionally, so a signed-in reader with no
              local onboarding state on this device (a fresh device, or an
              admin-granted account that never onboarded, per this file's
              own r-comment on hasPaidSub above) briefly saw the section
              copy over a genuinely empty list before the real pool popped
              in once the fetch landed. */}
          {!quotaLoaded ? (
            <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
              Loading your topics…
            </p>
          ) : (() => {
            const all = topics ?? state.topics ?? [];
            const favorites = all.slice(0, topicQuota);
            const backups = all.slice(topicQuota);
            return (
              <>
                <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
                  {backups.length > 0
                    ? `The ${topicQuota} things your letter focuses on each day, plus ${backups.length} backup${backups.length > 1 ? "s" : ""} we swap in when a favorite is quiet.`
                    : topicQuota === 5
                      ? "The five things your letter focuses on each day."
                      : `The ${topicQuota} things your letter focuses on each day.`}
                </p>
                <ul className="space-y-1 mb-3">
                  {favorites.map((id) => (
                    <li key={id} className="alpha-display text-base">
                      {topicEmoji(id)} {topicLabel(id)}
                    </li>
                  ))}
                </ul>
                {backups.length > 0 && (
                  <>
                    <p className="alpha-mono text-xs mb-2" style={{ color: "var(--ink-soft)" }}>
                      BACKUPS
                    </p>
                    <ul className="space-y-1 mb-3">
                      {backups.map((id) => (
                        <li key={id} className="alpha-display text-base" style={{ color: "var(--ink-soft)" }}>
                          {topicEmoji(id)} {topicLabel(id)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {/* alpha-drift-r59-03 (2026-08-20, accessibility-resweep-
                    newer-code-round-7): under the WCAG 2.5.8 24px
                    touch-target minimum, unlike 6 sibling links in this
                    same file that already carry this padding. */}
                <Link
                  href="/topics"
                  className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
                  style={{ color: "var(--accent-ink)" }}
                >
                  Change topics →
                </Link>
              </>
            );
          })()}
        </Section>

        <Section title="Theme">
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            Your whole experience in this look. Changes apply everywhere
            instantly.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            {/* align="left": this row sits against the page's own left
                padding (see ThemeSwitcher's own comment on why the default
                right-anchored dropdown ran off-screen here on mobile). */}
            <ThemeSwitcher align="left" />
            {/* alpha-drift-r59-03 (2026-08-20, accessibility-resweep-newer-
                code-round-7): same touch-target fix as "Change topics" above. */}
            <Link
              href="/theme"
              className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
              style={{ color: "var(--accent-ink)" }}
            >
              See all looks →
            </Link>
          </div>
        </Section>

        <Section title="Email">
          {/* alpha-drift-r44-02: same gap as "Your topics" above --
              EmailChanger renders `currentEmail || "—"` unconditionally, so
              before authEmail resolves this showed a bare "—" placeholder
              for the same class of reader (fresh device, no local
              onboarding state) instead of a genuine loading indicator. */}
          {!quotaLoaded ? (
            <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
              Loading…
            </p>
          ) : (
            <EmailChanger currentEmail={authEmail || state.email || null} />
          )}
        </Section>

        <Section title="Billing">
          {quotaLoaded ? (
            <>
              <p ref={billingHeadingRef} tabIndex={-1} className="alpha-display text-base mb-1" style={{ outline: "none" }}>
                alpha. · ${monthlyDollars} / month
              </p>
              <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
                {topicQuota} topics this cycle
              </p>
            </>
          ) : (
            <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
              Loading your plan…
            </p>
          )}
          {/* alpha-drift-r37-02 (2026-08-14, self-audit): the r36 focus-fix
              comment above (billingHeadingRef) claims quotaLoaded is "a
              precondition for confirmingTier to ever be set at all," but
              that was never actually enforced here -- these triggers were
              gated only on !confirmingTier, so a reader who double-clicks
              fast (or has requestTier's async Supabase read resolve slowly)
              could set confirmingTier before quotaLoaded flips true, leaving
              billingHeadingRef.current null when the focus effect fires.
              Gating on quotaLoaded too makes the comment's claim actually
              true. */}
          {!confirmingTier && quotaLoaded && (
            <div className="flex flex-wrap gap-4 mb-3">
              {canAdd && (
                <button
                  type="button"
                  disabled={busyTier !== null}
                  onClick={() => requestTier("up")}
                  className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
                  style={{
                    color: "var(--accent-ink)",
                    opacity: busyTier ? 0.4 : 1,
                  }}
                >
                  {busyTier === "up" ? "Adding…" : "Add 5 more topics (+$5/mo) →"}
                </button>
              )}
              {canRemove && (
                <button
                  type="button"
                  disabled={busyTier !== null}
                  onClick={() => requestTier("down")}
                  className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
                  style={{
                    color: "var(--ink-soft)",
                    opacity: busyTier ? 0.4 : 1,
                  }}
                >
                  {busyTier === "down" ? "Dropping…" : "Drop 5 topics (-$5/mo)"}
                </button>
              )}
            </div>
          )}

          {confirmingTier && (
            <div
              className="mb-4 p-4 rounded-lg"
              style={{ background: "var(--callout-bg)", border: "1.5px solid var(--accent)" }}
            >
              <p
                ref={confirmHeadingRef}
                tabIndex={-1}
                className="alpha-display text-base font-semibold mb-1"
                style={{ outline: "none" }}
              >
                {confirmingTier === "up" ? "Add 5 topics?" : "Drop 5 topics?"}
              </p>
              <p className="alpha-ui text-sm mb-4" style={{ color: "var(--ink-soft)" }}>
                {/* alpha-drift-r35-08 (2026-08-14): reordered so the thing a
                    reader scanning a money confirmation actually cares about
                    -- nothing is charged today -- comes first and plainly,
                    instead of after a comma-spliced run of billing jargon
                    ("prorated extra ... this cycle ... invoice"). */}
                {confirmingTier === "up"
                  ? `You'll move to ${pendingQuota} topics at $${pendingDollars}/mo. Nothing is charged today. The extra for the rest of this month just shows up on your next bill. Then you'll pick your new topics.`
                  : `You'll move to ${pendingQuota} topics at $${pendingDollars}/mo, $5 less. Your letter covers 5 fewer, and any extra picks become free backups.`}
              </p>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={confirmTier}
                  disabled={busyTier !== null}
                  className="alpha-button alpha-button-accent text-sm"
                >
                  {confirmingTier === "up" ? "Add 5 topics" : "Drop 5 topics"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingTier(null)}
                  className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
                  style={{ color: "var(--ink-soft)" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {billingMsg && (
            <p
              role="status"
              aria-live="polite"
              className="alpha-ui text-sm mb-3"
              // alpha-drift-r24-01: same --accent-ink WCAG contrast gap
              // round 23 fixed elsewhere -- closing the remaining
              // instances of the class in one pass.
              style={{ color: billingMsg.kind === "err" ? "var(--ink)" : "var(--ink-soft)" }}
            >
              {billingMsg.text}
            </p>
          )}
          {justAdded && (
            <p className="mb-3">
              {/* alpha-drift-r59-03 (2026-08-20, accessibility-resweep-
                  newer-code-round-7): same touch-target fix as the other
                  bare CTA links in this file. */}
              <Link
                href="/topics"
                className="alpha-ui text-sm underline underline-offset-4 font-semibold py-2 -my-2"
                style={{ color: "var(--accent-ink)" }}
              >
                Pick your new topics →
              </Link>
            </p>
          )}
          <button
            type="button"
            onClick={async () => {
              setBillingMsg(null);
              try {
                const res = await fetch("/api/stripe/portal", { method: "POST" });
                const data = await res.json();
                if (res.status === 401) {
                  setBillingMsg({ kind: "err", text: "Sign in first to manage billing." });
                  return;
                }
                if (res.status === 400) {
                  setBillingMsg({ kind: "err", text: data.error || "Subscribe first." });
                  return;
                }
                if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
                window.location.href = data.url;
              } catch (e) {
                setBillingMsg({ kind: "err", text: e instanceof Error ? e.message : "Couldn't open billing." });
              }
            }}
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--accent-ink)" }}
          >
            Manage subscription →
          </button>
          <p className="alpha-ui text-xs mt-2" style={{ color: "var(--ink-soft)" }}>
            Update card, cancel, see invoices. All in Stripe.
          </p>
        </Section>

        {isAdmin && (
          <Section title="Accounts (admin)">
            <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
              See everyone who's signed up. Grant free subscriptions or remove users.
            </p>
            {/* alpha-drift-r59-03 (2026-08-20, accessibility-resweep-newer-
                code-round-7): same touch-target fix as the other bare CTA
                links in this file. */}
            <Link
              href="/settings/accounts"
              className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
              style={{ color: "var(--accent-ink)" }}
            >
              Manage all users →
            </Link>
          </Section>
        )}

        <Section title="What's new">
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            Recent improvements, additions, and fixes.
          </p>
          {/* alpha-drift-r59-03 (2026-08-20, accessibility-resweep-newer-
              code-round-7): same touch-target fix as the other bare CTA
              links in this file. */}
          <Link
            href="/settings/changelog"
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--accent-ink)" }}
          >
            Changelog →
          </Link>
        </Section>

        <Section title="Account">
          <div className="space-y-3">
            <button
              type="button"
              onClick={async () => {
                // Pull the real server-side record (profile + saved letters)
                // when we can reach it — privacy/page.tsx promises "everything
                // we have about you," and this device's localStorage is only
                // ever a subset (no letters, no usage history) and can be
                // empty or stale on its own. Fall back to the local onboarding
                // state for the no-session/no-Supabase case, where there is no
                // server record to fetch.
                let exportData: unknown = state;
                if (supabaseConfigured()) {
                  try {
                    const sb = supabaseClient();
                    // alpha-drift-r63-05: used to discard `error` -- a
                    // genuine getSession() failure fell into the same
                    // silent local-only fallback as a real "not signed in"
                    // result, with no alert, unlike the sibling !res.ok
                    // branch two lines down. Now treated the same way: a
                    // reader who asked for their FULL data, promised by
                    // privacy.tsx, gets told the download is degraded
                    // instead of silently receiving a subset with no cue.
                    const { data: { session }, error: sessionErr } = await sb.auth.getSession();
                    if (sessionErr) {
                      console.warn("[settings] export getSession failed:", sessionErr.message);
                      alert("Couldn't reach the server for your full data. Downloading what's saved on this device instead.");
                    } else if (session) {
                      const res = await fetch("/api/account/export");
                      if (res.ok) {
                        exportData = await res.json();
                      } else {
                        // alpha-drift-r35-09 (2026-08-14): em dash is a hard
                        // no in reader-facing copy per house style.
                        alert("Couldn't reach the server for your full data. Downloading what's saved on this device instead.");
                      }
                    }
                  } catch {
                    alert("Couldn't reach the server for your full data. Downloading what's saved on this device instead.");
                  }
                }
                const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "alpha-export.json";
                a.click();
              }}
              className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
              style={{ color: "var(--accent-ink)" }}
            >
              Download my data
            </button>
            <br />
            <button
              type="button"
              disabled={deleting}
              onClick={async () => {
                // Paying users: the delete endpoint cancels their Stripe
                // subscription before removing the account (best-effort), so we
                // tell them it's handled and offer the portal as a double-check
                // rather than the old "we won't cancel, you'll keep paying" warning.
                // alpha-drift-r35-10 (2026-08-14): the old aside told the
                // reader to "confirm it's gone in Manage subscription
                // first" -- but the subscription isn't gone yet (it's
                // cancelled AS PART OF this delete), so there's nothing to
                // confirm beforehand, and the native confirm() dialog
                // blocks the page anyway so "above" isn't even clickable.
                // State the guarantee plainly instead.
                const confirmMsg = hasPaidSub
                  ? `Delete your alpha. account?\n\nThis removes your letters and profile and can't be undone. Your $${monthlyDollars}/mo subscription is cancelled too, so billing stops.\n\nDelete anyway?`
                  : "Delete your alpha. account? This removes your saved letters and profile. Can't be undone.";
                if (!confirm(confirmMsg)) return;
                if (deleteInFlight.current) return;
                deleteInFlight.current = true;
                setDeleting(true);
                const result = await deleteUserAccount();
                if (!result.ok) {
                  alert(`Couldn't delete: ${result.error}\nLocal data will still clear.`);
                }
                reset();
                localStorage.removeItem("alpha-first-issue");
                localStorage.removeItem("alpha-theme");
                window.location.href = "/welcome";
              }}
              className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
              style={{ color: "var(--ink-soft)", opacity: deleting ? 0.5 : 1 }}
            >
              {deleting ? "Deleting…" : "Delete my account"}
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
