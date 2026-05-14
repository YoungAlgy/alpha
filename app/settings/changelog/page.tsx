import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Changelog — Alpha",
  robots: { index: false, follow: false },
};

type Tag = "new" | "improved" | "fixed" | "reliability" | "security";

interface Entry {
  date: string; // ISO yyyy-mm-dd
  title: string;
  body: string;
  tag: Tag;
}

// Hand-curated. Edit this array to add new entries — never auto-generated.
const ENTRIES: Entry[] = [
  {
    date: "2026-05-14",
    title: "Better recovery if the first letter hits a snag",
    body:
      "On the rare chance the engine stumbles right after you pay, the screen now auto-retries once, then shows a clear card explaining your subscription is fine, with one-click options to try again, jump to your inbox, or email support.",
    tag: "improved",
  },
  {
    date: "2026-05-14",
    title: "Tighter editorial bar on what makes it into your letter",
    body:
      "Tuned the letter-writing prompt to prefer primary sources over aggregators, skip stale and SEO-listicle items, and never double up two pieces on the same story. Three picks, all earning their slot.",
    tag: "improved",
  },
  {
    date: "2026-05-14",
    title: "Weekly letter actually ships every Sunday now",
    body:
      "A Sunday-at-10am-ET cron loops every active subscriber, generates a fresh personalized letter from your topics, and emails it. Topic blurbs cache across subscribers each week so it's fast and consistent — the first subscriber on a given topic pays the Claude cost, everyone else reads the same well-edited section.",
    tag: "new",
  },
  {
    date: "2026-05-13",
    title: "Letter emails point at /inbox, not a magic link",
    body:
      "Now that sign-in uses a 6-digit code, the \"Read the full letter →\" button in your weekly email just opens the inbox. If you got signed out, there's a small \"Request a new code\" link below it.",
    tag: "improved",
  },
  {
    date: "2026-05-13",
    title: "Magic-link sign-in handles both flow types",
    body:
      "The auth callback now recognizes both PKCE (?code=…) and implicit-flow (#access_token=…) magic links, so clicking the link in any letter — or returning from checkout — lands you signed in instead of dropping you on a sign-in error page.",
    tag: "fixed",
  },
  {
    date: "2026-05-13",
    title: "Signed in automatically after checkout",
    body:
      "Subscribing now lands you on your inbox already signed in, on the clean youngalgy.com URL. Previously you'd bounce back to /welcome with no session and have to sign in again from the email.",
    tag: "fixed",
  },
  {
    date: "2026-05-13",
    title: "Theme picks first — and applies to the whole app",
    body:
      "Pick your look as step 2 of onboarding, before name and topics. The chosen theme now paints every page — onboarding, inbox, settings — not just the letter itself. Change it anytime from settings and the app re-paints instantly.",
    tag: "new",
  },
  {
    date: "2026-05-13",
    title: "Sign in with a 6-digit code, not a magic link",
    body:
      "Cleaner on mobile and faster overall. Enter your email, get a code, type it in. The email is fully branded and comes from alpha@youngalgy.com.",
    tag: "improved",
  },
  {
    date: "2026-05-13",
    title: "Sports & betting markets is now a topic",
    body:
      "Edges, line movement, model-vs-market gaps — plus the games and storylines shaping the week. Pick it from /topics.",
    tag: "new",
  },
  {
    date: "2026-05-13",
    title: "Two pairs of topics consolidated",
    body:
      "\"AI news\" and \"AI tools for work\" merged into one stronger topic. \"Personal finance\" and \"solo/side income\" likewise. The catalog is tighter and each section has more texture.",
    tag: "improved",
  },
  {
    date: "2026-05-13",
    title: "Letter & sign-in emails come from alpha@youngalgy.com",
    body:
      "Moved transactional email to AWS SES with verified DKIM. Subject lines, sender name, and email design all match the rest of Alpha.",
    tag: "improved",
  },
  {
    date: "2026-05-13",
    title: "Settings: changing theme no longer drops paying users into the funnel",
    body:
      "If you're signed in and tap Change theme or Change topics, the choice now saves directly to your account and returns you to settings. Previously it dumped you back through onboarding and re-checkout.",
    tag: "fixed",
  },
  {
    date: "2026-05-13",
    title: "Email input no longer clips descenders",
    body:
      "Letters with descenders (y, g, p, q) were being cut off at the bottom of the email field during onboarding. Wider line-height and bottom padding on form inputs fixes it.",
    tag: "fixed",
  },
  {
    date: "2026-05-13",
    title: "Subscribe button reliability",
    body:
      "A stripped trailing character in a stored credential caused Stripe checkout to fail with a vague error. Now defensively trimmed and the checkout fully completes on first try.",
    tag: "reliability",
  },
];

