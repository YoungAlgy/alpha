"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Digest } from "@/components/Digest";
import { Wordmark } from "@/components/Wordmark";
import { coerceThemeId } from "@/lib/themes";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { AudioToggle } from "@/components/AudioToggle";
import { ReadingProgress } from "@/components/ReadingProgress";
import { InstallPrompt } from "@/components/InstallPrompt";
import { FirstLetterCelebration } from "@/components/FirstLetterCelebration";
import { LetterTOC } from "@/components/LetterTOC";
import { ShareButton } from "@/components/ShareButton";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { hasActiveAccess } from "@/lib/access";
import { useOnboarding } from "@/lib/onboarding-state";
import { nextSendIso, SEND_HOUR_UTC } from "@/lib/cadence";
import { fanfare } from "@/lib/audio";
import { SHARE_LEAD } from "@/lib/copy";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";

export default function InboxPage() {
  const router = useRouter();
  const { state, loaded, reset } = useOnboarding();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [missing, setMissing] = useState(false);
  const [checked, setChecked] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [accessEnded, setAccessEnded] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      // Path 1 — authenticated user reads from Supabase.
      // Prefer this so a returning sign-in on a fresh device still sees the letter.
      if (supabaseConfigured()) {
        try {
          const sb = supabaseClient();
          const { data: { session } } = await sb.auth.getSession();
          if (session) {
            setSignedIn(true);
            // Independent queries — run them in parallel (same pattern as
            // /letter) instead of two sequential round trips on the app's
            // most-visited page.
            const [{ data, error }, { data: userRow, error: userError }] = await Promise.all([
              sb
                .from("issues")
                .select("week_of, volume, number, editor_intro, sections")
                .order("week_of", { ascending: false })
                .limit(1)
                .maybeSingle(),
              sb
                .from("users")
                .select("first_name, city, theme, cancelled_at")
                .eq("id", session.user.id)
                .maybeSingle(),
            ]);
            // alpha-drift-r16-15: RLS enforces this too once the pending
            // migration (20260807000000_issues_rls_active_access_only.sql)
            // ships, but until then this app-level check is the ONLY thing
            // stopping a cancelled/disputed subscriber's still-live session
            // from reading their letters here. Keep both layers even after
            // the migration lands -- defense in depth, matches the pattern
            // app/letter/page.tsx already uses (RLS can't reach that route
            // at all, since it's a service-role client).
            //
            // alpha-drift-r20-05 (found+fixed 2026-08-13): getSession() only
            // decodes the LOCAL cached JWT -- no live check against
            // auth.users -- so a signed-in tab on another device can still
            // "work" well after the account itself was deleted elsewhere. A
            // deleted account's cascade-deleted `users` row makes userRow
            // null, and hasActiveAccess(undefined) reads that as "never
            // cancelled" i.e. active -- the opposite of what a missing row
            // means. .maybeSingle() returns error:null on a genuine
            // zero-row result (that's its whole purpose vs .single()), so
            // "!userError && !userRow" is a real "this account is gone"
            // signal, not a network/RLS hiccup misread as deletion.
            if (!userError && !userRow) {
              setAccessEnded(true);
              return;
            }
            if (!hasActiveAccess(userRow?.cancelled_at)) {
              setAccessEnded(true);
              return;
            }
            if (!error && data) {
              const themeToApply = coerceThemeId(userRow?.theme) ?? coerceThemeId(state.theme) ?? "forest";
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
    })().finally(() => {
      // Mark the auth+fetch resolved so the sign-in screen below can only paint
      // once we KNOW the reader is signed out with no local letter — never
      // during the async window (which would flash sign-in before the letter).
      if (!cancelled) setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loaded, state.theme]);

  // Clear any session, then HARD-navigate. This client-side redirect (below,
  // the "already signed in" branch) is the ONLY thing that bounces a
  // signed-in reader off /signin and /welcome back to /inbox -- middleware.ts
  // only handles the apex/www host redirect now (alpha-drift-r15-04, found
  // 2026-08-06: the old server-side version was deliberately NOT carried
  // over during the Cloudflare migration, per src/worker-entry.ts's own
  // comment -- losing it just brings back a one-time page flash, not a
  // functional bug). A Link straight to /signin or /welcome would still loop
  // a signed-in (or stale-cookie) reader right back to this screen via that
  // client-side redirect, so signing out first drops the cookie so the
  // destination actually renders; window.location forces a full reload so
  // the cleared cookie is what the destination page's own check sees.
  //
  // Skipped for "/signin" specifically: signOut() defaults to GLOBAL scope,
  // which revokes whatever session is CURRENTLY in the shared cookie at call
  // time -- not necessarily this tab's own stale view of it. Concrete race:
  // this tab's signedIn=false is a mount-time snapshot; if the reader signs
  // in fresh in another tab on the same browser and then clicks "Sign in" in
  // THIS one, a pre-emptive signOut() here would revoke the OTHER tab's
  // brand-new session seconds after it was created. Unneeded anyway --
  // signInWithOtp()/verifyOtp() on the /signin page naturally supersede any
  // existing session.
  //
  // alpha-drift-r26-03 (2026-08-14): the IDENTICAL race applies to the "I'm
  // new, start fresh" button below, which also calls clearAndGo("/welcome")
  // from a context where THIS tab already believes signedIn is false -- same
  // stale-snapshot exposure as /signin, same fix. The two OTHER /welcome
  // call sites (accessEnded's "Start a new letter →", and "Sign out" in the
  // no-letter-yet screen's signedIn branch) are different: both fire from a
  // context where this tab's own signed-in state is real and current, so
  // there's a genuine session here worth clearing before navigating, and
  // skipping it would reintroduce the original signed-in-reader-bounced-
  // back-from-/welcome loop this function exists to prevent. skipSignOut
  // lets each call site opt into whichever behavior actually matches what it
  // knows about its own auth state, instead of keying it off the path alone.
  async function clearAndGo(path: string, opts: { skipSignOut?: boolean } = {}) {
    try {
      if (path !== "/signin" && !opts.skipSignOut && supabaseConfigured()) await supabaseClient().auth.signOut();
    } catch (e) {
      // Logged, not silent: this is the shared/library-computer sign-out
      // path (see the comment above) -- a swallowed failure here means the
      // session cookie is never cleared, so the next person on this device
      // could see the previous reader's letter, with nothing in the logs
      // to ever surface that it happened.
      console.warn("[inbox] signOut failed before navigate:", e instanceof Error ? e.message : e);
    }
    // Wipe onboarding answers (name, email, birthday, etc.) so the next
    // person on this device — shared/library/kiosk computer — doesn't get
    // them pre-filled or see this reader's email dropped into /signin.
    reset();
    window.location.assign(path);
  }

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
          {/* alpha-drift-r21-08 (found+fixed 2026-08-14): an <h1>, not a
              styled <p> -- this state fully replaces the page, so it's the
              only heading a screen-reader user navigating by heading (NVDA/
              JAWS "H" key) would ever find here. */}
          <h1 className="alpha-display text-2xl md:text-3xl font-bold tracking-tight">
            Your subscription has ended.
          </h1>
          <p className="alpha-display text-base md:text-lg leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            Want back in? Start a new letter, or reach out if something looks wrong.
          </p>
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
            <button type="button" onClick={() => clearAndGo("/welcome")} className="alpha-button">
              Start a new letter →
            </button>
            <Link
              href="/support"
              className="alpha-ui text-sm underline underline-offset-4"
              style={{ color: "var(--ink-soft)" }}
            >
              Contact support
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // Gate on `checked` + no issue so a cold-session race can't flash this
  // screen before the authed letter resolves.
  if (checked && missing && !issue) {
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
            No letter on this device yet.
          </h1>
          {signedIn ? (
            <>
              {/* Already signed in: never link to /signin or /welcome (the
                  middleware bounces a cookie-user off both back here = a dead
                  loop). Settings is not redirected, so it's a real way out. */}
              <p
                className="alpha-display text-base md:text-lg leading-relaxed"
                style={{ color: "var(--ink-soft)" }}
              >
                You&apos;re signed in. Your letters show up here once they&apos;re
                sent. Check your plan and topics in settings, or sign out to start
                over.
              </p>
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link href="/settings" className="alpha-button">
                  Go to settings →
                </Link>
                <button
                  type="button"
                  onClick={() => clearAndGo("/welcome")}
                  className="alpha-ui text-sm underline underline-offset-4"
                  style={{ color: "var(--ink-soft)" }}
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <p
                className="alpha-display text-base md:text-lg leading-relaxed"
                style={{ color: "var(--ink-soft)" }}
              >
                Already subscribed? Sign in and your letters will be right here.
                We&apos;ll email you a 6-digit code, no password. New here? Set up
                your first letter in a couple of minutes.
              </p>
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
                {/* Buttons (not Links) that clear any stale cookie first, so a
                    half-signed-in reader can't get bounced back to /inbox. */}
                <button
                  type="button"
                  onClick={() => clearAndGo("/signin")}
                  className="alpha-button"
                >
                  Sign in to see my letters →
                </button>
                <button
                  type="button"
                  onClick={() => clearAndGo("/welcome", { skipSignOut: true })}
                  className="alpha-ui text-sm underline underline-offset-4"
                  style={{ color: "var(--ink-soft)" }}
                >
                  I&apos;m new, start fresh
                </button>
              </div>
            </>
          )}
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
            <Wordmark />
          </Link>
          {/* alpha-drift-r24-02 (found+fixed 2026-08-14): ThemeSwitcher's
              own doc comment (components/ThemeSwitcher.tsx:9-22) says
              align="right" (the default, used here) is only safe when
              ThemeSwitcher is "the last item in a right-aligned
              justify-between header" -- true on /inbox/[issueId] (no
              Settings button there), but the Settings gear used to sit
              AFTER ThemeSwitcher here, so its dropdown anchored ~50px
              short of the true right edge and overflowed off the left
              side of the viewport on narrow phones (iPhone SE/mini).
              Reordered so ThemeSwitcher is genuinely last, matching the
              precondition its own default already assumes -- simpler and
              lower-risk than adding new positioning logic to a component
              every theme-switcher call site in the app shares. */}
          <div className="flex items-center gap-2">
            <AudioToggle />
            <button
              type="button"
              onClick={() => router.push("/settings" as never)}
              className="alpha-ui text-sm rounded-full p-3 border"
              style={{ borderColor: "var(--rule)", color: "var(--ink-soft)" }}
              aria-label="Settings"
            >
              ⚙
            </button>
            <ThemeSwitcher />
          </div>
        </div>
        {/* alpha-drift-r25-04: --accent-ink fails WCAG AA 4.5:1 vs --paper in most
        themes; this meta line is plain informational text, so it needs --ink-soft
        (passes 4.5:1 in all 26 themes), not --accent-ink. */}
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"
          style={{ color: "var(--ink-soft)" }}
        >
          {weekLabel(issue.weekOf).toUpperCase()} · {minutes} MIN READ · NEXT ONE SHIPS {nextSendLabel().toUpperCase()}
        </div>
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-ui text-center text-xs flex items-center justify-center gap-4"
          style={{ color: "var(--ink-soft)" }}
        >
          <Link href="/archive" className="underline underline-offset-4 hover:opacity-80 py-2 -my-2">
            Read past letters →
          </Link>
          <span aria-hidden style={{ opacity: 0.4 }}>·</span>
          <ShareButton
            context="inbox"
            url="https://alpha.everyday.report"
            title="alpha. your alpha"
            text={`${SHARE_LEAD} Worth a look:`}
            label="Tell a friend"
            className="underline underline-offset-4 hover:opacity-80 py-2 -my-2"
          />
        </div>
      </div>
      <LetterTOC issue={issue} />
      <Digest issue={issue} localTimezone />
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

// "Next one ships May 24" — the upcoming send (daily cadence: tomorrow).
// Anchored to the real 14:00 UTC cron fire time, then rendered in the
// reader's own local timezone (same convention as weekLabel above) — a
// reader at UTC+10 or higher otherwise sees this read a full day earlier
// than the day the letter actually lands on their local calendar.
function nextSendLabel(): string {
  // alpha-drift-r33-02 (2026-08-14): now shares lib/cadence.ts's
  // SEND_HOUR_UTC with components/Digest.tsx's formatDateline, instead of
  // each hardcoding its own "14:00:00Z" literal -- that drift is exactly
  // what let Digest's copy silently fall 2 hours behind the real send time.
  const d = new Date(`${nextSendIso()}T${String(SEND_HOUR_UTC).padStart(2, "0")}:00:00Z`);
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
