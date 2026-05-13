"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Digest } from "@/components/Digest";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { useOnboarding } from "@/lib/onboarding-state";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";

export default function InboxPage() {
  const router = useRouter();
  const { state, loaded } = useOnboarding();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ISSUE);
      if (!raw) {
        setMissing(true);
        return;
      }
      const parsed: Issue = JSON.parse(raw);
      setIssue(parsed);
      // Apply user's chosen theme to the document
      if (state.theme) {
        document.documentElement.setAttribute("data-theme", state.theme);
      }
    } catch {
      setMissing(true);
    }
  }, [loaded, state.theme]);

  if (missing) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center space-y-6">
          <p className="alpha-display text-2xl font-bold">
            No letter yet.
          </p>
          <Link href="/welcome" className="alpha-button">
            Start fresh →
          </Link>
        </div>
      </main>
    );
  }

  if (!issue) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <p
          className="alpha-display text-xl"
          style={{ color: "var(--ink-soft)" }}
        >
          Loading…
        </p>
      </main>
    );
  }

  return (
    <main className="flex-1">
      <div
        className="w-full sticky top-0 z-40 border-b"
        style={{ background: "var(--paper)", borderColor: "var(--rule)" }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/inbox"
            className="alpha-display text-xl font-bold leading-none"
            style={{ color: "var(--ink)" }}
          >
            alpha<span style={{ color: "var(--accent)" }}>.</span>
          </Link>
          <div className="flex items-center gap-4">
            <ThemeSwitcher />
            <button
              type="button"
              onClick={() => router.push("/settings" as never)}
              className="alpha-ui text-sm rounded-full p-2 border"
              style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
              aria-label="Settings"
            >
              ⚙
            </button>
          </div>
        </div>
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"
          style={{ color: "var(--accent-ink)" }}
        >
          YOUR FIRST LETTER · NEXT ONE SHIPS SUNDAY
        </div>
      </div>
      <Digest issue={issue} />
    </main>
  );
}
