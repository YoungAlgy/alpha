#!/usr/bin/env node
// Controlled operator tool for a durable checkout-creation review. This loads
// the local Alpha env and changes production/provider state when pointed at
// production. Run only with Alex's explicit approval and reviewed evidence.
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal } from "./_load-env.mts";
import { requireExactAlphaSupabaseUrl } from "./alpha-supabase-url.mjs";
import {
  countPendingCheckoutCreationReviews,
  resolveCheckoutCreationReviewNoCreate,
  resolveCheckoutCreationReviewWithSession,
} from "../lib/checkout-creation-recovery.ts";

const [action, profileId, evidence, confirmation, ...extra] =
  process.argv.slice(2);
const usage =
  "Usage: resolve-checkout-creation-review.mts <with-session|no-create> <profile-uuid> <session-id|proof-reference> --confirm-reviewed-evidence";
if (
  extra.length > 0 ||
  !["with-session", "no-create"].includes(action || "") ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    profileId || ""
  ) ||
  !evidence ||
  confirmation !== "--confirm-reviewed-evidence"
) {
  console.error(usage);
  process.exit(1);
}
if (action === "with-session" && !/^cs_[A-Za-z0-9_]+$/.test(evidence)) {
  console.error("::error:: with-session requires an exact Stripe Session ID.");
  process.exit(1);
}
if (
  action === "no-create" &&
  (!/^(req|evt|case|ticket)_[A-Za-z0-9_-]+$/.test(evidence) ||
    evidence.length > 255)
) {
  console.error(
    "::error:: no-create requires an authoritative req_, evt_, case_, or ticket_ proof reference."
  );
  process.exit(1);
}

loadEnvLocal();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
const serviceKey =
  process.env.SUPABASE_SECRET_KEY?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  "";
if (!supabaseUrl || !serviceKey) {
  console.error("::error:: Alpha Supabase URL and service key are required.");
  process.exit(1);
}
let validatedSupabaseUrl: URL;
try {
  validatedSupabaseUrl = requireExactAlphaSupabaseUrl(
    supabaseUrl,
    "NEXT_PUBLIC_SUPABASE_URL"
  );
} catch {
  console.error(
    "::error:: NEXT_PUBLIC_SUPABASE_URL must be the dedicated Alpha Supabase HTTPS host (value withheld)."
  );
  process.exit(1);
}
if (action === "with-session" && !process.env.STRIPE_SECRET_KEY?.trim()) {
  console.error("::error:: The Alpha Stripe key is required for Session proof.");
  process.exit(1);
}

const sb = createClient(validatedSupabaseUrl.toString(), serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const before = await countPendingCheckoutCreationReviews(sb);
if (action === "with-session") {
  const result = await resolveCheckoutCreationReviewWithSession(
    sb,
    profileId,
    evidence
  );
  console.log(`Resolved checkout creation review through exact Session proof: ${result}.`);
} else {
  await resolveCheckoutCreationReviewNoCreate(sb, profileId, evidence);
  console.log("Resolved checkout creation review through authoritative no-create proof.");
}
const after = await countPendingCheckoutCreationReviews(sb);
console.log(`Pending checkout creation reviews: ${before} -> ${after}.`);
