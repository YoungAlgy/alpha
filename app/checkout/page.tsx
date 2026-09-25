"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { StepShell } from "@/components/onboarding/StepShell";
import { useOnboarding } from "@/lib/onboarding-state";
import { topicLabel, topicEmoji } from "@/lib/topics";
import { THEMES, SWATCHES, coerceThemeId } from "@/lib/themes";
import { track } from "@/lib/analytics";
import { isProfileComplete } from "@/lib/checkout-guards";
import { isInviteOnly } from "@/lib/access-mode";
import { readOnboardingAccount } from "@/lib/onboarding-account";
import { incompleteSignupPath } from "@/lib/signup-progress";
import { authOwnsAccessRequestEmail } from "@/lib/access-request-ownership";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { isAuthRateLimitError, isInvalidOrExpiredOtpError } from "@/lib/gotrue-errors";

const RESEND_COOLDOWN_S = 30;

export default function CheckoutPage() {
  const router = useRouter();
  const { state: draftState, emailDraft, update, loaded } = useOnboarding();

  const [subscribing, setSubscribing] = useState(false);
  const [stripeErr, setStripeErr] = useState<string | null>(null);
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);
  const [accessRequested, setAccessRequested] = useState(false);
  const [approvedNeedsProfile, setApprovedNeedsProfile] = useState(false);
  const [approvedAccountEmail, setApprovedAccountEmail] = useState<string | null>(null);
  // An approved reader is already signed in, so the 24-hour draft email
  // expiry does not apply to them. The ownership check below still requires
  // the draft's email to match the signed-in account. Keyed on the approved
  // account (set once) so a later sign-in prompt keeps the same draft.
  const state = useMemo(
    () => approvedAccountEmail && !draftState.email && emailDraft
      ? { ...draftState, email: emailDraft }
      : draftState,
    [approvedAccountEmail, draftState, emailDraft]
  );
  const [accountChecked, setAccountChecked] = useState(!isInviteOnly());
  const [accountCheckError, setAccountCheckError] = useState<string | null>(null);
  const [accountCheckAttempt, setAccountCheckAttempt] = useState(0);
  const requestInFlight = useRef(false);
  // Email confirmation happens right here, not on the separate sign-in page:
  // Request access sends the code, and entering it sends the request.
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [codeResent, setCodeResent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const codeVerifiedRef = useRef(false);
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // Read the stored request before checking the local draft. A pending reader
  // may return after clearing storage or from another device.
  useEffect(() => {
    if (!isInviteOnly()) return;
    let cancelled = false;
    readOnboardingAccount().then(({ state: status, approvedIncomplete, email }) => {
      if (cancelled) return;
      if (approvedIncomplete) {
        setApprovedAccountEmail(email);
        setApprovedNeedsProfile(true);
        setAccountCheckError(null);
        setAccountChecked(true);
        return;
      }
      if (status === "reader" || status === "ended") {
        router.replace("/inbox" as never);
        return;
      }
      setAccessRequested(status === "pending");
      setAccountCheckError(null);
      setAccountChecked(true);
    }).catch(() => {
      if (!cancelled) setAccountCheckError("Couldn't check your signup. Your saved answers haven't been cleared.");
    });
    return () => { cancelled = true; };
  }, [router, accountCheckAttempt]);
  // alpha-drift-r39-04 (2026-08-19): a 409 unmounts the focused Subscribe
  // button (the ternary swaps its whole branch) and replaces it with this
  // "already subscribed" block -- with no ref/focus management, the browser
  // drops focus to <body> with zero signal to a keyboard user on the
  // highest-stakes page in the funnel. Same unmount-without-focus-restore
  // class already fixed for EmailChanger.tsx and app/settings/page.tsx's
  // confirmHeadingRef/billingHeadingRef.
  const checkoutConflictHeadingRef = useRef<HTMLParagraphElement>(null);
  const accessSignInHeadingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (alreadySubscribed || signInRequired) {
      checkoutConflictHeadingRef.current?.focus();
    }
  }, [alreadySubscribed, signInRequired]);
  useEffect(() => {
    if (signInRequired) accessSignInHeadingRef.current?.focus();
  }, [signInRequired]);

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
    if (!loaded || !accountChecked || accessRequested) return;
    // An approved reader with missing answers goes back through the same steps.
    const path = incompleteSignupPath(state);
    if (path) router.replace(path as never);
  }, [loaded, accountChecked, accessRequested, state, router]);

  function rememberCheckoutSignIn() {
    try {
      window.sessionStorage.setItem("alpha-signin-return", "/checkout");
      window.localStorage.setItem("alpha-signin-email", state.email || "");
    } catch {
      // The sign-in page still works without storage; the reader can enter the
      // same address again and return to the saved onboarding profile manually.
    }
  }

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
          jobBlurb: state.jobBlurb,
          projectBlurb: state.projectBlurb,
          funBlurb: state.funBlurb,
          birthday: state.birthday,
          gender: state.gender,
          topics: state.topics,
          theme: state.theme,
        }),
      });
      const data = await res
        .json()
        .catch(() => ({} as { url?: string; error?: string; message?: string }));
      if (cancelledRef.current) return;
      if (
        res.status === 503 &&
        process.env.NODE_ENV === "development" &&
        data.error === "stripe_not_configured"
      ) {
        // Keep the no-Stripe convenience strictly inside `next dev`. A
        // production deployment with a missing Stripe secret must fail closed
        // instead of marking an unverified browser as paid.
        update({ paid: true, completedAt: new Date().toISOString() });
        router.push("/writing" as never);
        return;
      }
      if (res.status === 409) {
        if (data.error === "already_subscribed") {
          setSubscribing(false);
          setAlreadySubscribed(true);
          return;
        }
        if (data.error === "identity_verification_required") {
          rememberCheckoutSignIn();
          setSubscribing(false);
          setSignInRequired(true);
          return;
        }
      }
      if (!res.ok || !data.url) {
        throw new Error(
          data.message || data.error || "Couldn't start checkout. Try again in a moment."
        );
      }
      window.location.href = data.url;
    } catch (e) {
      if (cancelledRef.current) return;
      setSubscribing(false);
      setStripeErr(e instanceof Error ? e.message : "Checkout failed.");
    }
  }

  async function requestAccess() {
    if (requestInFlight.current || !accountChecked || accessRequested || !isProfileComplete(state) ||
        (approvedNeedsProfile && !authOwnsAccessRequestEmail(approvedAccountEmail, state.email))) return;
    requestInFlight.current = true;
    setSubscribing(true);
    setStripeErr(null);
    try {
      const res = await fetch("/api/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: state.email,
          firstName: state.firstName,
          city: state.city,
          jobBlurb: state.jobBlurb,
          projectBlurb: state.projectBlurb,
          funBlurb: state.funBlurb,
          birthday: state.birthday,
          gender: state.gender,
          topics: state.topics,
          theme: state.theme,
        }),
      });
      const data = await res
        .json()
        .catch(() => ({} as { error?: string; message?: string; repaired?: boolean }));
      if (cancelledRef.current) return;
      if (res.status === 401 && data.error === "identity_verification_required") {
        setSubscribing(false);
        // The code step renders below the approved-profile branch.
        setApprovedNeedsProfile(false);
        if (codeVerifiedRef.current) {
          // A code was just confirmed but the server saw no session. Start
          // over on the next click instead of looping on a used code.
          codeVerifiedRef.current = false;
          throw new Error("Your email is confirmed, but this browser didn't keep the sign-in. Tap Request access again.");
        }
        await sendAccessCode();
        return;
      }
      if (!res.ok) {
        throw new Error(
          data.message || data.error || "Couldn't send your request. Try again."
        );
      }
      if (data.repaired) {
        router.replace("/inbox" as never);
        return;
      }
      // Access changed since this page loaded, so the server saved a new
      // request. Show that state, not the approved-profile form.
      setApprovedNeedsProfile(false);
      setAccessRequested(true);
      setSubscribing(false);
    } catch (e) {
      if (cancelledRef.current) return;
      setSubscribing(false);
      setStripeErr(e instanceof Error ? e.message : "Couldn't send your request.");
    } finally {
      requestInFlight.current = false;
    }
  }

  // Email the code for the address in this signup. Creates the sign-in
  // account the first time, same as the sign-in page.
  async function sendAccessCode(isResend = false) {
    const addr = state.email?.trim();
    if (!addr) {
      router.replace("/email" as never);
      return;
    }
    if (codeBusy || (isResend && resendCooldown > 0)) return;
    setCodeBusy(true);
    setCodeSending(true);
    setCodeErr(null);
    setCodeResent(false);
    setSignInRequired(true);
    try {
      if (!supabaseConfigured()) throw new Error("Sign-in is not configured.");
      const { error } = await supabaseClient().auth.signInWithOtp({
        email: addr,
        options: { shouldCreateUser: true },
      });
      if (cancelledRef.current) return;
      if (error) throw error;
      // Later visits to the sign-in page start with this address.
      try { window.localStorage.setItem("alpha-signin-email", addr); } catch { /* optional */ }
      setResendCooldown(RESEND_COOLDOWN_S);
      if (isResend) setCodeResent(true);
    } catch (e) {
      console.warn("[checkout] send code failed:", e instanceof Error ? e.message : e);
      if (cancelledRef.current) return;
      const shape = e && typeof e === "object" ? (e as { status?: unknown; code?: unknown; message?: unknown }) : {};
      setCodeErr(
        isAuthRateLimitError(shape)
          ? "Too many codes too fast. Give it a minute, then try Resend."
          : "Couldn't send the code. Try again?"
      );
    } finally {
      if (!cancelledRef.current) {
        setCodeBusy(false);
        setCodeSending(false);
      }
    }
  }

  // Confirm the code, then send the access request without another click.
  async function verifyAccessCode(e?: FormEvent) {
    e?.preventDefault();
    const token = code.replace(/\D/g, "");
    if (token.length < 6) {
      setCodeErr("Code is 6 digits.");
      return;
    }
    const addr = state.email?.trim();
    if (codeBusy || !addr) return;
    setCodeBusy(true);
    setCodeErr(null);
    setCodeResent(false);
    try {
      const { error } = await supabaseClient().auth.verifyOtp({ email: addr, token, type: "email" });
      if (cancelledRef.current) return;
      if (error) throw error;
    } catch (err) {
      console.warn("[checkout] verify code failed:", err instanceof Error ? err.message : err);
      if (cancelledRef.current) return;
      const shape = err && typeof err === "object" ? (err as { status?: unknown; code?: unknown; message?: unknown }) : {};
      setCodeErr(
        isInvalidOrExpiredOtpError(shape)
          ? "That code didn't work. It may have expired. Double-check it, or hit Resend for a fresh one."
          : "Couldn't confirm the code. Try again."
      );
      setCodeBusy(false);
      return;
    }
    codeVerifiedRef.current = true;
    setCode("");
    // An existing account may already be waiting or approved. If the
    // account read fails, the request route still decides correctly.
    const account = await readOnboardingAccount().catch(() => null);
    if (cancelledRef.current) return;
    setCodeBusy(false);
    if (account?.state === "reader" || account?.state === "ended") {
      router.replace("/inbox" as never);
      return;
    }
    setSignInRequired(false);
    if (account?.state === "pending") {
      setAccessRequested(true);
      return;
    }
    await requestAccess();
  }

  const firstName = state.firstName || "you";
  const themeId = coerceThemeId(state.theme) ?? "forest";
  const themeLabel = THEMES.find((t) => t.id === themeId)?.label || "Forest";
  const sw = SWATCHES[themeId];

  if (!loaded || !accountChecked) {
    return (
      <StepShell stepIndex={11} prevPath="email">
        <p className="alpha-ui" role={accountCheckError ? "alert" : "status"}>
          {accountCheckError || "Checking your saved signup..."}
        </p>
        {accountCheckError && (
          <button type="button" className="alpha-button mt-4" onClick={() => {
            setAccountCheckError(null);
            setAccountCheckAttempt((attempt) => attempt + 1);
          }}>Try again</button>
        )}
      </StepShell>
    );
  }

  return (
    <StepShell stepIndex={11} prevPath="email" backDisabled={subscribing}>
      <div className="space-y-10">
        <div>
          <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight leading-tight mb-3">
            {accessRequested ? "Your request is saved." : approvedNeedsProfile ? "Finish your profile." : `Almost there, ${firstName}.`}
          </h1>
          <p
            className="alpha-display text-lg md:text-xl leading-relaxed"
            style={{ color: "var(--ink-soft)" }}
          >
            {accessRequested ? "You don't need to sign up again." : approvedNeedsProfile ? "Your access is approved. Save your name and topics to finish setup." : isInviteOnly() ? "Request access and we'll review your profile." : "Subscribe and we'll write your first letter on the spot."}
          </p>
        </div>

        {/* alpha-drift-r54-05 (2026-08-20, loading-state-consistency-resweep):
            useOnboarding()'s state starts empty and only fills in from
            localStorage inside a post-mount effect (loaded flips true a
            beat later) -- this block used to render unconditionally,
            reading state.* directly, so a returning visitor with real,
            previously-saved data (the normal case -- checkout is step 11 of
            11) briefly saw the theme preview default to Forest regardless
            of what they'd actually picked, an empty topics-chip row, and
            missing City/Email lines, before snapping to their real choices.
            Same bug class settings/page.tsx's quotaLoaded gate already
            closed elsewhere (rounds 19/44) -- gated here too, on the app's
            single highest-stakes screen. */}
        {loaded && !accessRequested && <div className="grid md:grid-cols-[160px_1fr] gap-5 items-stretch">
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
        </div>}

        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            background: "var(--paper-deep)",
            borderRadius: "var(--radius-card)",
          }}
        >
          {isInviteOnly() ? (
            approvedNeedsProfile ? (
              <div className="space-y-3" role="status">
                {isProfileComplete(state) && authOwnsAccessRequestEmail(approvedAccountEmail, state.email) ? (
                  <button type="button" onClick={requestAccess} disabled={subscribing}
                    className="alpha-button alpha-button-accent w-full justify-center text-base py-4">
                    {subscribing ? "Saving profile..." : "Finish signup →"}
                  </button>
                ) : (
                  <button type="button" onClick={() => router.push("/settings" as never)}
                    className="alpha-button alpha-button-accent w-full justify-center text-base py-4">
                    Finish in settings →
                  </button>
                )}
              </div>
            ) : accessRequested ? (
              <div className="space-y-3" role="status">
                <p className="alpha-ui text-sm" style={{ color: "var(--ink)" }}>
                  Your request is in. Alex will review it personally. Come back after access is approved.
                </p>
                <button
                  type="button"
                  onClick={() => router.push("/inbox" as never)}
                  className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
                >
                  View request status →
                </button>
              </div>
            ) : signInRequired ? (
              <form onSubmit={verifyAccessCode} className="space-y-4">
                <p
                  ref={accessSignInHeadingRef}
                  tabIndex={-1}
                  role="status"
                  className="alpha-ui text-sm text-center"
                  style={{ color: "var(--ink)", outline: "none" }}
                >
                  {codeSending
                    ? `Sending a code to ${state.email}...`
                    : `We emailed a 6-digit code to ${state.email}. Enter it to send your request.`}
                </p>
                <input
                  type="text"
                  aria-label="6-digit code from your email"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="\d{6}"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  disabled={codeBusy}
                  className="w-full text-center alpha-display text-3xl tracking-[0.4em] bg-transparent border-b py-3 focus:outline-none placeholder:opacity-30 font-bold"
                  style={{ color: "var(--ink)", borderColor: "var(--rule)", lineHeight: 1.35 }}
                />
                <button
                  type="submit"
                  disabled={codeBusy || subscribing || code.length < 6}
                  className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
                  style={{ opacity: codeBusy || subscribing || code.length < 6 ? 0.6 : 1 }}
                >
                  {subscribing ? "Sending request..." : codeBusy && code ? "Checking code..." : "Confirm and request access →"}
                </button>
                <div className="alpha-ui text-xs flex items-center justify-center gap-4" style={{ color: "var(--ink-soft)" }}>
                  <button
                    type="button"
                    onClick={() => sendAccessCode(true)}
                    disabled={codeBusy || resendCooldown > 0}
                    className="underline underline-offset-4 py-2 -my-2"
                    style={{ opacity: codeBusy || resendCooldown > 0 ? 0.5 : 1 }}
                  >
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend code"}
                  </button>
                  <span aria-hidden style={{ opacity: 0.4 }}>·</span>
                  <button
                    type="button"
                    onClick={() => router.push("/email" as never)}
                    className="underline underline-offset-4 py-2 -my-2"
                  >
                    Use a different email
                  </button>
                </div>
                {codeResent && !codeErr && (
                  <p role="status" aria-live="polite" className="alpha-ui text-xs text-center" style={{ color: "var(--ink-soft)" }}>
                    New code sent. Check your email.
                  </p>
                )}
                {codeErr && (
                  <p role="alert" className="alpha-ui text-xs text-center" style={{ color: "var(--ink)" }}>
                    {codeErr}
                  </p>
                )}
              </form>
            ) : (
              <>
                <div className="flex items-baseline gap-3">
                  <span className="alpha-display text-4xl font-bold">Invite only</span>
                </div>
                <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
                  No card or monthly payment. Request access and Alex will decide who gets in.
                </p>
                <button
                  type="button"
                  onClick={requestAccess}
                  disabled={subscribing}
                  className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
                  style={{ opacity: subscribing ? 0.6 : 1 }}
                >
                  {subscribing ? "Sending request..." : "Request access →"}
                </button>
              </>
            )
          ) : alreadySubscribed ? (
            <div className="space-y-3" role="status">
              <p
                ref={checkoutConflictHeadingRef}
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
          ) : signInRequired ? (
            <div className="space-y-3" role="status">
              <p
                ref={checkoutConflictHeadingRef}
                tabIndex={-1}
                className="alpha-ui text-sm text-center"
                style={{ color: "var(--ink)", outline: "none" }}
              >
                Confirm your email before payment. This keeps the subscription tied to the right account.
              </p>
              <button
                type="button"
                onClick={() => router.push("/signin" as never)}
                className="alpha-button alpha-button-accent w-full justify-center text-base py-4"
              >
                Email me a code →
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
          {!isInviteOnly() && <p
            className="alpha-ui text-xs text-center"
            style={{ color: "var(--ink-soft)" }}
          >
            Secured by Stripe · billed monthly · cancel from settings · no ads
          </p>}
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
