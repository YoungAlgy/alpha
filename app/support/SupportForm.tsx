"use client";

import { useState, FormEvent } from "react";

export function SupportForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !message.trim()) return;
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch("/alpha/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
        className="p-6 rounded-lg space-y-2 text-center"
        style={{
          background: "var(--callout-bg)",
          border: "1px solid var(--accent)",
          borderRadius: "var(--radius-card)",
        }}
      >
        <p className="alpha-display text-xl font-semibold">Got it.</p>
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
          className="w-full alpha-ui text-base bg-transparent border-b py-2 focus:outline-none"
          style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
        />
      </Field>
      <Field label="What's up?" required>
        <textarea
          required
          rows={5}
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
      {error && (
        <p className="alpha-ui text-sm" style={{ color: "var(--accent-ink)" }}>
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
