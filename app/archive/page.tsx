"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { supabaseClient, supabaseConfigured } from "@/lib/supabase/client";
import type { Issue } from "@/lib/types";

const STORAGE_KEY_ISSUE = "alpha-first-issue";

interface ArchiveItem {
  id: string; // /inbox/<id> destination
  weekOf: string;
  firstLine: string;
  recipientFirstName: string;
}

export default function ArchivePage() {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      if (supabaseConfigured()) {
        try {
          const sb = supabaseClient();
          const { data: { session } } = await sb.auth.getSession();
          if (session) {
            const { data, error } = await sb
              .from("issues")
              .select("id, week_of, editor_intro")
              .order("week_of", { ascending: false });
            const { data: userRow } = await sb
              .from("users")
              .select("first_name")
              .eq("id", session.user.id)
              .maybeSingle();
            if (!error && data && data.length > 0) {
              const rows = data as Array<{ id: string; week_of: string; editor_intro: string }>;
              setItems(
                rows.map((row) => ({
                  id: row.id,
                  weekOf: row.week_of,
                  firstLine: row.editor_intro,
                  recipientFirstName: userRow?.first_name || "you",
                }))
              );
              setLoaded(true);
              return;
            }
          }
        } catch {
          // fall through
        }
      }
      try {
        const raw = localStorage.getItem(STORAGE_KEY_ISSUE);
        if (raw) {
          const issue = JSON.parse(raw) as Issue;
          setItems([{
            id: "inbox", // localStorage issue lives at /inbox (not /inbox/[id])
            weekOf: issue.weekOf,
            firstLine: issue.editorIntro,
            recipientFirstName: issue.recipientFirstName,
          }]);
        }
      } catch {
        // ignore
      }
      setLoaded(true);
    })();
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

        {!loaded ? (
          <ul className="space-y-6 animate-pulse">
            {[0, 1].map((i) => (
              <li key={i} className="border-b pb-6" style={{ borderColor: "var(--rule)" }}>
                <div className="h-3 w-24 mb-3 rounded" style={{ background: "var(--rule)" }} />
                <div className="h-5 w-full mb-2 rounded" style={{ background: "var(--rule)" }} />
                <div className="h-5 w-3/4 rounded" style={{ background: "var(--rule)" }} />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <p className="alpha-display text-lg" style={{ color: "var(--ink-soft)" }}>
            No letters yet. Your first one ships after subscribing.
          </p>
        ) : (
          <ul className="space-y-6">
            {items.map((item) => (
              <li
                key={item.id}
                className="border-b pb-6"
                style={{ borderColor: "var(--rule)" }}
              >
                <Link
                  href={item.id === "inbox" ? "/inbox" : `/inbox/${item.id}`}
                  className="block group"
                >
                  <div className="alpha-mono mb-1" style={{ color: "var(--ink-soft)" }}>
                    {item.weekOf.toUpperCase()}
                  </div>
                  <p className="alpha-display text-lg md:text-xl font-semibold group-hover:opacity-70">
                    Hi {item.recipientFirstName}, — {truncate(item.firstLine, 110)}
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
