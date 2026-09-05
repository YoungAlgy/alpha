export const HARD_PRODUCT_CHECK_NAMES = [
  "resend",
  "stripe",
  "stripeWebhook",
  "checkoutBinding",
  "unsubscribe",
  "legacyCheckoutCutoff",
  "supabase",
] as const;

export type HardProductCheckName = (typeof HARD_PRODUCT_CHECK_NAMES)[number];
export type HardProductChecks = Record<HardProductCheckName, boolean>;

export function hardProductFailures(
  checks: HardProductChecks,
  accessMode: "invite" | "paid" = "paid"
): HardProductCheckName[] {
  const required = accessMode === "invite"
    ? HARD_PRODUCT_CHECK_NAMES.filter(
        (name) => !["stripe", "stripeWebhook", "checkoutBinding", "legacyCheckoutCutoff"].includes(name)
      )
    : HARD_PRODUCT_CHECK_NAMES;
  return required.filter((name) => !checks[name]);
}
