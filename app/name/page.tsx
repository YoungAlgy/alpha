"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function NamePage() {
  return (
    <StepShell stepIndex={3} prevPath="theme">
      <QuestionStep
        field="firstName"
        currentPath="name"
        question="What's your first name?"
        placeholder="you"
      />
    </StepShell>
  );
}
