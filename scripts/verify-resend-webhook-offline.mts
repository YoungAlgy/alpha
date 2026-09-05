// Execute the actual route with a signed fixture, isolated imports and no
// network, real env, framework server, or database. Any unexpected import fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { Webhook } from "svix";

const secret = `whsec_${Buffer.from("alpha-offline-webhook-fixture-only").toString("base64")}`;
const compiled = ts.transpileModule(readFileSync(new URL("../app/api/webhooks/resend/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const guards = await import("../lib/resend-webhook-guards");
const clocks = await import("../lib/resend-suppression-causality");
let checks = 0;

async function run(event: unknown, data: unknown, options: { error?: unknown; badSignature?: boolean; configured?: boolean } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const alerts: unknown[][] = [];
  const logs: unknown[][] = [];
  const exports: { POST?: (req: Request) => Promise<Response> } = {};
  const context = vm.createContext({
    exports,
    process: { env: options.configured === false ? {} : { RESEND_WEBHOOK_SECRET: secret } },
    console: { warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
    require(name: string) {
      if (name === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      if (name === "svix") return { Webhook };
      if (name === "@/lib/resend-webhook-guards") return guards;
      if (name === "@/lib/resend-suppression-causality") return clocks;
      if (name === "@/lib/email") return { sendOpsWebhookAlert: async (...args: unknown[]) => { alerts.push(args); return true; } };
      if (name === "@/lib/supabase/server") return {
        supabaseServiceClient: async () => ({ rpc: async (rpcName: string, args: Record<string, unknown>) => {
          calls.push({ name: rpcName, args });
          return { data, error: options.error ?? null };
        } }),
      };
      throw new Error(`Unexpected route import: ${name}`);
    },
  });
  vm.runInContext(compiled, context, { timeout: 1000 });
  const payload = JSON.stringify(event);
  const timestamp = new Date();
  const id = "offline-svix-event";
  const response = await exports.POST!(new Request("http://fixture.invalid/api/webhooks/resend", {
    method: "POST", body: payload,
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": options.badSignature ? "v1,invalid" : new Webhook(secret).sign(id, timestamp, payload),
    },
  }));
  return { status: response.status, body: await response.json(), calls, alerts, logs };
}

const event = {
  type: "email.complained", created_at: new Date(Date.now() - 1000).toISOString(),
  data: { email_id: "private-message-fixture", to: ["private-reader@fixture.invalid"] },
};
for (const [status, count] of [["applied", 1], ["causally_ignored", 0], ["expired_unowned", 0], ["pending_owner", 0], ["manual_review", 0], ["legacy_review", 0]] as const) {
  const result = await run(event, [{ delivery_status: status, updated_count: count }]);
  assert.equal(result.status, 200);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, "record_resend_suppression_event");
  assert.equal(result.alerts.length, ["pending_owner", "manual_review", "legacy_review"].includes(status) ? 1 : 0);
  assert.ok(!JSON.stringify([result.logs, result.alerts]).includes("private-message-fixture"));
  assert.ok(!JSON.stringify([result.logs, result.alerts]).includes("private-reader@fixture.invalid"));
  checks += 6;
}
for (const data of [null, [], [{}], [{ delivery_status: "expired_unowned", updated_count: 1 }], [{ delivery_status: "applied", updated_count: 2 }], [{ delivery_status: "applied", updated_count: 1 }, {}]]) {
  const result = await run(event, data);
  assert.equal(result.status, 500);
  checks += 1;
}
const error = await run(event, null, { error: { message: "private-reader@fixture.invalid private-message-fixture" } });
assert.equal(error.status, 500);
assert.ok(!JSON.stringify([error.logs, error.alerts]).includes("private-"));
checks += 2;
for (const options of [{ badSignature: true }, { configured: false }]) {
  const result = await run(event, [], options);
  assert.equal(result.status, options.badSignature ? 400 : 503);
  assert.equal(result.calls.length, 0);
  checks += 2;
}
const invalid = await run(null, []);
assert.equal(invalid.status, 400);
assert.equal(invalid.calls.length, 0);
checks += 2;
const soft = await run({ ...event, type: "email.bounced", data: { ...event.data, bounce: { type: "Transient" } } }, []);
assert.equal(soft.status, 200);
assert.equal(soft.calls.length, 0);
checks += 2;
console.log(`PASS verify-resend-webhook-offline (${checks} assertions, signed fixtures, no provider IO)`);
