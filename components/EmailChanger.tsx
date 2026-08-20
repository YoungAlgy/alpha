"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { isValidEmail } from "@/lib/validate-email";

// Self-serve email change. Uses Supabase's built-in confirm flow:
// auth.updateUser({ email }) sends a confirmation link to the NEW address (and,
// if "secure email change" is on, the current one too). The auth email only
// flips AFTER the reader clicks it — so until then their letters keep coming to
// the current address. emailRedirectTo points the confirm link back to
// /settings, where the page's reconcile syncs public.users.email + Stripe to the
// new verified auth email. We never write the email ourselves here; Supabase
// owns the verification.
export function EmailChanger({ currentEmail }: { currentEmail: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // alpha-drift-r36-01 (2026-08-14, self-audit): r35-15's own fix (below,
  // history kept in the comment for the next round) was dead code -- it
  // captured the CLOSED view's trigger button into returnFocusRef via
  // e.currentTarget at click time, but that whole branch unmounts the
  // instant setEditing(true) commits (it's a `{!editing ? (...) : (...)}`
  // ternary, not a toggled className), so the captured DOM node is
  // permanently detached by the time Cancel needs it. React mounts a BRAND
  // NEW button object when the closed view reappears -- it never reuses
  // the old one -- so `returnFocusRef.current` stayed pointed at a dead
  // node forever, `.isConnected` was always false, and `.focus()` never
  // fired. Verified this is the SAME bug in app/settings/page.tsx's own
  // tierReturnFocusRef (the pattern this was copied from) and fixed that
  // one too, same round.
  //
  // Fix: attach the ref directly via JSX `ref=` to the trigger button, so
  // React repoints it at whatever's actually live every time that button
  // remounts (ref attachment happens during commit, before this effect
  // runs) -- no captured node to go stale. panelWasOpenRef distinguishes
  // "just closed a panel, focus should return" from "this is the initial
  // mount, don't steal focus."
  const closedTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmHeadingRef = useRef<HTMLParagraphElement>(null);
  const panelWasOpenRef = useRef(false);
  useEffect(() => {
    if (sentTo) {
      confirmHeadingRef.current?.focus();
      panelWasOpenRef.current = true;
      return;
    }
    if (editing) {
      panelWasOpenRef.current = true;
      return;
    }
    if (panelWasOpenRef.current) {
      closedTriggerRef.current?.focus();
      panelWasOpenRef.current = false;
    }
  }, [editing, sentTo]);

  async function submit() {
    const next = value.trim().toLowerCase();
    setErr(null);
    if (!isValidEmail(next)) {
      setErr("That doesn't look like an email. Check for a typo.");
      return;
    }
    if (currentEmail && next === currentEmail.trim().toLowerCase()) {
      setErr("That's already your email.");
      return;
    }
    if (!supabaseConfigured()) {
      setErr("Email changes aren't available right now. Send us a note and we'll move it.");
      return;
    }
    setBusy(true);
    try {
      const sb = supabaseClient();
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const { error } = await sb.auth.updateUser(
        { email: next },
        { emailRedirectTo: `${origin}/auth/callback?next=/settings` }
      );
      if (error) throw error;
      setSentTo(next);
      setEditing(false);
      setValue("");
    } catch (e) {
      // Supabase surfaces "email address already registered" and rate limits
      // here — show them plainly so the reader knows what happened.
      setErr(e instanceof Error ? e.message : "Couldn't start the change. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div>
        <p className="alpha-display text-base mb-2">{currentEmail || "—"}</p>
        <p
          ref={confirmHeadingRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)", outline: "none" }}
        >
          We sent a confirmation link to <strong>{sentTo}</strong> and to your
          current address. Open both and click to confirm the change. Check spam
          if you don&apos;t see them. Your letters keep coming to your current
          address until you finish.
        </p>
        {/* alpha-drift-r59-06 (2026-08-20, accessibility-resweep-newer-
            code-round-7): under the WCAG 2.5.8 24px touch-target minimum,
            unlike its own sibling trigger button below ("Change email →",
            already py-2 -my-2). Not the same control as the file's Cancel
            button (that one was separately refuted for this issue). */}
        <button
          type="button"
          onClick={() => setSentTo(null)}
          className="alpha-ui text-sm underline underline-offset-4 mt-3 py-2 -my-2"
          style={{ color: "var(--accent-ink)" }}
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="alpha-display text-base mb-3">{currentEmail || "—"}</p>
      {!editing ? (
        <>
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            Your letters and sign-in code go here.
          </p>
          <button
            ref={closedTriggerRef}
            type="button"
            onClick={() => {
              setEditing(true);
              setErr(null);
            }}
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--accent-ink)" }}
          >
            Change email →
          </button>
          <p className="alpha-ui text-xs mt-3" style={{ color: "var(--ink-soft)" }}>
            Locked out of your email?{" "}
            <Link
              href="/support"
              className="underline underline-offset-4"
              style={{ color: "var(--accent-ink)" }}
            >
              Send us a note
            </Link>
            .
          </p>
        </>
      ) : (
        <div>
          <p className="alpha-ui text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            We&apos;ll send a confirmation link to your new address and your
            current one. You confirm in both to finish. Your letters keep coming
            to your current address until then.
          </p>
          <input
            autoFocus
            type="email"
            inputMode="email"
            autoComplete="email"
            // alpha-drift-r39-07 (2026-08-19): this was the sole input in
            // the app relying only on a placeholder for its accessible name
            // -- placeholder text disappears the moment a reader types and
            // reads as example text, not an instruction, to a screen
            // reader. Every other input in the app pairs a real label or
            // aria-label (see app/settings/accounts/page.tsx's own comment
            // on exactly why placeholder-only labeling is insufficient).
            aria-label="New email address"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (err) setErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) submit();
            }}
            placeholder="you@newaddress.com"
            disabled={busy}
            className="w-full alpha-ui text-base bg-transparent border-b pt-2 pb-2 mb-4 focus:outline-none focus:border-current placeholder:opacity-40"
            style={{ color: "var(--ink)", borderColor: "var(--rule)" }}
          />
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={submit}
              disabled={busy || value.trim().length === 0}
              className="alpha-button alpha-button-accent text-sm"
              style={{ opacity: busy || value.trim().length === 0 ? 0.5 : 1 }}
            >
              {busy ? "Sending…" : "Send confirmation"}
            </button>
            {/* alpha-drift-r45-02 (2026-08-19): this used to have no busy
                guard at all, unlike the Send confirmation button right next
                to it -- a reader could click Cancel while submit()'s
                updateUser() call was still in flight, believe they'd backed
                out cleanly (the focus-restore effect below correctly treats
                editing->false as a real close), and then have the earlier
                call's late success silently reopen the "confirmation sent"
                panel and steal focus seconds later, with no click of theirs
                visibly causing it. app/settings/page.tsx's tier-confirm
                panel avoids this class entirely by design (its own Cancel
                sets confirmingTier(null) synchronously before any fetch
                starts, so the panel and an in-flight request are mutually
                exclusive) -- this is the one sibling that let Cancel and a
                pending mutation coexist. Disabling it for the same busy
                window as Send confirmation closes the race instead of only
                patching its focus symptom. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setValue("");
                setErr(null);
              }}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)", opacity: busy ? 0.5 : 1 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && (
        <p
          // alpha-drift-r56-02 (2026-08-20, accessibility-resweep-newer-
          // code-round-4): err is exclusively error copy here (a success
          // routes to the separate sentTo view instead) -- role="alert" is
          // this app's established convention for single-purpose,
          // action-failure-only text (checkout/settings-accounts/signin/
          // SupportForm/topics/writing/QuestionStep all use it), unlike a
          // shared success-and-failure bar which legitimately stays
          // role="status". aria-live is dropped as redundant: role="alert"
          // is an implicit assertive live region.
          role="alert"
          className="alpha-ui text-sm mt-3"
          // alpha-drift-r24-01: same --accent-ink WCAG contrast gap round 23
          // fixed elsewhere -- closing the remaining instances in one pass.
          style={{ color: "var(--ink)" }}
        >
          {err}
        </p>
      )}
    </div>
  );
}
