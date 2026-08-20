"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ProgressDots } from "./ProgressDots";
import { Wordmark } from "../Wordmark";

interface StepShellProps {
  stepIndex: number; // 1-based (Welcome = 1)
  totalSteps?: number;
  prevPath?: string;
  // alpha-drift-r46-02 (2026-08-19): checkout/page.tsx passes this while
  // subscribe() is in flight -- without it, Back was reachable during the
  // POST /api/stripe/checkout await, letting a reader navigate off /checkout
  // right before a late window.location.href/router.push fired on top of
  // wherever they'd since gone.
  backDisabled?: boolean;
  children: React.ReactNode;
}

export function StepShell({
  stepIndex,
  totalSteps = 11,
  prevPath,
  backDisabled = false,
  children,
}: StepShellProps) {
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);

  // Every step transition is a client-side navigation to a new route/page
  // component, which drops focus to <body> unless something on the new page
  // claims it. QuestionStep-based steps (name/city/role/focus/fun/email)
  // happen to work today only because their input has autoFocus -- every
  // OTHER step (theme/topics/you) has no autoFocus'd control anywhere, so
  // landing on one after Continue silently drops focus. Only steal focus
  // when nothing has already claimed it: React commits the whole tree
  // (including a child's autoFocus, applied during commit) before any
  // passive useEffect runs, so this check correctly backs off for the
  // QuestionStep pages instead of fighting their own autoFocus.
  useEffect(() => {
    if (typeof document !== "undefined" && document.activeElement === document.body) {
      contentRef.current?.focus();
    }
  }, [stepIndex]);

  return (
    <main className="min-h-screen flex flex-col">
      <nav className="px-6 py-6 flex items-center justify-between max-w-4xl mx-auto w-full">
        <Link
          href="/welcome"
          className="alpha-display text-xl font-bold leading-none"
          style={{ color: "var(--ink)" }}
        >
          <Wordmark />
        </Link>
        <ProgressDots current={stepIndex} total={totalSteps} />
        {prevPath ? (
          <button
            type="button"
            disabled={backDisabled}
            onClick={() => router.push(`/${prevPath}` as never)}
            className="alpha-ui text-sm py-3 -my-3"
            style={{ color: "var(--ink-soft)", opacity: backDisabled ? 0.5 : 1 }}
          >
            ← Back
          </button>
        ) : (
          <span className="w-12" aria-hidden />
        )}
      </nav>
      <div className="flex-1 flex items-center justify-center px-6 pb-16">
        <div ref={contentRef} tabIndex={-1} style={{ outline: "none" }} className="w-full max-w-xl alpha-step-enter">
          {children}
        </div>
      </div>
    </main>
  );
}
