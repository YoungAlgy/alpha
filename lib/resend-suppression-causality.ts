const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse the signed Resend event clock without letting JavaScript normalize an
 * impossible calendar date. Relevant webhook events fail closed when this
 * returns null instead of being stamped with handler receipt time.
 */
export function parseResendEventCreatedAt(
  value: unknown,
  nowMs = Date.now()
): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = RFC3339_PATTERN.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionalMs = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const zone = match[8];

  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "+" ? 1 : -1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const eventMs =
    Date.UTC(year, month - 1, day, hour, minute, second, fractionalMs) -
    offsetMinutes * 60_000;
  if (!Number.isFinite(eventMs) || eventMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return null;
  }
  return new Date(eventMs).toISOString();
}
