import assert from "node:assert/strict";
import {
  prepareBrevoCandidateEmail,
  isBrevoPreparedEmail,
  sendBrevoPreparedEmail,
  type BrevoCandidateEmail,
  type BrevoHttpTransport,
  type BrevoPreparedEmail,
} from "../lib/brevo-transport.ts";

const candidate: BrevoCandidateEmail = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  sender: { email: "alpha@everyday.report", name: "alpha." },
  recipient: "reader@example.com",
  replyTo: "alpha@everyday.report",
  subject: "Offline fixture issue",
  html: "<p>Offline letter</p>",
  text: "Offline letter",
  issueHeader: "user-id:2026-09-26",
};
let assertions = 0;
const options = { apiKey: "offline-test-key" };

function equal(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
  assertions++;
}

function preparedOf(email: BrevoCandidateEmail): BrevoPreparedEmail {
  const result = prepareBrevoCandidateEmail(email);
  equal(result.status, "prepared");
  if (result.status !== "prepared") throw new Error("unexpected preparation result");
  return result.prepared;
}

let calls = 0;
const accepted: BrevoHttpTransport = async (url, init) => {
  calls++;
  equal(url, "https://api.brevo.com/v3/smtp/email");
  equal(init.method, "POST");
  equal(init.redirect, "error");
  assert.ok(init.signal);
  assertions++;
  equal(new Headers(init.headers).get("api-key"), "offline-test-key");
  equal(new Headers(init.headers).get("Idempotency-Key"), null);
  equal(JSON.parse(String(init.body)), {
    sender: candidate.sender,
    to: [{ email: candidate.recipient }],
    replyTo: { email: candidate.replyTo },
    subject: candidate.subject,
    htmlContent: candidate.html,
    textContent: candidate.text,
    headers: {
      "X-Alpha-Attempt-Id": candidate.attemptId,
      "X-Alpha-Issue-Id": candidate.issueHeader,
    },
  });
  return Response.json({ messageId: "<Case.Sensitive@Brevo>" }, { status: 201 });
};

const prepared = preparedOf(candidate);
equal(isBrevoPreparedEmail(prepared), true);
equal(prepared.recipient, candidate.recipient);
assert.ok(Object.isFrozen(prepareBrevoCandidateEmail(candidate)));
assertions++;
assert.ok(Object.isFrozen(prepared));
assertions++;
assert.match(prepared.requestFingerprint, /^[0-9a-f]{64}$/);
assertions++;
equal(JSON.parse(prepared.serializedBody), {
  sender: candidate.sender,
  to: [{ email: candidate.recipient }],
  replyTo: { email: candidate.replyTo },
  subject: candidate.subject,
  htmlContent: candidate.html,
  textContent: candidate.text,
  headers: {
    "X-Alpha-Attempt-Id": candidate.attemptId,
    "X-Alpha-Issue-Id": candidate.issueHeader,
  },
});
const first = await sendBrevoPreparedEmail(prepared, options, accepted);
equal(first.status, "accepted");
if (first.status !== "accepted") throw new Error("unexpected result");
equal(first.messageId, "Case.Sensitive@Brevo");
equal(first.requestFingerprint, prepared.requestFingerprint);
equal(calls, 1);
const bareId = await sendBrevoPreparedEmail(prepared, options, async () =>
  Response.json({ messageId: "Bare.Case@Brevo" }, { status: 201 })
);
equal(bareId.status, "accepted");
equal(bareId.status === "accepted" ? bareId.messageId : null, "Bare.Case@Brevo");

const modified = await sendBrevoPreparedEmail(
  preparedOf({ ...candidate, text: "Changed exact body" }), options,
  async () => Response.json({ messageId: "<offline-2@brevo>" }, { status: 201 })
);
assert.notEqual(modified.status === "accepted" ? modified.requestFingerprint : null, first.requestFingerprint);
assertions++;

const unicodeEmail = { ...candidate, sender: { ...candidate.sender, name: "Jos\u00e9" }, subject: "\u4eca\u65e5\u306e\u30ec\u30bf\u30fc \ud83d\udcf0" };
const unicode = await sendBrevoPreparedEmail(preparedOf(unicodeEmail), options, async (_url, init) => {
  const body = JSON.parse(String(init.body));
  equal(body.subject, unicodeEmail.subject);
  equal(body.sender.name, unicodeEmail.sender.name);
  return Response.json({ messageId: "<unicode@brevo>" }, { status: 201 });
});
equal(unicode.status, "accepted");

for (const changed of [
  { ...candidate, recipient: "different@example.com" },
  { ...candidate, attemptId: "22222222-2222-4222-8222-222222222222" },
  { ...candidate, sender: { ...candidate.sender, email: "different@example.com" } },
]) {
  const result = await sendBrevoPreparedEmail(preparedOf(changed), options, async () => Response.json({ messageId: "<changed@brevo>" }, { status: 201 }));
  equal(result.status, "accepted");
  assert.notEqual(result.status === "accepted" ? result.requestFingerprint : null, first.requestFingerprint);
  assertions++;
}

