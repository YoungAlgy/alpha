import type { Metadata } from "next";
import Link from "next/link";
import { Digest } from "@/components/Digest";
import { verifyLetterToken } from "@/lib/letter-token";
import { supabaseServiceClient } from "@/lib/supabase/server";
import type { Issue, ThemeId } from "@/lib/types";

// The weekly email's "Read the full letter" target — the view-in-browser
// pattern. The signed token in ?t= identifies the reader, so the letter opens
// directly with NO session required: no sign-in wall, no "No letter yet" dead
// end on a fresh device (a real subscriber hit that). Scope is read-only — a
// "Sign in" link covers settings/archive, which still require a session.
//
// noindex: tokenized URLs must never be indexed. referrer no-referrer: the
// letter is full of outbound source links — never leak the token via Referer.
export const metadata: Metadata = {
  title: "Your letter",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const THEMES: ReadonlySet<string> = new Set([
  "soft", "linen", "ink", "cottage", "arcade", "marina", "midnight", "forest", "mono", "sunset",
]);

interface IssueRow {
  week_of: string;
  volume: number;
  number: number;
  editor_intro: string;
  sections: Issue["sections"];
}

export default async function LetterPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const userId = t ? verifyLetterToken(t) : null;

  if (!userId) return <LinkProblem reason="expired" />;

  let issue: Issue | null = null;
  let theme: ThemeId = "forest";
  try {
    const sb = await supabaseServiceClient();
    const [{ data: userRow }, { data: issueRow }] = await Promise.all([
      sb.from("users").select("first_name, city, theme").eq("id", userId).maybeSingle(),
      sb
        .from("issues")
        .select("week_of, volume, number, editor_intro, sections")
        .eq("user_id", userId)
        .order("week_of", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (issueRow) {
      const row = issueRow as IssueRow;
      if (userRow?.theme && THEMES.has(userRow.theme)) theme = userRow.theme as ThemeId;
      issue = {
        id: `${userId}-${row.week_of}`,
        volume: row.volume,
        number: row.number,
        weekOf: row.week_of,
        recipientFirstName: userRow?.first_name || "you",
        recipientCity: userRow?.city || "",
        editorIntro: row.editor_intro,
        sections: row.sections,
      };
    }
  } catch {
    issue = null;
  }

  if (!issue) return <LinkProblem reason="no-letter" />;

  return (
    <main className="flex-1">
      {/* Apply the reader's saved theme before paint. ThemeApplier won't
          override it here: on a session-less device it has no local theme and
          no signed-in user, so it leaves data-theme alone. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `document.documentElement.setAttribute("data-theme",${JSON.stringify(theme)});`,
        }}
      />
      <div
        className="w-full border-b"
        style={{ background: "var(--paper)", borderColor: "var(--rule)" }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <span
            className="alpha-display text-xl font-bold leading-none"
            style={{ color: "var(--ink)" }}
          >
            alpha<span style={{ color: "var(--accent)" }}>.</span>
          </span>
          <Link
            href="/signin"
            className="alpha-ui text-sm"
            style={{ color: "var(--ink-soft)" }}
          >
            Sign in →
          </Link>
        </div>
        <div
          className="max-w-5xl mx-auto px-6 pb-3 alpha-mono text-center"
          style={{ color: "var(--accent-ink)" }}
        >
          YOUR LETTER · SIGN IN TO CHANGE TOPICS OR READ PAST ISSUES
        </div>
      </div>
      <Digest issue={issue} />
      <div className="max-w-2xl mx-auto px-6 pb-16 text-center">
        <p className="alpha-ui text-sm" style={{ color: "var(--ink-soft)" }}>
          Want to change your topics, read past letters, or manage billing?{" "}
          <Link
            href="/signin"
            className="underline underline-offset-4"
            style={{ color: "var(--accent-ink)" }}
          >
            Sign in
          </Link>{" "}
          — we&apos;ll email you a 6-digit code, no password.
        </p>
      </div>
    </main>
  );
}

function LinkProblem({ reason }: { reason: "expired" | "no-letter" }) {
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
          {reason === "expired"
            ? "This letter link has expired."
            : "Couldn't load your letter."}
        </p>
        <p className="alpha-display text-base" style={{ color: "var(--ink-soft)" }}>
          No worries — sign in with your email and we&apos;ll take you straight
          to your latest letter. We&apos;ll send a 6-digit code, no password.
        </p>
        <div className="pt-2">
          <Link href="/signin" className="alpha-button">
            Sign in to read it →
          </Link>
        </div>
      </div>
    </main>
  );
}
