export type CheckoutMode = "open" | "paused";

/**
 * Production checkout opens only through one exact, versioned configuration
 * value. A missing value or typo fails closed in every environment.
 */
export function checkoutMode(raw: string | undefined): CheckoutMode {
  const value = raw?.trim().toLowerCase() || "";
  if (value === "open") return "open";
  return "paused";
}
