/**
 * The Resend suppression DELETE endpoint is only confirmed when it returns a
 * successful HTTP response with the documented deletion object. A transport
 * failure, a generic 404, or an otherwise successful but malformed response
 * leaves the provider-side state unknown.
 */
export interface ResendSuppressionTransportResponse {
  status: number;
  body: unknown;
}

export type ResendSuppressionTransport = (
  email: string,
  signal: AbortSignal
) => Promise<ResendSuppressionTransportResponse>;

export function isConfirmedResendSuppressionDeleteResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const response = value as Record<string, unknown>;
  const hasOwn = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(response, key);
  return (
    hasOwn("object") &&
    hasOwn("id") &&
    hasOwn("deleted") &&
    response.object === "suppression" &&
    typeof response.id === "string" &&
    response.id.trim().length > 0 &&
    response.deleted === true
  );
}

export async function removeResendSuppressionWithTransport(
  email: string,
  transport: ResendSuppressionTransport,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const response = await transport(email, signal);
    return (
      Number.isInteger(response.status) &&
      response.status >= 200 &&
      response.status < 300 &&
      isConfirmedResendSuppressionDeleteResponse(response.body)
    );
  } catch {
    return false;
  }
}
