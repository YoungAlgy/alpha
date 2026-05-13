"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";

export default function ArchivePage() {
  const [issues, setIssues] = useState<Issue[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ISSUE);
      if (raw) setIssues([JSON.parse(raw) as Issue]);
    } catch {
      setIssues([]);
    }
  }, []);

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-3xl mx-auto w-full flex items-center justify-between">
        <Link
          href="/inbox"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
        <Link
          href="/inbox"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          ← Inbox
        </Link>
      </nav>

      <section className="flex-1 max-w-2xl mx-auto px-6 py-12 w-full">
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-10">
          Archive
        </h1>

        {issues.length === 0 ? (
          <p
            className="alpha-display text-lg"
            style={{ color: "var(--ink-soft)" }}
          >
            No letters yet. Your first one ships after subscribing.
          </p>
        ) : (
          <ul className="space-y-6">
            {issues.map((issue) => (
              <li
                key={issue.id}
                className="border-b pb-6"
                style={{ borderColor: "var(--rule)" }}
              >
                <Link href="/inbox" className="block group">
                  <div
                    className="alpha-mono mb-1"
                    style={{ color: "var(--ink-soft)" }}
                  >
                    {issue.weekOf.toUpperCase()}
                  </div>
                  <p
                    className="alpha-display text-lg md:text-xl font-semibold group-hover:opacity-70"
                  >
                    Hi {issue.recipientFirstName}, — {truncate(issue.editorIntro, 110)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Footer />
    </main>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trim() + "…";
}
