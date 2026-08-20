"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { isValidEmail } from "@/lib/validate-email";

export function SupportForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // alpha-drift-r39-06 (2026-08-19): status==="sent" early-returns a whole
  // new subtree, unmounting the focused Send button (and the entire form)
  // with no ref/focus management -- role="status"+aria-live covers screen
  // readers, but a sighted keyboard user's focus silently drops to <body>.
  // Same unmount-without-focus-restore class already fixed elsewhere in
  // this app (EmailChanger.tsx, app/settings/page.tsx).
  const sentHeadingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (status === "sent") sentHeadingRef.current?.focus();
  }, [status]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !message.trim()) return;
    // alpha-drift-r42-07 (2026-08-19): every other email input in the app
    // (EmailChanger.tsx, signin/page.tsx) checks isValidEmail() client-side
    // before submitting -- this one only checked for non-empty. A typo like
    // "john@gmail" (missing the TLD) passed the browser's lax native
    // type="email" check and this gate, then hit the server, where
    // app/api/support/route.ts's Zod schema rejects it and composes a raw
    // "Invalid input: email: Not a valid email address" string that this
    // form renders verbatim, mashed together with the "Try emailing us
    // directly." suffix with no separating punctuation.
    if (!isValidEmail(email.trim())) {
      setStatus("error");
      setError("That doesn't look like an email. Check for a typo.");
      return;
    }
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      });
      if (!res.ok) {
        // Surface the route's actual message (e.g. a specific Zod validation
        // error) instead of a generic "HTTP 400" a reader can't act on.
        const data = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setStatus("sent");
      setName("");
      setEmail("");
      setMessage("");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (status === "sent") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="p-6 rounded-lg space-y-2 text-center"
        style={{
          background: "var(--callout-bg)",
          border: "1px solid var(--accent)",
          borderRadius: "var(--radius-card)",
        }}
      >
        <p ref={sentHeadingRef} tabIndex={-1} className="alpha-display text-xl font-semibold" style={{ outline: "none" }}>Got it.</p>
        <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
          You&apos;ll hear back from us within 24 hours.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Your name" optional>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="w-full alpha-ui text-base bg-transparent border-b py-2 focus:outline-none"
          style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
        />
      </Field>
      <Field label="Your email" required>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={200}
          className="w-full alpha-ui text-base bg-transparent border-b py-2 focus:outline-none"
          style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
        />
      </Field>
      <Field label="What's up?" required>
        <textarea
          required
          rows={5}
          maxLength={5000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full alpha-ui text-base bg-transparent border-b py-2 focus:outline-none resize-none"
          style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
        />
      </Field>
      <button
        type="submit"
        disabled={status === "sending"}
        className="alpha-button"
        style={{
          opacity: status === "sending" ? 0.6 : 1,
        }}
      >
        {status === "sending" ? "Sending…" : "Send →"}
      </button>
      {/* alpha-drift-r23-02 (found+fixed 2026-08-14): --accent-ink fails
          WCAG AA 4.5:1 against --paper in 12+ themes -- --ink clears
          every theme. */}
      {error && (
        <p role="alert" className="alpha-ui text-sm" style={{ color: "var(--ink)" }}>
          {error} Try emailing us directly.
        </p>
      )}
    </form>
  );
}

function Field({
  label,
  required,
  optional,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div
        className="alpha-mono mb-2"
        style={{ color: "var(--ink-soft)" }}
      >
        {label.toUpperCase()}
        {optional && (
          <span style={{ opacity: 0.6 }}> · OPTIONAL</span>
        )}
        {required && (
          <span style={{ color: "var(--accent-ink)" }}> *</span>
        )}
      </div>
      {children}
    </label>
  );
}
