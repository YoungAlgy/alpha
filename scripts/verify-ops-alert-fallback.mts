// Verifies the ops-alert webhook fallback for real:
//   1. Zero-config (current real prod state): Resend unset AND webhook unset
//      → no-op, no throw. Confirms no regression to today's default behavior.
//   2. Resend FORCED DOWN (invalid key) + a real webhook URL configured →
//      the webhook actually receives a correctly-shaped POST. Verified against
//      a real local HTTP server this script stands up itself (not a mock of
//      fetch, not a third-party echo service whose own uptime we don't control)
//      so we're checking the actual bytes our own code puts on the wire.
//   3. Resend forced down AND no webhook configured → still resolves cleanly,
//      never throws (the never-throws contract the whole alert path depends on).
// Run: npx tsx scripts/verify-ops-alert-fallback.mts
import { createServer } from "node:http";
import { loadEnvLocal } from "./_load-env.mts";
loadEnvLocal();

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// --- 1) Zero-config: today's real prod state (no webhook set yet) -----------
console.log("(1) Zero-config — matches current real prod state");
delete process.env.RESEND_API_KEY;
delete process.env.OPS_ALERT_WEBHOOK_URL;
{
  const { sendOpsAlert } = await import("../lib/email.ts?t=1");
  let threw = false;
  try {
    await sendOpsAlert("test subject", "test body");
  } catch {
    threw = true;
  }
  check("(1) no-ops cleanly, never throws", !threw);
}

// --- 2) Resend forced down, real webhook configured (local echo server) -----
console.log("(2) Resend forced down (invalid key) + real local webhook server");
{
  let received: { body: string; contentType: string | undefined } | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = { body: Buffer.concat(chunks).toString("utf8"), contentType: req.headers["content-type"] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  process.env.RESEND_API_KEY = "re_invalid_key_to_force_failure";
  process.env.OPS_ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/webhook`;

  const { sendOpsAlert } = await import("../lib/email.ts?t=2");
  const subject = `alpha ops-alert verify ${Date.now()}`;
  const body = "forced-failure verification body — should reach the webhook";
  let threw = false;
  try {
    await sendOpsAlert(subject, body);
  } catch {
    threw = true;
  }
  check("(2) does not throw even though Resend failed", !threw);
  check("(2) our local server actually received a POST", received !== null);

  const r = received as { body: string; contentType: string | undefined } | null;
  const parsed = r ? (JSON.parse(r.body) as { content?: string; text?: string }) : null;
  check("(2) content-type is application/json", r?.contentType === "application/json");
  check("(2) payload has Discord `content` field with our subject", !!parsed?.content?.includes(subject));
  check("(2) payload has Slack `text` field with our subject too", !!parsed?.text?.includes(subject));
  check("(2) payload includes the alert body", !!parsed?.content?.includes(body));

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// --- 3) Resend forced down, no webhook configured ---------------------------
console.log("(3) Resend forced down, no webhook — must still never throw");
delete process.env.OPS_ALERT_WEBHOOK_URL;
{
  const { sendOpsAlert } = await import("../lib/email.ts?t=3");
  let threw = false;
  try {
    await sendOpsAlert("test subject", "test body");
  } catch {
    threw = true;
  }
  check("(3) no webhook configured → still resolves, never throws", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("OPS-ALERT FALLBACK VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL OPS-ALERT FALLBACK ASSERTIONS PASS");
process.exit(0);
