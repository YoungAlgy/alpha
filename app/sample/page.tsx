import Link from "next/link";
import { Digest } from "@/components/Digest";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";

export default function SamplePage() {
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
          <ThemeSwitcher />
        </div>
      </div>
      <Digest issue={SAMPLE_ISSUE} />
      <div className="max-w-2xl mx-auto px-6 pb-24 text-center">
        <Link href="/start" className="alpha-button alpha-button-accent">
          Start for $5/mo →
        </Link>
        <p
          className="alpha-ui text-sm mt-4"
          style={{ color: "var(--ink-soft)" }}
        >
          cancel anytime
        </p>
      </div>
    </main>
  );
}
