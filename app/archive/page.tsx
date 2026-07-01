"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { Wordmark } from "@/components/Wordmark";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";

interface ArchiveItem {
  id: string; // /inbox/<id> destination ("inbox" = the localStorage first issue)
  weekOf: string;
  firstLine: string;
}

type LoadState = "loading" | "error" | "ready";

export default function ArchivePage() {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    // Signed-in users: the DB is the source of truth. A query error must NOT
    // be masked as "no letters" — that's alarming to a paying subscriber. Only
    // fall back to localStorage when NOT signed in (or Supabase unconfigured).
    if (supabaseConfigured()) {
      try {
        const sb = supabaseClient();
        const {
          data: { session },
        } = await sb.auth.getSession();
        if (session) {
          // RLS scopes issues to auth.uid() = user_id — no explicit filter needed.
          const { data, error } = await sb
            .from("issues")
            .select("id, week_of, editor_intro")
            .order("week_of", { ascending: false });
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
          setState("ready");
          return;
        }
      } catch {
        setState("error");
        return;
      }
    }
    // Unauthenticated / unconfigured: best-effort localStorage of the first issue.
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ISSUE);
      if (raw) {
        const issue = JSON.parse(raw) as Issue;
        setItems([{ id: "inbox", weekOf: issue.weekOf, firstLine: issue.editorIntro }]);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    }
    setState("ready");
  }, []);

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
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-10">
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

        {state === "error" && (
          <div className="space-y-4">
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
                  <div className="alpha-mono mb-1" style={{ color: "var(--accent-ink)" }}>
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
