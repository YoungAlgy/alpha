// Actual release gate executed in a VM. Git, files, and release environment
// are injected fixtures. No command, environment file, build, or deploy runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./verify-deploy-release.mjs", import.meta.url), "utf8");
const policy = readFileSync(new URL("../lib/suppression-recovery-policy.ts", import.meta.url), "utf8");
const accessPolicy = readFileSync(new URL("../lib/access-mode.ts", import.meta.url), "utf8");
const deliveryPolicy = readFileSync(new URL("../lib/subscriber-delivery-policy.ts", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/daily-send.yml", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sha = "a".repeat(40);
type Scenario = {
  policy: string | null;
  accessPolicy?: string | null;
  deliveryPolicy?: string | null;
  workflow?: string | null;
  dirty?: boolean;
  release?: string;
  mode?: string;
};
function run(scenario: Scenario): number {
  let exitCode = 0;
  const stop = new Error("fixture exit");
  try {
    vm.runInNewContext(compiled, {
      exports: {},
      console: { error: () => undefined, log: () => undefined },
      process: {
        env: {
          NEXT_PUBLIC_ALPHA_RELEASE_SHA: scenario.release ?? sha,
          ALPHA_EXPECTED_RELEASE_SHA: sha,
          ALPHA_EXPECTED_CHECKOUT_MODE: scenario.mode ?? "paused",
        },
        exit(code: number) { exitCode = code; throw stop; },
      },
      require(name: string) {
        if (name === "node:crypto") return { createHash };
        if (name === "node:child_process") return {
          execFileSync(command: string, args: string[]) {
            if (command !== "git") throw new Error("Unexpected command");
            if (args.join(" ") === "rev-parse HEAD") return sha;
            if (args.join(" ") === "status --porcelain") return scenario.dirty ? " M fixture.ts" : "";
            throw new Error("Unexpected git command");
          },
        };
        if (name === "node:fs") return {
          readFileSync(file: string) {
            if (file === "wrangler.jsonc") return '{"vars":{"ALPHA_CHECKOUT_MODE":"paused"}}';
            if (file === "lib/suppression-recovery-policy.ts") {
              if (scenario.policy === null) throw new Error("fixture missing policy");
              return scenario.policy;
            }
            if (file === "lib/access-mode.ts") {
              if (scenario.accessPolicy === null) throw new Error("fixture missing access policy");
              return scenario.accessPolicy ?? accessPolicy;
            }
            if (file === "lib/subscriber-delivery-policy.ts") {
              if (scenario.deliveryPolicy === null) throw new Error("fixture missing delivery policy");
              return scenario.deliveryPolicy ?? deliveryPolicy;
            }
            if (file === ".github/workflows/daily-send.yml") {
              if (scenario.workflow === null) throw new Error("fixture missing workflow");
              return scenario.workflow ?? workflow;
            }
            throw new Error(`Unexpected file: ${file}`);
          },
        };
        throw new Error(`Unexpected import: ${name}`);
      },
    }, { timeout: 1000 });
  } catch (error) { if (error !== stop) throw error; }
  return exitCode;
}
let assertions = 0;
for (const text of [policy.replace(/\r\n/g, "\n"), policy.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")]) {
  assert.equal(run({ policy: text }), 0);
  assertions++;
}
for (const text of [null, "", policy.replace("= false;", "= true;"), `${policy}\nprocess.env.ENABLE_RECOVERY;`]) {
  assert.equal(run({ policy: text }), 1);
  assertions++;
}
for (const scenario of [{ dirty: true }, { release: "b".repeat(40) }, { mode: "open" }]) {
  assert.equal(run({ policy, ...scenario }), 1);
  assertions++;
}
for (const scenario of [
  { accessPolicy: `${accessPolicy}\n// drift` },
  { deliveryPolicy: deliveryPolicy.replace("false", "true") },
  { workflow: workflow.replace("if: ${{ false }}", "if: ${{ true }}") },
  { accessPolicy: null },
  { deliveryPolicy: null },
  { workflow: null },
]) {
  assert.equal(run({ policy, ...scenario }), 1);
  assertions++;
}
console.log(`PASS verify-suppression-hold-release (${assertions} assertions, offline release gate)`);
