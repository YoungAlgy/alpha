"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function FunPage() {
  return (
    <StepShell stepIndex={8} prevPath="topics">
      <QuestionStep
        field="funBlurb"
        currentPath="fun"
        question="One fun one. Something non-work you've been into?"
        helper="We'll find one fun item for you most weeks."
        placeholder="Florida pollinator gardening"
        multiline
        optional
      />
    </StepShell>
  );
}
