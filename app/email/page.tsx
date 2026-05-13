"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function EmailPage() {
  return (
    <StepShell stepIndex={9} prevPath="fun">
      <QuestionStep
        field="email"
        currentPath="email"
        question="Your email."
        helper="We'll send each letter here too. Magic-link login — no password to remember."
        placeholder="you@example.com"
      />
    </StepShell>
  );
}
