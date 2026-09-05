#!/usr/bin/env node
// Approved live release canary. It creates a token for a fixed nonexistent
// user and performs GET only. The route validates the signature and renders a
// confirmation page without reading or changing subscriber data. Never print
// the token or UNSUBSCRIBE_SECRET.
import crypto from "node:crypto";

const secret = process.env.UNSUBSCRIBE_SECRET?.trim() || "";
const baseUrl =
  process.env.ALPHA_UNSUBSCRIBE_CANARY_URL?.trim() ||
  "https://alpha.everyday.report";
const target = new URL(baseUrl);

if (!secret) {
  console.error("::error:: UNSUBSCRIBE_SECRET is required for the canary.");
  process.exit(1);
}
if (target.protocol !== "https:" || target.hostname !== "alpha.everyday.report") {
  console.error(
    "::error:: The unsubscribe canary is restricted to https://alpha.everyday.report."
  );
  process.exit(1);
}

const canaryUserId = "00000000-0000-4000-8000-000000000000";
const signature = crypto
  .createHmac("sha256", secret)
  .update(canaryUserId)
  .digest("base64url")
  .slice(0, 16);
const token = `${canaryUserId}.${signature}`;
const endpoint = new URL("/api/unsubscribe", target);
endpoint.searchParams.set("token", token);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
let response;
try {
  response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
    signal: controller.signal,
  });
} catch (error) {
  console.error(
    `::error:: Unsubscribe canary request failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

const body = await response.text();
const referrerPolicy = response.headers.get("referrer-policy") || "";
if (
  response.status !== 200 ||
  referrerPolicy !== "no-referrer" ||
  !body.includes("Unsubscribe from alpha. letters?")
) {
  console.error(
    `::error:: Unsubscribe canary was rejected or unsafe (status ${response.status}, Referrer-Policy ${
      referrerPolicy || "missing"
    }). The GitHub/local and Worker signing secrets may differ.`
  );
  process.exit(1);
}

console.log("OK: the Alpha Worker accepted the non-mutating unsubscribe canary.");
