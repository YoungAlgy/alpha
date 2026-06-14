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
        helper="Lets the letter know when something nearby is worth mentioning: local events, weather windows, regional news. Never shared."
      />
    </StepShell>
  );
}