function groupByMonth(entries: Entry[]): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  for (const e of sorted) {
    const d = new Date(e.date + "T00:00:00");
    const key = d.toLocaleString("en-US", { month: "long", year: "numeric" });
    const arr = map.get(key) || [];
    arr.push(e);
    map.set(key, arr);
  }
  return map;
}

function formatShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

const TAG_COLORS: Record<Tag, { bg: string; ink: string; label: string }> = {
  new: { bg: "rgba(98, 80, 168, 0.14)", ink: "#5947A5", label: "new" },
  improved: { bg: "rgba(60, 132, 80, 0.16)", ink: "#2F6B40", label: "improved" },
  fixed: { bg: "rgba(212, 158, 60, 0.18)", ink: "#8A6324", label: "fixed" },
  reliability: { bg: "rgba(63, 113, 158, 0.16)", ink: "#2F587C", label: "reliability" },
  security: { bg: "rgba(176, 65, 65, 0.16)", ink: "#8B3434", label: "security" },
};

function TagChip({ tag }: { tag: Tag }) {
  const c = TAG_COLORS[tag];
  return (
    <span
      className="alpha-mono inline-block px-2 py-1 rounded-full"
      style={{
        background: c.bg,
        color: c.ink,
        fontSize: 10,
        letterSpacing: "0.14em",
      }}
    >
      {c.label.toUpperCase()}
    </span>
  );
}

export default function ChangelogPage() {
  const grouped = groupByMonth(ENTRIES);
  const sorted = [...ENTRIES].sort((a, b) => b.date.localeCompare(a.date));
  const lastUpdated = sorted[0]?.date;
  const lastUpdatedLabel = lastUpdated
    ? new Date(lastUpdated + "T00:00:00").toLocaleString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "";

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
          href="/settings"
          className="alpha-ui text-sm"
          style={{ color: "var(--ink-soft)" }}
        >
          ← Back to settings
        </Link>
      </nav>

      <section className="flex-1 max-w-3xl mx-auto px-6 py-8 md:py-12 w-full">
        <div
          className="alpha-mono mb-3"
          style={{ color: "var(--ink-soft)" }}
        >
          {lastUpdatedLabel ? `LAST UPDATED ${lastUpdatedLabel.toUpperCase()}` : ""}
        </div>
        <h1 className="alpha-display text-4xl md:text-5xl font-bold tracking-tight mb-4">
          Changelog
        </h1>
        <p
          className="alpha-display text-lg leading-relaxed mb-12"
          style={{ color: "var(--ink-soft)" }}
        >
          What's new, improved, and fixed in Alpha.
        </p>

        {Array.from(grouped.entries()).map(([month, entries]) => (
          <section key={month} className="mb-12">
            <h2
              className="alpha-mono mb-4"
              style={{ color: "var(--accent-ink)" }}
            >
              {month.toUpperCase()}
            </h2>
            <ul className="space-y-6">
              {entries.map((e, i) => (
                <li
                  key={i}
                  className="pt-6 border-t"
                  style={{ borderColor: "var(--rule)" }}
                >
                  <div className="flex items-baseline justify-between gap-4 mb-2 flex-wrap">
                    <div className="flex items-baseline gap-3">
                      <span
                        className="alpha-mono"
                        style={{ color: "var(--ink-soft)" }}
                      >
                        {formatShort(e.date).toUpperCase()}
                      </span>
                      <h3 className="alpha-display text-lg md:text-xl font-semibold leading-tight">
                        {e.title}
                      </h3>
                    </div>
                    <TagChip tag={e.tag} />
                  </div>
                  <p
                    className="alpha-display text-base leading-relaxed"
                    style={{ color: "var(--ink-soft)" }}
                  >
                    {e.body}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
      <Footer />
    </main>
  );
}
