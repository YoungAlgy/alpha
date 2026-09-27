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
export type ProductFailureName = HardProductCheckName | "subscriberEmail";

export function hardProductFailures(
  checks: HardProductChecks & { subscriberEmail?: boolean },
  accessMode: "invite" | "paid" = "paid"
): ProductFailureName[] {
  const required = accessMode === "invite"
    ? HARD_PRODUCT_CHECK_NAMES.filter(
        (name) => !["stripe", "stripeWebhook", "checkoutBinding", "legacyCheckoutCutoff"].includes(name)
      )
    : HARD_PRODUCT_CHECK_NAMES;
  const senderCheck: ProductFailureName = typeof checks.subscriberEmail === "boolean"
    ? "subscriberEmail" : "resend";
  return required.map((name) => name === "resend" ? senderCheck : name)
    .filter((name) => name === "subscriberEmail" ? !checks.subscriberEmail : !checks[name]);
}
