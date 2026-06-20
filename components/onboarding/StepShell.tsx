"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ProgressDots } from "./ProgressDots";

interface StepShellProps {
  stepIndex: number; // 1-based (Welcome = 1)
  totalSteps?: number;
  prevPath?: string;
  children: React.ReactNode;
}

export function StepShell({
  stepIndex,
  totalSteps = 11,
  prevPath,
  children,
}: StepShellProps) {
  const router = useRouter();
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 flex items-center justify-between max-w-4xl mx-auto w-full">
        <Link
          href="/welcome"
          className="alpha-display text-xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          alpha<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
        <ProgressDots current={stepIndex} total={totalSteps} />
        {prevPath ? (
          <button
            type="button"
            onClick={() => router.push(`/${prevPath}` as never)}
            className="alpha-ui text-sm"
            style={{ color: "var(--ink-soft)" }}
          >
            ← Back
          </button>
        ) : (
          <span className="w-12" aria-hidden />
        )}
      </nav>
      <div className="flex-1 flex items-center justify-center px-6 pb-16">
        <div className="w-full max-w-xl alpha-step-enter">{children}</div>
      </div>
    </main>
  );
}
