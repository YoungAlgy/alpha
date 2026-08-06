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
  const confirmHeadingRef = useRef<HTMLParagraphElement>(null);
  const tierReturnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (confirmingTier) {
      confirmHeadingRef.current?.focus();
    } else if (tierReturnFocusRef.current?.isConnected) {
      tierReturnFocusRef.current.focus();
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
        const { data: row } = await sb
          .from("users")
          .select("topic_quota, topics, subscribed_at, cancelled_at, stripe_customer_id, unsubscribed_at")
          .eq("id", user.id)
          .maybeSingle();
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
      } catch {
        // ignore
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
          const { data: row } = await sb
            .from("users")
            .select("topic_quota")
            .eq("id", user.id)
            .maybeSingle();
          if (row?.topic_quota && typeof row.topic_quota === "number") {
            setTopicQuota(clampQuota(row.topic_quota));
          }
        }
      } catch {
        // ignore — panel still opens with the last-known quota
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
            {resumed ? (
              <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
                You&apos;re back on. Your next letter lands tomorrow.
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
                    role="status"
                    aria-live="polite"
                    className="alpha-ui text-sm mt-3"
                    style={{ color: "var(--accent-ink)" }}
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
          {(() => {
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
                <Link
                  href="/topics"
                  className="alpha-ui text-sm underline underline-offset-4"
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
            <ThemeSwitcher />
            <Link
              href="/theme"
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              See all looks →
            </Link>
          </div>
        </Section>

        <Section title="Email">
          <EmailChanger currentEmail={authEmail || state.email || null} />
        </Section>

        <Section title="Billing">
          {quotaLoaded ? (
            <>
              <p className="alpha-display text-base mb-1">
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
          {!confirmingTier && (
            <div className="flex flex-wrap gap-4 mb-3">
              {canAdd && (
                <button
                  type="button"
                  disabled={busyTier !== null}
                  onClick={(e) => {
                    tierReturnFocusRef.current = e.currentTarget;
                    requestTier("up");
                  }}
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
                  onClick={(e) => {
                    tierReturnFocusRef.current = e.currentTarget;
                    requestTier("down");
                  }}
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
                {confirmingTier === "up"
                  ? `You'll move to ${pendingQuota} topics at $${pendingDollars}/mo. The prorated extra for the rest of this cycle is added to your next invoice along with the new rate, nothing is charged today. Then you'll pick the new ones.`
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
                  className="alpha-ui text-sm underline underline-offset-4"
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
              style={{ color: billingMsg.kind === "err" ? "var(--accent-ink)" : "var(--ink-soft)" }}
            >
              {billingMsg.text}
            </p>
          )}
          {justAdded && (
            <p className="mb-3">
              <Link
                href="/topics"
                className="alpha-ui text-sm underline underline-offset-4 font-semibold"
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
            <Link
              href="/settings/accounts"
              className="alpha-ui text-sm underline underline-offset-4"
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
          <Link
            href="/settings/changelog"
            className="alpha-ui text-sm underline underline-offset-4"
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
                    const { data: { session } } = await sb.auth.getSession();
                    if (session) {
                      const res = await fetch("/api/account/export");
                      if (res.ok) {
                        exportData = await res.json();
                      } else {
                        alert("Couldn't reach the server for your full data — downloading what's saved on this device instead.");
                      }
                    }
                  } catch {
                    alert("Couldn't reach the server for your full data — downloading what's saved on this device instead.");
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
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              Download my data
            </button>
            <br />
            <button
              type="button"
              onClick={async () => {
                // Paying users: the delete endpoint cancels their Stripe
                // subscription before removing the account (best-effort), so we
                // tell them it's handled and offer the portal as a double-check
                // rather than the old "we won't cancel, you'll keep paying" warning.
                const confirmMsg = hasPaidSub
                  ? `Delete your alpha. account?\n\nThis removes your letters and profile and can't be undone. We cancel your $${monthlyDollars}/mo subscription as part of this. To be safe you can confirm it's gone in "Manage subscription" above first.\n\nDelete anyway?`
                  : "Delete your alpha. account? This removes your saved letters and profile. Can't be undone.";
                if (!confirm(confirmMsg)) return;
                if (deleteInFlight.current) return;
                deleteInFlight.current = true;
                const result = await deleteUserAccount();
                if (!result.ok) {
                  alert(`Couldn't delete: ${result.error}\nLocal data will still clear.`);
                }
                reset();
                localStorage.removeItem("alpha-first-issue");
                localStorage.removeItem("alpha-theme");
                window.location.href = "/welcome";
              }}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Delete my account
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
