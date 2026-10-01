import { PublicSourceBudgetError } from "./public-source-budget";
import { PublicSourceCircuitError } from "./public-source-circuit";

/** Local admission, queue and quota controls are not upstream source failures. */
export class PublicSourceControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSourceControlError";
  }
}

export function isPublicSourceControlError(error: unknown): boolean {
  return error instanceof PublicSourceControlError ||
    error instanceof PublicSourceBudgetError ||
    error instanceof PublicSourceCircuitError;
}
