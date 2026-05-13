"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function FocusPage() {
  return (
    <StepShell stepIndex={6} prevPath="role">
      <QuestionStep
        field="projectBlurb"
        currentPath="focus"
        question="What are you working on right now?"
        helper="Optional — but the more you tell us, the more your letter feels written for you."
        placeholder="scaling our agency to 5 people this year"
        multiline
        optional
      />
    </StepShell>
  );
}
