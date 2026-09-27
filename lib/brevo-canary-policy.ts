export type BrevoCanaryRequest =
  | { kind: "normal" }
  | { kind: "canary"; userId: string }
  | { kind: "rejected"; status: number; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The isolated Actions server must opt in. Its canary invocation cannot
 * accidentally fall through to a normal page or a historical/forced lane. */
export function parseBrevoCanaryRequest(
  searchParams: URLSearchParams,
  workflowCanaryMode: boolean,
): BrevoCanaryRequest {
  const hasCanaryInput = searchParams.has("canaryUserId") || searchParams.has("canaryProvider");
  if (!workflowCanaryMode) {
    return hasCanaryInput
      ? { kind: "rejected", status: 403, error: "Brevo canary is disabled in this runtime." }
      : { kind: "normal" };
  }
  const keys = [...searchParams.keys()];
  if (keys.length !== 2 || keys.some((key) => key !== "canaryUserId" && key !== "canaryProvider") ||
      searchParams.getAll("canaryUserId").length !== 1 ||
      searchParams.getAll("canaryProvider").length !== 1) {
    return { kind: "rejected", status: 400, error: "Canary requires only canaryUserId and canaryProvider." };
  }
  const userId = searchParams.get("canaryUserId") ?? "";
  if (!UUID.test(userId) || searchParams.get("canaryProvider") !== "brevo") {
    return { kind: "rejected", status: 400, error: "Canary requires an exact UUID and canaryProvider=brevo." };
  }
  return { kind: "canary", userId };
}
