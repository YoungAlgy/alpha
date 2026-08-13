"use client";

import { StepShell } from "@/components/onboarding/StepShell";
import { QuestionStep } from "@/components/onboarding/QuestionStep";
import { BLURB_CAPS } from "@/lib/types";

// alpha-drift-r17-07 (found+fixed 2026-08-07): the old helper text
// promised "one fun item for you most days" -- reads as a concrete,
// curated, regular feature. funBlurb is only ever folded into ONE line of
// the editor's-note prompt as tone/personalization color
// (lib/engine/editor-note.ts) -- nothing in the generation pipeline
// curates a dedicated section from it, and nothing enforces "most days" or
// even "ever." Softened to describe what it actually does.
export default function FunPage() {
  return (
    <StepShell stepIndex={8} prevPath="topics">
      <QuestionStep
        field="funBlurb"
        currentPath="fun"
        question="One fun one. Something non-work you've been into?"
        helper="We'll weave this into your letters when it fits, not a daily section of its own."
        placeholder="Florida pollinator gardening"
        multiline
        optional
        maxLength={BLURB_CAPS.funBlurb}
      />
    </StepShell>
  );
}
