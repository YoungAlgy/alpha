import type { Metadata } from "next";
import Link from "next/link";
import { Digest } from "@/components/Digest";
import { Wordmark } from "@/components/Wordmark";
import { verifyLetterToken } from "@/lib/letter-token";
import { supabaseServiceClient } from "@/lib/supabase/server";
import { coerceThemeId } from "@/lib/themes";
import { hasActiveAccess } from "@/lib/access";
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
  const payload = t ? verifyLetterToken(t) : null;

  if (!payload) return <LinkProblem reason="expired" />;
  const { userId, weekOf } = payload;

  let issue: Issue | null = null;
  let theme: ThemeId = "forest";
  let accessEnded = false;
  try {
    const sb = await supabaseServiceClient();
    // v2 tokens name ONE issue — load exactly that letter, so every email's
    // link opens the letter that email announced. (The old always-latest
    // query made every link in every email open the same newest letter — a
    // subscriber reported all her letters looking "exactly the same".)
    // Legacy v1 tokens carry no weekOf and fall back to latest, matching
    // their historical behavior.
    let issueQuery = sb
      .from("issues")
      .select("week_of, volume, number, editor_intro, sections")
      .eq("user_id", userId);
    if (weekOf) {
      issueQuery = issueQuery.eq("week_of", weekOf);
    }
    const [{ data: userRow, error: userError }, { data: issueRow }] = await Promise.all([
      sb.from("users").select("first_name, city, theme, cancelled_at").eq("id", userId).maybeSingle(),
      issueQuery.order("week_of", { ascending: false }).limit(1).maybeSingle(),
    ]);
    // alpha-drift-r15-03: this route uses the service-role client (a signed
    // token, not a session), which bypasses the issues table's RLS policy
    // entirely -- so the cancelled_at check that policy now enforces for
    // /inbox, /archive, and /inbox/[issueId] has to be done explicitly here
    // too, or a disputed/cancelled subscriber's 90-day-lived email links
    // would keep working long after every other read path correctly cuts
    // them off. Matches hasActiveAccess()'s exact rule (lib/access.ts).
    //
    // alpha-drift-r21-07 (found+fixed 2026-08-14, self-audit): the round-20
    // deleted-account-access fix (!userError && !userRow) only reached the
    // 4 session-based pages (/inbox, /inbox/[issueId], /archive) -- this
    // route was never touched, even though it has the identical gap and a
    // WORSE blast radius: its token is valid for up to 90 days with no
    // session to invalidate, and it reads via the service-role client,
    // which bypasses RLS entirely. A cascade-deleted `users` row makes
    // userRow null; hasActiveAccess(undefined) reads that as "never
    // cancelled" i.e. active -- if issues.user_id ever survives the account
    // delete (no CASCADE, or a future schema change), this would have
    // rendered a deleted reader's orphaned letter to anyone still holding
    // the link. !userError && !userRow is a genuine zero-row result
    // (.maybeSingle()'s error is null on a real "not found"), not a query
    // failure -- so this can't misread a transient hiccup as deletion.
    const accountDeleted = !userError && !userRow;
    if (issueRow && (accountDeleted || !hasActiveAccess(userRow?.cancelled_at))) {
      accessEnded = true;
    } else if (issueRow) {
      const row = issueRow as IssueRow;
      theme = coerceThemeId(userRow?.theme) ?? "forest";
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
  } catch (e) {
    // Logged, not silent: this is the actual link paying subscribers click
    // from their weekly email. Without a log line, a real systemic failure
    // (schema drift, an RLS regression, a transient DB outage) is
    // indistinguishable from the benign "this token's issue genuinely
    // doesn't exist" case -- every clicking reader would just silently see
    // the generic no-letter fallback with no operational signal anything's wrong.
    console.error("[letter] issue lookup failed:", e instanceof Error ? e.message : e);
    issue = null;
  }

  if (accessEnded) return <LinkProblem reason="access-ended" />;
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
            <Wordmark />
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
          and we&apos;ll email you a 6-digit code, no password.
        </p>
      </div>
    </main>
  );
}

function LinkProblem({ reason }: { reason: "expired" | "no-letter" | "access-ended" }) {
  if (reason === "access-ended") {
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
            This letter isn&apos;t available anymore.
          </h1>
          <p className="alpha-display text-base" style={{ color: "var(--ink-soft)" }}>
            Your subscription has ended, so this link no longer opens. Want
            back in?
          </p>
          <div className="pt-2">
            <Link href="/welcome" className="alpha-button">
              Start a new letter →
            </Link>
          </div>
        </div>
      </main>
    );
  }
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
          {reason === "expired"
            ? "This letter link has expired."
            : "Couldn't load your letter."}
        </h1>
        <p className="alpha-display text-base" style={{ color: "var(--ink-soft)" }}>
          No worries. Sign in with your email and we&apos;ll take you straight
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