for (const invalid of [
  { ...candidate, recipient: "two@example.com, three@example.com" },
  { ...candidate, recipient: "two,three@example.com" },
  { ...candidate, recipient: "bad\u0000@example.com" },
  { ...candidate, recipient: "reader@example..com" },
  { ...candidate, attemptId: "not-a-uuid" },
  { ...candidate, attemptId: { toString: () => candidate.attemptId } as never },
  { ...candidate, issueHeader: "bad\r\nheader" },
  { ...candidate, html: "" },
  { ...candidate, subject: "bad\r\nheader" },
]) {
  const result = prepareBrevoCandidateEmail(invalid);
  equal(result, { status: "not_prepared", reason: "invalid_input" });
}
equal(prepareBrevoCandidateEmail({
  ...candidate,
  get subject(): string { throw new Error("sensitive accessor failure"); },
}), { status: "not_prepared", reason: "invalid_input" });
equal(calls, 1);
equal(await sendBrevoPreparedEmail(prepared, options, undefined as never), {
  status: "not_attempted", reason: "transport_missing",
});

for (const invalidOptions of [
  { apiKey: " " },
  { ...options, timeoutMs: 0 },
  { ...options, timeoutMs: 15_001 },
]) {
  equal(await sendBrevoPreparedEmail(prepared, invalidOptions, accepted), {
    status: "not_attempted", reason: "invalid_input",
  });
}
equal(calls, 1);

// A claimed fingerprint must stay bound to the exact bytes dispatched, even
// if the caller changes the original draft or passes a forged prepared shape.
candidate.text = "Changed after preparation";
equal(prepared.serializedBody.includes("Changed after preparation"), false);
equal(preparedOf({ ...candidate, text: "Offline letter" }).requestFingerprint, prepared.requestFingerprint);
assert.throws(() => Object.assign(prepared, { serializedBody: "{}" }));
assertions++;
let unchangedBody = "";
const afterMutation = await sendBrevoPreparedEmail(prepared, options, async (_url, init) => {
  unchangedBody = String(init.body);
  return Response.json({ messageId: "<unchanged@brevo>" }, { status: 201 });
});
equal(afterMutation.status, "accepted");
equal(unchangedBody, prepared.serializedBody);
equal(afterMutation.status === "accepted" ? afterMutation.requestFingerprint : null, prepared.requestFingerprint);
for (const forged of [
  { ...prepared },
  { ...prepared, recipient: "other@example.com" },
  { ...prepared, requestFingerprint: "0".repeat(64) },
  { ...prepared, serializedBody: "{}" },
  { ...prepared, attemptId: "22222222-2222-4222-8222-222222222222" },
]) {
  equal(isBrevoPreparedEmail(forged), false);
  equal(await sendBrevoPreparedEmail(forged, options, accepted), {
    status: "not_attempted", reason: "invalid_prepared",
  });
}
equal(calls, 1);
equal(await sendBrevoPreparedEmail(undefined as never, options, accepted), {
  status: "not_attempted", reason: "invalid_prepared",
});
equal(calls, 1);

const failures: Array<[string, BrevoHttpTransport, string]> = [
  ["429", async () => new Response(null, { status: 429 }), "http_rejected"],
  ["500", async () => new Response(null, { status: 500 }), "http_rejected"],
  ["redirect", async () => new Response(null, { status: 302 }), "redirect"],
  ["wrong success", async () => Response.json({ messageId: "x" }, { status: 200 }), "http_rejected"],
  ["bad JSON", async () => new Response("{", { status: 201 }), "invalid_response"],
  ["missing ID", async () => Response.json({}, { status: 201 }), "invalid_response"],
  ["blank ID", async () => Response.json({ messageId: " " }, { status: 201 }), "invalid_response"],
  ["stray opening angle", async () => Response.json({ messageId: "<Case.Sensitive@Brevo" }, { status: 201 }), "invalid_response"],
  ["stray closing angle", async () => Response.json({ messageId: "Case.Sensitive@Brevo>" }, { status: 201 }), "invalid_response"],
  ["nested angles", async () => Response.json({ messageId: "<<Case.Sensitive@Brevo>>" }, { status: 201 }), "invalid_response"],
  ["long ID", async () => Response.json({ messageId: "x".repeat(513) }, { status: 201 }), "invalid_response"],
  ["large body", async () => Response.json({ messageId: "<large@brevo>", extra: "x".repeat(16_384) }, { status: 201 }), "invalid_response"],
  ["injected ID", async () => Response.json({ messageId: "bad\r\nheader" }, { status: 201 }), "invalid_response"],
  ["transport throw", async () => { throw new Error("secret raw failure"); }, "transport_error"],
  ["timeout", async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), "timeout"],
  ["body timeout", async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    },
  }), { status: 201 }), "timeout"],
];

for (const [label, fake, reason] of failures) {
  let count = 0;
  const result = await sendBrevoPreparedEmail(
    prepared, { ...options, timeoutMs: 5 },
    async (url, init) => { count++; return fake(url, init); }
  );
  equal(count, 1);
  equal(result.status, "unconfirmed");
  if (result.status !== "unconfirmed") throw new Error(`${label}: unexpected result`);
  equal(result.reason, reason);
  equal(Object.keys(result).sort(), ["reason", "requestFingerprint", "status"]);
  equal(result.requestFingerprint, prepared.requestFingerprint);
}

console.log(`PASS verify-brevo-transport (${assertions} assertions, fake transport only)`);
