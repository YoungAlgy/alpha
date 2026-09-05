import type Stripe from "stripe";

// Temporary bridge for Checkout Sessions created by the last pre-Round-80
// release. That release stored only these two Alpha-specific metadata fields
// and had no staged profile/browser nonce. The cutoff must be the actual
// production cutover instant. A planned date is unsafe because a delayed
// deploy would reject valid paid Sessions created by the still-live old app.
export function legacyCheckoutRootCutoffUnix(
  raw: string | undefined = process.env.LEGACY_CHECKOUT_ROOT_CUTOFF_ISO
): number {
  const value = raw?.trim() ?? "";
  const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const parsed = Date.parse(value);
  if (!utcTimestamp.test(value) || !Number.isFinite(parsed)) {
    throw new Error(
      "LEGACY_CHECKOUT_ROOT_CUTOFF_ISO must be set to the actual Round 80 production cutover timestamp"
    );
  }
  return Math.floor(parsed / 1000);
}

export type LegacyCheckoutMetadata = {
  firstName: string;
  city: string | null;
};

export function legacyCheckoutMetadata(
  root: Stripe.Checkout.Session,
  rootCutoffUnix: number = legacyCheckoutRootCutoffUnix()
): LegacyCheckoutMetadata | null {
  const meta = root.metadata ?? {};
  const firstName = meta.alpha_first_name?.trim() ?? "";
  const city = meta.alpha_city?.trim() || null;
  if (
    meta.alpha_profile_id ||
    !firstName ||
    firstName.length > 60 ||
    (city?.length ?? 0) > 120 ||
    root.created >= rootCutoffUnix ||
    root.mode !== "subscription" ||
    root.recovered_from
  ) {
    return null;
  }
  return { firstName, city };
}

export async function resolveLegacyCheckoutMetadata(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  rootCutoffUnix: number = legacyCheckoutRootCutoffUnix()
): Promise<LegacyCheckoutMetadata | null> {
  const recoveredFrom = session.recovered_from;
  if (!recoveredFrom) return legacyCheckoutMetadata(session, rootCutoffUnix);

  const root =
    typeof recoveredFrom === "string"
      ? await stripe.checkout.sessions.retrieve(recoveredFrom)
      : recoveredFrom;
  const rootMetadata = legacyCheckoutMetadata(root, rootCutoffUnix);
  if (
    !rootMetadata ||
    root.status !== "expired" ||
    session.metadata?.alpha_first_name !== root.metadata?.alpha_first_name ||
    (session.metadata?.alpha_city ?? "") !== (root.metadata?.alpha_city ?? "")
  ) {
    return null;
  }
  return rootMetadata;
}
