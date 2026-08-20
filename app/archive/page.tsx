"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { Wordmark } from "@/components/Wordmark";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import { hasActiveAccess } from "@/lib/access";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";
// alpha-drift-r15-05 (found+fixed 2026-08-07): this page had a bare
// .limit(100) with no pagination anywhere -- the newsletter sends DAILY, so
// every subscriber who stays subscribed past ~100 days silently lost access
// to everything older through this UI (no error, just gone -- and with no
// other browse/search entry point, a truncated letter became permanently
// unreachable short of knowing its raw UUID). PAGE_SIZE stays 100 (same as
// before, so the common case — most subscribers, most of the time — is
// unchanged) but a "Load more" button now fetches the next page via
// .range() instead of the list silently ending.
const PAGE_SIZE = 100;

interface ArchiveItem {
  id: string; // /inbox/<id> destination ("inbox" = the localStorage first issue)
  weekOf: string;
  firstLine: string;
}

type LoadState = "loading" | "error" | "ready" | "ended";

export default function ArchivePage() {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // load() has two call sites (mount, the retry button); loadMore() is a
  // separate function with its own independent query and its own mountedRef
  // checks -- it never calls load(). A mounted ref covering the component's
  // whole lifetime guards all three functions' async work uniformly, which
  // is simpler than a per-call cancellation flag even though load() itself
  // only has two callers. The effect body must explicitly
  // reset this to true, not just rely on useRef's initial value -- found
  // live while testing the pagination fix below: React Strict Mode (dev
  // only, reactStrictMode:true in next.config.ts) mounts effects, cleans
  // them up, then mounts them again to catch exactly this kind of bug. The
  // FIRST mount's cleanup set this false; without resetting it here, the
  // SECOND (real) mount left it permanently false, silently no-op-ing every
  // `if (!mountedRef.current) return` for the rest of the page's life --
  // the page never left its loading skeleton. Production doesn't double-
  // invoke effects, so this never showed up live, only in local `next dev`.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // alpha-drift-r44-03 (2026-08-19): the focused "Try again" button
  // unmounts the instant a retry leaves the "error" state (load()'s first
  // line synchronously sets state="loading"), replaced by the loading
  // skeleton (aria-hidden, nothing focusable) and then whatever state
  // actually resolves -- focus silently drops to <body> with no signal a
  // keyboard/screen-reader user's retry worked. Same unmount-without-
  // focus-restore class already fixed 5 times elsewhere in this app
  // (EmailChanger.tsx, app/settings/page.tsx x3, app/checkout/page.tsx).
  // The page's own "Archive" <h1> is the one element that never unmounts
  // across ANY state transition, so it's the stable focus target -- no new
  // per-state ref needed, just a flag tracking whether we were in "error"
  // last render.
  const archiveHeadingRef = useRef<HTMLHeadingElement>(null);
  const hadErrorRef = useRef(false);
  useEffect(() => {
    if (state === "error") {
      hadErrorRef.current = true;
      return;
    }
    if (hadErrorRef.current) {
      archiveHeadingRef.current?.focus();
      hadErrorRef.current = false;
    }
  }, [state]);

  const load = useCallback(async () => {
    if (mountedRef.current) setState("loading");
    // Signed-in users: the DB is the source of truth. A query error must NOT
    // be masked as "no letters" — that's alarming to a paying subscriber. Only
    // fall back to localStorage when NOT signed in (or Supabase unconfigured).
    if (supabaseConfigured()) {
      try {
        const sb = supabaseClient();
        const {
          data: { session },
        } = await sb.auth.getSession();
        if (!mountedRef.current) return;
        if (session) {
          // RLS scopes issues to auth.uid() = user_id — no explicit filter needed.
          const [{ data, error }, { data: userRow, error: userError }] = await Promise.all([
            sb
              .from("issues")
              .select("id, week_of, editor_intro")
              .order("week_of", { ascending: false })
              .range(0, PAGE_SIZE - 1),
            sb.from("users").select("cancelled_at").eq("id", session.user.id).maybeSingle(),
          ]);
          if (!mountedRef.current) return;
          // alpha-drift-r16-15: same app-level defense-in-depth as /inbox
          // and /inbox/[issueId] -- see /inbox's comment (alpha-drift-r52-01:
          // RLS also enforces this now, live since 2026-08-07, this check
          // is kept anyway).
          //
          // alpha-drift-r20-05: same deleted-account gap as /inbox -- see
          // that file's comment. A cascade-deleted `users` row makes
          // userRow null, which hasActiveAccess(undefined) misreads as
          // "active." !userError && !userRow is a genuine zero-row
          // result, not a query failure (that's handled below by the
          // separate `error` check on the issues query).
          if (!userError && !userRow) {
            setState("ended");
            return;
          }
          if (!hasActiveAccess(userRow?.cancelled_at)) {
            setState("ended");
            return;
          }
          if (error) {
            setState("error");
            return;
          }
          const rows = (data || []) as Array<{ id: string; week_of: string; editor_intro: string }>;
          setItems(
            rows.map((row) => ({
              id: row.id,
              weekOf: row.week_of,
              firstLine: row.editor_intro,
            }))
          );
          setHasMore(rows.length === PAGE_SIZE);
          setState("ready");
          return;
        }
      } catch {
        if (mountedRef.current) setState("error");
        return;
      }
    }
    // Unauthenticated / unconfigured: best-effort localStorage of the first issue.
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ISSUE);
      if (!mountedRef.current) return;
      if (raw) {
        const issue = JSON.parse(raw) as Issue;
        setItems([{ id: "inbox", weekOf: issue.weekOf, firstLine: issue.editorIntro }]);
      } else {
        setItems([]);
      }
    } catch {
      if (mountedRef.current) setItems([]);
    }
    if (mountedRef.current) setState("ready");
  }, []);

  const loadMore = useCallback(async () => {
    if (!supabaseConfigured() || loadingMore) return;
    setLoadingMore(true);
    try {
      const sb = supabaseClient();
      const {
        data: { session },
      } = await sb.auth.getSession();
      if (!mountedRef.current || !session) return;
      const from = items.length;
      // alpha-drift-r17-10 (found+fixed 2026-08-07): loadMore only ever
      // checked session existence, not hasActiveAccess -- load() (above)
      // already gates on it, but load() only runs once at mount. If a
      // subscriber's access is revoked (a dispute, a cancellation) WHILE
      // they have this page open with more pages available, "Load more"
      // fetched additional issues with no re-check. Re-check every time,
      // not just at mount.
      const [{ data, error }, { data: userRow, error: userError }] = await Promise.all([
        sb
          .from("issues")
          .select("id, week_of, editor_intro")
          .order("week_of", { ascending: false })
          .range(from, from + PAGE_SIZE - 1),
        sb.from("users").select("cancelled_at").eq("id", session.user.id).maybeSingle(),
      ]);
      if (!mountedRef.current) return;
      // alpha-drift-r20-05: same deleted-account gap as load() above.
      if (!userError && !userRow) {
        setState("ended");
        setItems([]);
        return;
      }
      if (!hasActiveAccess(userRow?.cancelled_at)) {
        setState("ended");
        setItems([]);
        return;
      }
      if (error) return; // leave the existing list intact; the button just stays visible to retry
      const rows = (data || []) as Array<{ id: string; week_of: string; editor_intro: string }>;
      setItems((prev) => [
        ...prev,
        ...rows.map((row) => ({ id: row.id, weekOf: row.week_of, firstLine: row.editor_intro })),
      ]);
      setHasMore(rows.length === PAGE_SIZE);
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [items.length, loadingMore]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 max-w-3xl mx-auto w-full flex items-center justify-between">
        <Link
          href="/inbox"
          className="alpha-display text-2xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          <Wordmark />
        </Link>
        <Link href="/inbox" className="alpha-ui text-sm py-2" style={{ color: "var(--ink-soft)" }}>
          ← Inbox
        </Link>
      </nav>

      <section className="flex-1 max-w-2xl mx-auto px-6 py-12 w-full">
        <h1 ref={archiveHeadingRef} tabIndex={-1} className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-10" style={{ outline: "none" }}>
          Archive
        </h1>

        {state === "loading" && (
          <ul className="space-y-6 animate-pulse" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="border-b pb-6" style={{ borderColor: "var(--rule)" }}>
                <div className="h-3 w-24 mb-3 rounded" style={{ background: "var(--rule)" }} />
                <div className="h-5 w-full mb-2 rounded" style={{ background: "var(--rule)" }} />
                <div className="h-5 w-3/4 rounded" style={{ background: "var(--rule)" }} />
              </li>
            ))}
          </ul>
        )}

        {state === "ended" && (
          <div className="space-y-5">
            <p className="alpha-display text-lg" style={{ color: "var(--ink)" }}>
              Your subscription has ended.
            </p>
            <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
              Want back in? Start a new letter, or reach out if something looks wrong.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link href="/welcome" className="alpha-button">
                Start a new letter →
              </Link>
              <Link
                href="/support"
                className="alpha-ui text-sm underline underline-offset-4 self-center"
                style={{ color: "var(--ink-soft)" }}
              >
                Contact support
              </Link>
            </div>
          </div>
        )}

        {state === "error" && (
          // alpha-drift-r57-03 (2026-08-20, accessibility-resweep-newer-
          // code-round-5): third sibling of the same fix -- this block only
          // ever renders on state === "error", exclusively failure copy,
          // so role="alert" (not role="status") is the app's established
          // convention here.
          <div role="alert" className="space-y-4">
            <p className="alpha-display text-lg" style={{ color: "var(--ink)" }}>
              Couldn&apos;t load your letters.
            </p>
            <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
              That&apos;s almost always a temporary hiccup. Your letters are safe.
            </p>
            <button type="button" onClick={() => load()} className="alpha-button">
              Try again
            </button>
          </div>
        )}

        {state === "ready" && items.length === 0 && (
          <div className="space-y-5">
            <p className="alpha-display text-lg" style={{ color: "var(--ink-soft)" }}>
              No letters yet. Your first one lands right after you subscribe.
            </p>
            <Link href="/inbox" className="alpha-button">
              Go to your inbox →
            </Link>
          </div>
        )}

        {state === "ready" && items.length > 0 && (
          <ul className="space-y-6">
            {items.map((item) => (
              <li key={item.id} className="border-b pb-6" style={{ borderColor: "var(--rule)" }}>
                <Link
                  href={item.id === "inbox" ? "/inbox" : `/inbox/${item.id}`}
                  className="block group py-1"
                >
                  {/* alpha-drift-r25-04: --accent-ink fails WCAG AA 4.5:1 vs --paper in
                  most themes; this week label is plain informational text, so it needs
                  --ink-soft (passes 4.5:1 in all 26 themes), not --accent-ink. */}
                  <div className="alpha-mono mb-1" style={{ color: "var(--ink-soft)" }}>
                    {weekLabel(item.weekOf).toUpperCase()}
                  </div>
                  <p className="alpha-display text-lg md:text-xl font-semibold leading-snug group-hover:opacity-70">
                    {truncate(item.firstLine, 120)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {state === "ready" && hasMore && (
          <div className="pt-8 text-center">
            <button
              type="button"
              onClick={() => loadMore()}
              disabled={loadingMore}
              className="alpha-button"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
      <Footer />
    </main>
  );
}

// Friendly week label, matching /inbox. Handles ISO ("2026-05-24" → "May 24")
// and already-formatted ("Sunday, May 24, 2026" → "May 24"); falls back to raw.
function weekLabel(weekOf: string): string {
  if (weekOf.includes(",")) {
    const m = weekOf.match(/^[^,]+,\s*([A-Za-z]+\s+\d+)/);
    return m ? m[1] : weekOf;
  }
  const d = new Date(weekOf + "T12:00:00");
  if (isNaN(d.getTime())) return weekOf;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trim() + "…";
}
