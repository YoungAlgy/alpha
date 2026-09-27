/** Brevo's send API wraps the RFC Message-ID in angle brackets. Its webhook
 * examples omit that wrapper. Preserve the case and contents of the ID, and
 * remove only one complete outer pair. Never use this for Resend identifiers. */
export function canonicalBrevoMessageId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || value !== value.trim()) return null;
  const id = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  if (!id || !/^[\x21-\x7e]+$/.test(id) || /[<>]/.test(id)) return null;
  return id;
}
