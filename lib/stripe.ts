// Stripe constants — product + price live IDs (Ava Health account).
// Migrate these to a dedicated Alpha Stripe account before launch.

export const STRIPE_PRODUCT_ID = "prod_UVcUqAHSuYKPyZ";
export const STRIPE_PRICE_ID = "price_1TWbFhGM5O9KGa0pDFjHXKLC";
export const STRIPE_PRICE_AMOUNT_CENTS = 500;
export const STRIPE_CURRENCY = "usd";

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
