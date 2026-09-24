#!/usr/bin/env node
// Decide whether the delivery watchdog should check coverage. This parser
// accepts literal delivery flags with an optional interactive=false hold.
// It never runs TS or accepts an environment-driven policy.
import { readFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const MAX_HEALTH_BYTES = 8192;

export function parseSubscriberDeliveryPolicy(source) {
  if (typeof source !== "string") return null;
  let withoutComments = "";
  let state = "code";
  for (let i = 0; i < source.length; i += 1) {
    const current = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (current === "\n" || current === "\r") {
        withoutComments += current;
        state = "code";
      }
    } else if (state === "block") {
      if (current === "*" && next === "/") {
        state = "code";
        i += 1;
      }
    } else if (current === "/" && next === "/") {
      withoutComments += " ";
      state = "line";
      i += 1;
    } else if (current === "/" && next === "*") {
      withoutComments += " ";
      state = "block";
      i += 1;
    } else {
      withoutComments += current;
    }
  }
  if (state === "block") return null;
  withoutComments = withoutComments.trim();
  const match = withoutComments.match(
    /^export\s+const\s+SUBSCRIBER_LETTERS_ENABLED\s*:\s*boolean\s*=\s*(true|false)\s*;(?:\s*export\s+const\s+INTERACTIVE_LETTERS_ENABLED\s*:\s*boolean\s*=\s*false\s*;)?$/
  );
  return match ? (match[1] === "true" ? "open" : "paused") : null;
}

export function decideWatchdogDeliveryMode({
  policySource,
  expectedSha,
  checkoutSha,
  healthHttpStatus,
  healthBody,
}) {
  const policyMode = parseSubscriberDeliveryPolicy(policySource);
  if (!policyMode) return { mode: "unknown", reason: "source_policy_unrecognized" };
  if (!SHA.test(expectedSha ?? "") || checkoutSha !== expectedSha) {
    return { mode: "unknown", reason: "checkout_release_ref_mismatch" };
  }
  if (healthHttpStatus !== 200) {
    return { mode: "unknown", reason: "live_health_unavailable" };
  }
  if (typeof healthBody !== "string" || Buffer.byteLength(healthBody) > MAX_HEALTH_BYTES) {
    return { mode: "unknown", reason: "live_health_invalid_size" };
  }
  let health;
  try {
    health = JSON.parse(healthBody);
  } catch {
    return { mode: "unknown", reason: "live_health_malformed" };
  }
  if (!health || Array.isArray(health) || typeof health !== "object") {
    return { mode: "unknown", reason: "live_health_malformed" };
  }
  if (health.ok !== true || health.accessMode !== "invite") {
    return { mode: "unknown", reason: "live_health_unhealthy_or_unrecognized" };
  }
  if (health.release !== expectedSha) {
    return { mode: "unknown", reason: "live_release_ref_mismatch" };
  }
  if (health.subscriberDeliveryMode !== "open" && health.subscriberDeliveryMode !== "paused") {
    return { mode: "unknown", reason: "live_delivery_mode_unrecognized" };
  }
  if (health.subscriberDeliveryMode !== policyMode) {
    return { mode: "unknown", reason: "live_source_policy_mismatch" };
  }
  return { mode: policyMode, reason: "matched" };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/alpha-watchdog-delivery-mode.mjs")) {
  try {
    const decision = decideWatchdogDeliveryMode({
      policySource: readFileSync("lib/subscriber-delivery-policy.ts", "utf8"),
      expectedSha: process.env.GITHUB_SHA,
      checkoutSha: process.env.WATCHDOG_CHECKOUT_SHA,
      healthHttpStatus: Number(process.env.WATCHDOG_HEALTH_HTTP_STATUS),
      healthBody: readFileSync(0, "utf8"),
    });
    if (decision.mode === "unknown") {
      console.error("Watchdog release state unverified: " + decision.reason);
      process.exitCode = 2;
    } else {
      process.stdout.write(decision.mode);
    }
  } catch {
    console.error("Watchdog release state unverified: local_input_unreadable");
    process.exitCode = 2;
  }
}
