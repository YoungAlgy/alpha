import Link from "next/link";
import { Digest } from "@/components/Digest";
import { generateIssue } from "@/lib/engine/assemble";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import type { UserProfile } from "@/lib/types";

// V0 test: hardcoded profile for Ally (the editorial muse).
// Real users get their profile from Supabase post-onboarding.
const ALLY: UserProfile = {
  firstName: "Ally",
  city: "St. Petersburg, FL",
  jobBlurb: "co-founder of a healthcare recruiting agency",
  projectBlurb:
    "scaling the agency from 2 founders to 5 people in the next year",
  funBlurb: "Florida pollinator gardening and inspiring people profiles",
  topics: [
    "healthcare-recruiting",
    "sales-persuasion",
    "fl-gardening",
    "inspiring-people",
    "books-worth-your-time",
  ],
  theme: "forest",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TestLetterPage() {
  const t0 = Date.now();
  const issue = await generateIssue(ALLY, "2026-05-17");
  const ms = Date.now() - t0;

  return (
    <main className="flex-1">
      <div
        className="w-full sticky top-0 z-40"
        style={{ background: "var(--paper)" }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="alpha-ui text-sm"
            style={{ color: "var(--ink-soft)" }}
          >
            ← Back
          </Link>
          <div className="flex items-center gap-3">
            <span
              className="alpha-mono"
              style={{ color: "var(--ink-soft)" }}
            >
              GENERATED IN {(ms / 1000).toFixed(1)}S
            </span>
            <ThemeSwitcher />
          </div>
        </div>
      </div>
      <Digest issue={issue} />
    </main>
  );
}
