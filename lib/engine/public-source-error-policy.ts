import { PublicSourceBudgetError } from "./public-source-budget";
import { PublicSourceCircuitError } from "./public-source-circuit";
import { PublicSourceControlError } from "./public-source-control-error";
export { PublicSourceControlError } from "./public-source-control-error";

export function isPublicSourceControlError(error: unknown): boolean {
  return error instanceof PublicSourceControlError ||
    error instanceof PublicSourceBudgetError ||
    error instanceof PublicSourceCircuitError;
}
