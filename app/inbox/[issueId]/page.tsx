"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Digest } from "@/components/Digest";
import { Wordmark } from "@/components/Wordmark";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { AudioToggle } from "@/components/AudioToggle";
import { ReadingProgress } from "@/components/ReadingProgress";
import { LetterTOC } from "@/components/LetterTOC";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { coerceThemeId } from "@/lib/themes";
import type { Issue } from "@/lib/types";

// Renders a specific past issue by ID (UUID from public.issues.id) for its
// signed-in owner. The fetch is scoped to the user (RLS + an explicit user_id
// filter), so another user's id — or any unknown/missing id — returns nothing
// and we show a friendly "can't find that letter" state with sign-in/archive
// links. (No localStorage fallback here; that only lives on the main /inbox.)

export default function IssuePage() {
  const params = useParams<{ issueId: string }>();
  const issueId = params?.issueId;
  const [issue, setIssue] = useState<Issue | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    (async () => {
      if (supabaseConfigured()) {
        try {
          const sb = supabaseClient();
          const { data: { session } } = await sb.auth.getSession();
          if (session && issueId) {
            const { data, error } = await sb
              .from("issues")
              .select("week_of, volume, number, editor_intro, sections")
              .eq("id", issueId)
              .eq("user_id", session.user.id)
              .maybeSingle();
            if (!error && data) {
              const { data: userRow } = await sb
                .from("users")
                .select("first_name, city, theme")
                .eq("id", session.user.id)
                .maybeSingle();
              const themeId = coerceThemeId(userRow?.theme);
              if (themeId) {
                document.documentElement.setAttribute("data-theme", themeId);
              }
              setIssue({
                id: issueId,
                volume: data.volume,
                number: data.number,
                weekOf: data.week_of,
                recipientFirstName: userRow?.first_name || "you",
                recipientCity: userRow?.city || "",
                editorIntro: data.editor_intro,
                sections: data.sections,
              });
              return;
            }
          }
        } catch (e) {
          console.warn("[issue] fetch failed:", e);
        }
      }
      setMissing(true);
    })();
  }, [issueId]);

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
            Can&apos;t find that letter.
          </p>
          <p
            className="alpha-display text-base"
            style={{ color: "var(--ink-soft)" }}
          >
            It might have been deleted, or you may need to sign in.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Link href="/archive" className="alpha-button">
              Back to archive →
            </Link>
            <Link
              href="/signin"
              className="alpha-ui text-sm underline underline-offset-4 pt-3"
              style={{ color: "var(--ink-soft)" }}
            >
              Or sign in
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!issue) return <LetterLoader />;

  return (
    <main className="flex-1">
      <ReadingProgress />
      <div
        className="w-full sticky top-0 z-40 border-b"
        style={{ background: "var(--paper)", borderColor: "var(--rule)" }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/archive"
            className="alpha-display text-xl font-bold leading-none"
            style={{ color: "var(--ink)" }}
          >
            <Wordmark />
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/archive"
              className="alpha-ui text-sm"
              style={{ color: "var(--ink-soft)" }}
            >
              ← Archive
            </Link>
            <AudioToggle />
            <ThemeSwitcher />
          </div>
        </div>
      </div>
      <LetterTOC issue={issue} />
      <Digest issue={issue} />
    </main>
  );
}

function LetterLoader() {
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
