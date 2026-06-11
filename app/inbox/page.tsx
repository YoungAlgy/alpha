"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Digest } from "@/components/Digest";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { AudioToggle } from "@/components/AudioToggle";
import { ReadingProgress } from "@/components/ReadingProgress";
import { InstallPrompt } from "@/components/InstallPrompt";
import { FirstLetterCelebration } from "@/components/FirstLetterCelebration";
import { LetterTOC } from "@/components/LetterTOC";
import { ShareButton } from "@/components/ShareButton";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { useOnboarding } from "@/lib/onboarding-state";
import { fanfare } from "@/lib/audio";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";

export default function InboxPage() {
  const router = useRouter();
  const { state, loaded } = useOnboarding();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [missing, setMissing] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      // Path 1 — authenticated user reads from Supabase.
      // Prefer this so a returning sign-in on a fresh device still sees the letter.
      if (supabaseConfigured()) {
        try {
          const sb = supabaseClient();
          const { data: { session } } = await sb.auth.getSession();
          if (session) {
            // Independent queries — run them in parallel (same pattern as
            // /letter) instead of two sequential round trips on the app's
            // most-visited page.
            const [{ data, error }, { data: userRow }] = await Promise.all([
              sb
                .from("issues")
                .select("week_of, volume, number, editor_intro, sections")
                .order("week_of", { ascending: false })
                .limit(1)
                .maybeSingle(),
              sb
                .from("users")
                .select("first_name, city, theme")
                .eq("id", session.user.id)
                .maybeSingle(),
            ]);
            if (!error && data) {
              const themeToApply = userRow?.theme || state.theme || "forest";
              document.documentElement.setAttribute("data-theme", themeToApply);
              setIssue({
                id: `${session.user.id}-${data.week_of}`,
                volume: data.volume,
                number: data.number,
                weekOf: data.week_of,
                recipientFirstName: userRow?.first_name || "you",
                recipientCity: userRow?.city || "",
                editorIntro: data.editor_intro,
                sections: data.sections,
              });
              return; // authenticated path complete
            }
          }
        } catch (e) {
          console.warn("[inbox] supabase read failed, falling back to localStorage:", e);
        }
      }
      // Path 2 — unauthenticated (or supabase down) falls back to localStorage.
      try {
        const raw = localStorage.getItem(STORAGE_KEY_ISSUE);
        if (!raw) {
          setMissing(true);
          return;
        }
        const parsed: Issue = JSON.parse(raw);
        setIssue(parsed);
        if (state.theme) {
          document.documentElement.setAttribute("data-theme", state.theme);
        }
        if (localStorage.getItem("alpha-just-generated") === "1") {
          localStorage.removeItem("alpha-just-generated");
          setCelebrate(true);
          setTimeout(() => fanfare(), 300);
        }
      } catch {
        setMissing(true);
      }
    })();
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
            No letter on this device yet.
          </p>
          <p
            className="alpha-display text-base md:text-lg leading-relaxed"
            style={{ color: "var(--ink-soft)" }}
          >
            Already subscribed? Sign in and your letters will be right here —
            we&apos;ll email you a 6-digit code, no password. New here? Set up
            your first letter in a couple of minutes.
          </p>
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/signin" className="alpha-button">
              Sign in to see my letters →
            </Link>
            <Link
              href="/welcome"
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              I&apos;m new — start fresh
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!issue) {
    // Letter-shaped skeleton matches the final layout so the page doesn't jump
    return (
      <main className="max-w-2xl mx-auto px-6 py-20 md:py-28">
        <div className="space-y-8 animate-pulse">
          <div className="h-3 w-32 mx-auto rounded" style={{ background: "var(--rule)" }} />
          <div className="h-12 w-48 rounded" style={{ background: "var(--rule)" }} />
          <div className="space-y-2">
            <div className="h-4 w-full rounded" style={{ background: "var(--rule)" }} />
            <div className="h-4 w-11/12 rounded" style={{ background: "var(--rule)" }} />
            <div className="h-4 w-3/4 rounded" style={{ background: "var(--rule)" }} />
          </div>
          <div className="border-t mt-12" style={{ borderColor: "var(--rule)" }} />
          <div className="h-10 w-64 rounded" style={{ background: "var(--rule)" }} />
          <div className="space-y-2">
            <div className="h-5 w-5/6 rounded" style={{ background: "var(--rule)" }} />
            <div className="h-4 w-full rounded" style={{ background: "var(--rule)" }} />
            <div className="h-4 w-11/12 rounded" style={{ background: "var(--rule)" }} />
          </div>
        </div>
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
          {weekLabel(issue.weekOf).toUpperCase()} · {minutes} MIN READ · NEXT ONE SHIPS {nextSundayLabel().toUpperCase()}
        </div>
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-ui text-center text-xs flex items-center justify-center gap-4"
          style={{ color: "var(--ink-soft)" }}
        >
          <Link href="/archive" className="underline underline-offset-4 hover:opacity-80">
            Read past letters →
          </Link>
          <span aria-hidden style={{ opacity: 0.4 }}>·</span>
          <ShareButton
            context="inbox"
            url="https://youngalgy.com/alpha"
            title="alpha. — your weekly alpha"
            text="A weekly letter on the five topics you care about. Worth a look:"
            label="Tell a friend"
            className="underline underline-offset-4 hover:opacity-80"
          />
        </div>
      </div>
      <LetterTOC issue={issue} />
      <Digest issue={issue} />
      <InstallPrompt />
      <FirstLetterCelebration active={celebrate} />
    </main>
  );
}

// Format the issue's week_of (ISO or already-formatted) into a tight header
// label like "May 17" — falls back to the raw string if parse fails.
function weekLabel(weekOf: string): string {
  // Already a long-form string like "Sunday, May 17, 2026"?
  if (weekOf.includes(",")) {
    const m = weekOf.match(/^[^,]+,\s*([A-Za-z]+\s+\d+)/);
    if (m) return m[1];
    return weekOf;
  }
  const d = new Date(weekOf + "T12:00:00");
  if (isNaN(d.getTime())) return weekOf;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// "Next one ships May 24" — finds the upcoming Sunday from today (UTC).
function nextSundayLabel(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sunday
  const daysAhead = day === 0 ? 7 : 7 - day;
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
