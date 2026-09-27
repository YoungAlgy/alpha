import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the real wrapper with all imports replaced. No environment file,
// provider module, database, or network transport is loaded or called.
const source = readFileSync(new URL("../lib/subscriber-email-delivery.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Config = {
  lettersEnabled: boolean;
  schemaEnabled: boolean;
  brevoEnabled: boolean;
  preferredProvider: string;
  resendReady: boolean;
  brevoWebhookReady: boolean;
};

function load(options: { schema?: boolean; canaryGate?: boolean; preferred?: string } = {}) {
  const observed: { configured: Config[]; sends: { config: Config; requireProvider?: string }[] } = {
    configured: [], sends: [],
  };
  const configured = (config: Config) => {
    observed.configured.push(config);
    if (!config.lettersEnabled) return false;
    if (!config.schemaEnabled) return config.resendReady;
    if (config.preferredProvider === "resend") return config.resendReady;
    return config.preferredProvider === "brevo" && config.brevoEnabled && config.brevoWebhookReady;
  };
  const mocks: Record<string, unknown> = {
    "./email": {
      resendConfigured: () => true,
      sendPreparedSubscriberEmail: () => { throw Error("provider call forbidden"); },
    },
    "./subscriber-delivery-policy": { SUBSCRIBER_LETTERS_ENABLED: true },
    "./brevo-delivery-policy": {
      BREVO_DELIVERY_SCHEMA_ENABLED: options.schema ?? true,
      BREVO_SUBSCRIBER_DELIVERY_ENABLED: false,
      BREVO_CANARY_DELIVERY_ENABLED: options.canaryGate ?? true,
    },
    "./subscriber-email-router": {
      subscriberDeliveryConfigured: configured,
      routeSubscriberLetter: (params: { requireProvider?: string }, deps: { config: Config }) => {
        observed.sends.push({ config: deps.config, requireProvider: params.requireProvider });
        if (!configured(deps.config)) throw Error("delivery disabled");
        const provider = deps.config.schemaEnabled ? deps.config.preferredProvider : "resend";
        if (params.requireProvider && provider !== params.requireProvider) throw Error("required provider mismatch");
        return { provider };
      },
    },
  };
  const exports = {} as {
    subscriberEmailConfigured: (canary?: string) => boolean;
    subscriberEmailStatus: () => { configured: boolean; provider: string };
    sendPreparedSubscriberLetter: (params: object, canary?: string) => Promise<{ provider: string }>;
  };
  vm.runInNewContext(compiled, {
    exports,
    process: { env: {
      ALPHA_SUBSCRIBER_EMAIL_PROVIDER: options.preferred ?? "resend",
      BREVO_API_KEY: "fixture-key",
      BREVO_FROM_EMAIL: "alpha@backup.alpha.everyday.report",
      BREVO_WEBHOOK_TOKEN: "fixture_only_webhook_token_1234567890",
    } },
    require: (name: string) => {
      if (!(name in mocks)) throw Error(`unexpected import: ${name}`);
      return mocks[name];
    },
    fetch: () => { throw Error("network call forbidden"); },
  }, { timeout: 1000 });
  return { exports, observed };
}

const normal = load();
assert.equal(normal.exports.subscriberEmailConfigured(), true);
assert.equal(normal.exports.subscriberEmailStatus().provider, "resend");
assert.equal(normal.exports.subscriberEmailStatus().configured, true);
assert.equal(normal.observed.configured.every((config) => config.brevoEnabled === false), true);
assert.equal((await normal.exports.sendPreparedSubscriberLetter({})).provider, "resend");
assert.equal(normal.observed.sends[0].config.brevoEnabled, false);
assert.equal(normal.observed.sends[0].requireProvider, undefined);

const canary = load();
assert.equal(canary.exports.subscriberEmailConfigured("brevo_canary"), true);
assert.equal(canary.observed.configured[0].preferredProvider, "brevo");
assert.equal(canary.observed.configured[0].brevoEnabled, true);
assert.equal((await canary.exports.sendPreparedSubscriberLetter({}, "brevo_canary")).provider, "brevo");
assert.equal(canary.observed.sends[0].requireProvider, "brevo");
assert.equal(canary.observed.sends[0].config.brevoEnabled, true);
assert.equal(canary.exports.subscriberEmailStatus().provider, "resend");

const closedCanary = load({ canaryGate: false });
assert.equal(closedCanary.exports.subscriberEmailConfigured("brevo_canary"), false);
await assert.rejects(async () => closedCanary.exports.sendPreparedSubscriberLetter({}, "brevo_canary"), /delivery disabled/);
assert.equal(closedCanary.observed.sends[0].requireProvider, "brevo");

const closedSchema = load({ schema: false });
assert.equal(closedSchema.exports.subscriberEmailConfigured("brevo_canary"), true);
await assert.rejects(async () => closedSchema.exports.sendPreparedSubscriberLetter({}, "brevo_canary"), /required provider mismatch/);
assert.equal(closedSchema.observed.sends[0].config.schemaEnabled, false);

const selectedNormalBrevo = load({ preferred: "brevo" });
assert.equal(selectedNormalBrevo.exports.subscriberEmailConfigured(), false);
assert.equal(selectedNormalBrevo.exports.subscriberEmailStatus().provider, "none");
await assert.rejects(async () => selectedNormalBrevo.exports.sendPreparedSubscriberLetter({}), /delivery disabled/);
assert.equal(selectedNormalBrevo.observed.sends[0].config.brevoEnabled, false);

console.log("PASS Brevo canary delivery wrapper: normal Resend, explicit Brevo canary, closed gates");
