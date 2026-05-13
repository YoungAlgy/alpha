"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Digest } from "@/components/Digest";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { AudioToggle } from "@/components/AudioToggle";
import { ReadingProgress } from "@/components/ReadingProgress";
import { useOnboarding } from "@/lib/onboarding-state";
import { fanfare } from "@/lib/audio";
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
      // Celebrate first arrival
      if (localStorage.getItem("alpha-just-generated") === "1") {
        localStorage.removeItem("alpha-just-generated");
        setTimeout(() => fanfare(), 300);
      }
    } catch {
      setMissing(true);
    }
  }, [loaded, state.theme]);

  if (missing) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center space-y-6 max-w-md">
          <div
            className="alpha-display text-6xl font-bold"
            style={{ color: "var(--accent-ink)", opacity: 0.6 }}
          >
            α
          </div>
          <p className="alpha-display text-2xl md:text-3xl font-bold tracking-tight">
            No letter yet.
          </p>
          <p
            className="alpha-display text-base md:text-lg leading-relaxed"
            style={{ color: "var(--ink-soft)" }}
          >
            Your first letter ships the moment you finish setting up. Picks up
            where you left off if you started earlier.
          </p>
          <div className="pt-2">
            <Link href="/welcome" className="alpha-button">
              Start fresh →
            </Link>
          </div>
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

  // Word count → read time estimate (~225 wpm for editorial reading)
  const wordCount = computeWordCount(issue);
  const minutes = Math.max(1, Math.round(wordCount / 225));

  return (
    <main className="flex-1">
      <ReadingProgress />
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
          <div className="flex items-center gap-2">
            <AudioToggle />
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
          YOUR FIRST LETTER · {minutes} MIN READ · NEXT ONE SHIPS SUNDAY
        </div>
      </div>
      <Digest issue={issue} />
    </main>
  );
}

function computeWordCount(issue: Issue): number {
  let total = issue.editorIntro.split(/\s+/).length;
  for (const s of issue.sections) {
    total += s.intro.split(/\s+/).length;
    for (const it of s.items) {
      total += it.headline.split(/\s+/).length;
      total += it.body.split(/\s+/).length;
    }
  }
  return total;
}
