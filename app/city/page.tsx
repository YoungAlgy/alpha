"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";

export default function CityPage() {
  return (
    <StepShell stepIndex={4} prevPath="name">
      <QuestionStep
        field="city"
        currentPath="city"
        question="Where are you?"
        placeholder="St. Petersburg, FL"
        helper="We use this to localize the local-flavor items in your letter (events, weather windows, regional news). Never shared."
      />
    </StepShell>
  );
}
