"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function NamePage() {
  return (
    <StepShell stepIndex={2} prevPath="welcome">
      <QuestionStep
        field="firstName"
        currentPath="name"
        question="What's your first name?"
        placeholder="Ally"
      />
    </StepShell>
  );
}
