export type AccessRequestAcknowledgement = "requested" | "repaired";

/** The API's normal-write and approved-profile-repair acknowledgements.
 * A successful HTTP status alone cannot prove that either write completed. */
export function parseAccessRequestAcknowledgement(value: unknown): AccessRequestAcknowledgement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Object.hasOwn(body, "ok") || body.ok !== true) return null;
  if (Object.hasOwn(body, "repaired")) {
    return body.repaired === true && !Object.hasOwn(body, "requestedAt") ? "repaired" : null;
  }
  if (!Object.hasOwn(body, "requestedAt") || typeof body.requestedAt !== "string") return null;
  const requestedAt = new Date(body.requestedAt);
  // The server emits Date.toISOString(). Exact round-trip rejects rollover
  // dates, loose date strings and otherwise malformed success values.
  return Number.isFinite(requestedAt.getTime()) && requestedAt.toISOString() === body.requestedAt
    ? "requested" : null;
}
