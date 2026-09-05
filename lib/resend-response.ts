export function requireResendMessageId(
  data: { id?: unknown } | null | undefined
): string {
  const id = typeof data?.id === "string" ? data.id.trim() : "";
  if (!id) {
    throw new Error("Resend: success response missing provider message id");
  }
  return id;
}
