import assert from "node:assert/strict";
import { parseBrevoCanaryRequest } from "../lib/brevo-canary-policy";

const id = "a1111111-1111-4111-8111-111111111111";
let checks = 0;
function same(actual: unknown, expected: unknown) { assert.deepEqual(actual, expected); checks++; }
function parse(query: string, enabled: boolean) {
  return parseBrevoCanaryRequest(new URLSearchParams(query), enabled);
}

same(parse("", false), { kind: "normal" });
same(parse(`canaryUserId=${id}&canaryProvider=brevo`, false),
  { kind: "rejected", status: 403, error: "Brevo canary is disabled in this runtime." });
same(parse(`canaryUserId=${id}&canaryProvider=brevo`, true), { kind: "canary", userId: id });
for (const query of [
  "", `canaryUserId=${id}`, "canaryProvider=brevo",
  `canaryUserId=${id}&canaryProvider=resend`,
  `canaryUserId=${id}&canaryProvider=brevo&weekOf=2026-09-25`,
  `canaryUserId=${id}&canaryProvider=brevo&force=1`,
  `canaryUserId=${id}&canaryProvider=brevo&afterUserId=${id}`,
  `canaryUserId=${id}&canaryProvider=brevo&canaryUserId=${id}`,
  `canaryUserId=${id}&canaryProvider=brevo&extra=1`,
  `canaryUserId=${id.toUpperCase()}&canaryProvider=brevo`,
  "canaryUserId=not-a-uuid&canaryProvider=brevo",
]) {
  same(parse(query, true).kind, "rejected");
}
console.log(`Brevo canary request policy passed (${checks} assertions).`);
