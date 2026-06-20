"use client";

import { useState } from "react";
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
        { emailRedirectTo: `${origin}/alpha/auth/callback?next=/settings` }
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
          role="status"
          aria-live="polite"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          We sent a confirmation link to <strong>{sentTo}</strong> and to your
          current address. Open both and click to confirm the change. Check spam
          if you don&apos;t see them. Your letters keep coming to your current
          address until you finish.
        </p>
        <button
          type="button"
          onClick={() => setSentTo(null)}
          className="alpha-ui text-sm underline underline-offset-4 mt-3"
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
            type="button"
            onClick={() => {
              setEditing(true);
              setErr(null);
            }}
            className="alpha-ui text-sm underline underline-offset-4"
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
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setValue("");
                setErr(null);
              }}
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && (
        <p
          role="status"
          aria-live="polite"
          className="alpha-ui text-sm mt-3"
          style={{ color: "var(--accent-ink)" }}
        >
          {err}
        </p>
      )}
    </div>
  );
}
