// Deterministic verification of app/api/stripe/checkout/route.ts's two
// money-guarding decisions, pulled out into pure functions
// (lib/checkout-guards.ts) specifically so they can be tested here: an
// inverted condition, a loosened topics.length bound, or a broken
// hasActiveAccess call in either would compile clean and pass lint,
// surfacing only via a real double-charge complaint or a paying subscriber
// stuck unable to generate a letter.
// Run: npx tsx scripts/verify-checkout-guards.mts
import { isProfileComplete, shouldBlockDoubleSubscription } from "../lib/checkout-guards.ts";

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

console.log("(1) isProfileComplete");
const EMAIL = "algy@example.com";
check("(1a) complete profile passes", isProfileComplete({ firstName: "Algy", topics: ["ai-news"], email: EMAIL }));
check("(1b) missing firstName fails", !isProfileComplete({ topics: ["ai-news"], email: EMAIL }));
check("(1c) blank/whitespace firstName fails", !isProfileComplete({ firstName: "   ", topics: ["ai-news"], email: EMAIL }));
check("(1d) missing topics fails", !isProfileComplete({ firstName: "Algy", email: EMAIL }));
check("(1e) empty topics array fails", !isProfileComplete({ firstName: "Algy", topics: [], email: EMAIL }));
check("(1f) topics not an array fails", !isProfileComplete({ firstName: "Algy", topics: "ai-news" as never, email: EMAIL }));
check(
  "(1g) exactly 25 valid topics passes (the real MAX_TOPIC_QUOTA boundary)",
  isProfileComplete({
    firstName: "Algy",
    email: EMAIL,
    topics: [
      "healthcare-recruiting", "sales-persuasion", "founder-operator", "marketing-growth",
      "personal-finance", "real-estate", "macro-markets", "longevity-wellness",
      "nutrition-food", "mental-health", "womens-health", "books-worth-your-time",
      "psychology-behavior", "parenting", "inspiring-people", "movies-tv", "music",
      "music-edm", "music-hiphop", "music-indie", "music-country", "style-fashion",
      "sports-betting", "trading-cards", "ai-news",
    ] as never,
  })
);
check(
  "(1h) 26 topics fails -- the exact bug this finding caught (checkout used to have no upper bound)",
  !isProfileComplete({
    firstName: "Algy",
    email: EMAIL,
    topics: [
      "healthcare-recruiting", "sales-persuasion", "founder-operator", "marketing-growth",
      "personal-finance", "real-estate", "macro-markets", "longevity-wellness",
      "nutrition-food", "mental-health", "womens-health", "books-worth-your-time",
      "psychology-behavior", "parenting", "inspiring-people", "movies-tv", "music",
      "music-edm", "music-hiphop", "music-indie", "music-country", "style-fashion",
      "sports-betting", "trading-cards", "ai-news", "web3-updates",
    ] as never,
  })
);
check("(1i) a garbage/invalid topic id fails", !isProfileComplete({ firstName: "Algy", topics: ["not-a-real-topic"] as never, email: EMAIL }));
check("(1j) a well-formed custom: topic passes", isProfileComplete({ firstName: "Algy", topics: ["custom:vintage synths"] as never, email: EMAIL }));
check("(1k) zodiac passes (a real, always-valid topic id)", isProfileComplete({ firstName: "Algy", topics: ["zodiac"] as never, email: EMAIL }));
check(
  "(1l) missing email fails -- the bug this finding caught (checkout used to require no email at all)",
  !isProfileComplete({ firstName: "Algy", topics: ["ai-news"] })
);
check(
  "(1m) malformed email fails (same bar /email step itself enforces)",
  !isProfileComplete({ firstName: "Algy", topics: ["ai-news"], email: "not-an-email" })
);

console.log("\n(2) shouldBlockDoubleSubscription");
check("(2a) no existing row -> never block (brand-new email)", !shouldBlockDoubleSubscription(null));
check(
  "(2b) live paying subscriber -> block",
  shouldBlockDoubleSubscription({ subscribed_at: "2026-01-01T00:00:00Z", cancelled_at: null, stripe_customer_id: "cus_123" })
);
check(
  "(2c) comp user (subscribed_at set, no stripe_customer_id) -> do NOT block, they're converting to paid",
  !shouldBlockDoubleSubscription({ subscribed_at: "2026-01-01T00:00:00Z", cancelled_at: null, stripe_customer_id: null })
);
check(
  "(2d) cancelled-and-ended subscriber -> do NOT block, they can resubscribe",
  !shouldBlockDoubleSubscription({
    subscribed_at: "2026-01-01T00:00:00Z",
    cancelled_at: "2020-01-01T00:00:00Z", // in the past -- access already ended
    stripe_customer_id: "cus_123",
  })
);
check(
  "(2e) cancel-at-period-end but still inside the paid period -> block (still an active payer)",
  shouldBlockDoubleSubscription({
    subscribed_at: "2026-01-01T00:00:00Z",
    cancelled_at: new Date(Date.now() + 30 * 86400000).toISOString(), // 30 days in the future
    stripe_customer_id: "cus_123",
  })
);
check(
  "(2f) row exists but never actually subscribed (subscribed_at null) -> do NOT block",
  !shouldBlockDoubleSubscription({ subscribed_at: null, cancelled_at: null, stripe_customer_id: "cus_123" })
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CHECKOUT GUARDS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CHECKOUT GUARDS ASSERTIONS PASS");
