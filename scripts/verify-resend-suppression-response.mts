import assert from "node:assert/strict";
import {
  isConfirmedResendSuppressionDeleteResponse,
  removeResendSuppressionWithTransport,
  type ResendSuppressionTransportResponse,
} from "../lib/resend-suppression-response";

let assertions = 0;
function check(value: unknown, label: string): void {
  assertions += 1;
  assert.ok(value, label);
}

const signal = new AbortController().signal;

check(
  isConfirmedResendSuppressionDeleteResponse({
    object: "suppression",
    id: "sup_123",
    deleted: true,
  }),
  "structured successful deletion response is accepted"
);
check(
  !isConfirmedResendSuppressionDeleteResponse({
    object: "suppression",
    id: "   ",
    deleted: true,
  }),
  "blank suppression id is rejected"
);
check(
  !isConfirmedResendSuppressionDeleteResponse({
    object: "suppression",
    id: "sup_123",
    deleted: false,
  }),
  "deleted false is rejected"
);
check(
  !isConfirmedResendSuppressionDeleteResponse({
    object: "other",
    id: "sup_123",
    deleted: true,
  }),
  "wrong response object is rejected"
);
check(
  !isConfirmedResendSuppressionDeleteResponse(null),
  "null response is rejected"
);

async function runCase(
  label: string,
  responseOrError: ResendSuppressionTransportResponse | Error,
  expected: boolean,
  expectedEmail = "Reader@Example.com"
): Promise<void> {
  let seenEmail = "";
  let seenSignal: AbortSignal | null = null;
  const result = await removeResendSuppressionWithTransport(
    expectedEmail,
    async (email, requestSignal) => {
      seenEmail = email;
      seenSignal = requestSignal;
      if (responseOrError instanceof Error) throw responseOrError;
      return responseOrError;
    },
    signal
  );
  check(result === expected, label);
  check(seenEmail === expectedEmail, `${label}: transport receives the same email identifier`);
  check(seenSignal === signal, `${label}: transport receives the caller's abort signal`);
}

await runCase(
  "successful 2xx structured response is confirmed",
  { status: 200, body: { object: "suppression", id: "sup_123", deleted: true } },
  true
);
await runCase(
  "generic 404 remains unconfirmed",
  { status: 404, body: { message: "not found" } },
  false
);
await runCase(
  "malformed 2xx remains unconfirmed",
  { status: 200, body: { object: "suppression", id: "sup_123" } },
  false
);
await runCase(
  "permission error remains unconfirmed",
  { status: 403, body: { message: "forbidden" } },
  false
);
await runCase("timeout or transport throw remains unconfirmed", new Error("timeout"), false);

console.log(`Resend suppression response verification passed: ${assertions}/${assertions}`);
