"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function RolePage() {
  return (
    <StepShell stepIndex={5} prevPath="city">
      <QuestionStep
        field="jobBlurb"
        currentPath="role"
        question="What do you do?"
        placeholder="one sentence, the thing you'd say at a dinner party"
      />
    </StepShell>
  );
}
