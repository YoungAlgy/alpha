// Stripe constants — product + price live IDs on the dedicated Alpha account
// (account acct_1TWfDlAhrDpDN9sH, separate from Ava Health). Migration done
// so Checkout chrome shows Alpha branding instead of Ava.

export const STRIPE_PRODUCT_ID = "prod_UVh2HeQDa8KfyC";
export const STRIPE_PRICE_ID = "price_1TWfeHAhrDpDN9sHC2Ay0w7h";
export const STRIPE_PRICE_AMOUNT_CENTS = 500;
export const STRIPE_CURRENCY = "usd";

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
