"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";
import { emailError } from "@/lib/validate-email";

export default function EmailPage() {
  return (
    <StepShell stepIndex={9} prevPath="fun">
      <QuestionStep
        field="email"
        currentPath="email"
        question="Your email."
        helper="Each letter goes here. To sign back in, we email you a 6-digit code. No password to remember."
        placeholder="you@example.com"
        validate={emailError}
      />
    </StepShell>
  );
}
