export function normalizeAccessRequestEmail(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export function authOwnsAccessRequestEmail(
  authEmail: string | null | undefined,
  requestedEmail: string | null | undefined
): boolean {
  const normalizedAuthEmail = normalizeAccessRequestEmail(authEmail);
  const normalizedRequestedEmail = normalizeAccessRequestEmail(requestedEmail);
  return (
    normalizedAuthEmail !== null &&
    normalizedRequestedEmail !== null &&
    normalizedAuthEmail === normalizedRequestedEmail
  );
}
