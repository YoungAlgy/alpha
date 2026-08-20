"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { hasActiveAccess } from "@/lib/access";
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
  const [accessEnded, setAccessEnded] = useState(false);
  // alpha-drift-r42-06 (2026-08-19): a genuine query failure (network blip,
  // transient Supabase/RLS error) used to fall through the SAME `missing`
  // gate as a real zero-row not-found, so a reader hitting a transient
  // hiccup saw "It might have been deleted" -- alarming and wrong, plus no
  // retry affordance. Same distinction app/archive/page.tsx's own
  // `state === "error"` branch already makes one directory over, with the
  // identical reasoning in its own comment: "A query error must NOT be
  // masked as 'no letters' -- that's alarming to a paying subscriber."
  const [loadError, setLoadError] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // App Router doesn't remount this component when only issueId changes via
  // client-side navigation (e.g. jumping between two archived issues from
  // /archive), so mountedRef alone isn't enough -- an older in-flight fetch
  // for a PREVIOUS issueId, resolving after a newer one starts (not
  // guaranteed to resolve in request order), could otherwise overwrite the
  // screen with the wrong letter. activeIssueIdRef tracks which issueId the
  // most recently started load() call is actually for; each in-flight
  // call's own captured `forIssueId` has to still match it at every await
  // point before touching state. A same-issueId retry (the Try Again
  // button) is never stale against itself, so this doesn't block retries.
  const activeIssueIdRef = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    const forIssueId = issueId;
    activeIssueIdRef.current = forIssueId;
    const stale = () => activeIssueIdRef.current !== forIssueId || !mountedRef.current;
    setMissing(false);
    setLoadError(false);
    if (supabaseConfigured()) {
      try {
        const sb = supabaseClient();
        const { data: { session } } = await sb.auth.getSession();
        if (stale()) return;
        if (session && forIssueId) {
          const [{ data, error }, { data: userRow, error: userError }] = await Promise.all([
            sb
              .from("issues")
              .select("week_of, volume, number, editor_intro, sections")
              .eq("id", forIssueId)
              .eq("user_id", session.user.id)
              .maybeSingle(),
            sb
              .from("users")
              .select("first_name, city, theme, cancelled_at")
              .eq("id", session.user.id)
              .maybeSingle(),
          ]);
          if (stale()) return;
          // alpha-drift-r16-15: same app-level defense-in-depth as
          // /inbox -- see that file's comment for why this can't wait
          // on the pending RLS migration.
          //
          // alpha-drift-r20-05: same deleted-account gap as /inbox --
          // see that file's comment. A cascade-deleted `users` row makes
          // userRow null, which hasActiveAccess(undefined) misreads as
          // "active." !userError && !userRow is a genuine zero-row
          // result, not a query failure (that's handled below by the
          // separate `error` check on the issues query).
          if (!userError && !userRow) {
            setAccessEnded(true);
            return;
          }
          if (!hasActiveAccess(userRow?.cancelled_at)) {
            setAccessEnded(true);
            return;
          }
          if (error) {
            setLoadError(true);
            return;
          }
          if (data) {
            const themeId = coerceThemeId(userRow?.theme);
            if (themeId) {
              document.documentElement.setAttribute("data-theme", themeId);
            }
            setIssue({
              id: forIssueId,
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
        if (!stale()) setLoadError(true);
        return;
      }
    }
    if (!stale()) setMissing(true);
  }, [issueId]);

  useEffect(() => {
    load();
  }, [load]);

  if (accessEnded) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center space-y-6 max-w-md">
          <div
            className="alpha-display text-6xl font-bold"
            style={{ color: "var(--accent-ink)", opacity: 0.6 }}
          >
            α
          </div>
          <h1 className="alpha-display text-2xl md:text-3xl font-bold tracking-tight">
            Your subscription has ended.
          </h1>
          <p className="alpha-display text-base" style={{ color: "var(--ink-soft)" }}>
            Want back in? Start a new letter, or reach out if something looks wrong.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Link href="/welcome" className="alpha-button">
              Start a new letter →
            </Link>
            <Link
              href="/support"
              className="alpha-ui text-sm underline underline-offset-4 pt-3"
              style={{ color: "var(--ink-soft)" }}
            >
              Contact support
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center space-y-6 max-w-md">
          <div
            className="alpha-display text-6xl font-bold"
            style={{ color: "var(--accent-ink)", opacity: 0.6 }}
          >
            α
          </div>
          <h1 className="alpha-display text-2xl md:text-3xl font-bold tracking-tight" role="status" aria-live="polite">
            Couldn&apos;t load that letter.
          </h1>
          <p
            className="alpha-display text-base"
            style={{ color: "var(--ink-soft)" }}
          >
            That&apos;s almost always a temporary hiccup. Your letters are safe.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <button type="button" onClick={() => load()} className="alpha-button">
              Try again
            </button>
            <Link
              href="/archive"
              className="alpha-ui text-sm underline underline-offset-4 pt-3"
              style={{ color: "var(--ink-soft)" }}
            >
              Back to archive
            </Link>
          </div>
        </div>
      </main>
    );
  }

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
          <h1 className="alpha-display text-2xl md:text-3xl font-bold tracking-tight">
            Can&apos;t find that letter.
          </h1>
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
          {/* alpha-drift-r35-01 (2026-08-14): min-w-0 here is load-bearing
              for ThemeSwitcher's own truncation fix -- see the matching
              comment in app/inbox/page.tsx for why. */}
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/archive"
              className="alpha-ui text-sm py-3 -my-3"
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
      <Digest issue={issue} localTimezone />
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
