// Offline guard regression. No environment file, database or provider access.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const legacy = new URL("./verify-watchdog-proof-of-send.mts", import.meta.url);
const source = readFileSync(legacy, "utf8");
const guard = source.indexOf("process.exit(1);");
assert.ok(guard >= 0 && guard < source.indexOf("loadEnvLocal();"), "guard precedes environment loading");

// Reject real network and .env reads even if the entrypoint guard regresses.
// Sync builtin exports keeps the environment loader's named fs import fenced.
const fence = `
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const blocked = kind => { process.stderr.write("GUARD REGRESSION: forbidden " + kind + "\\n"); process.exit(86); };
const read = fs.readFileSync;
fs.readFileSync = function(target, ...args) {
  if (/(?:^|[\\\\/])\\.env(?:$|\\.)/.test(String(target))) return blocked("environment read");
  return read.call(this, target, ...args);
};
net.Socket.prototype.connect = () => blocked("socket");
globalThis.fetch = () => blocked("fetch");
syncBuiltinESMExports();
`;
const bootstrap = "data:text/javascript;base64," + Buffer.from(fence).toString("base64");
const clean = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG"]
  .flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
Object.assign(clean, { CI: "1" });

for (const scenario of [
  { name: "empty configuration", vars: {}, args: [] },
  { name: "configured non-secret markers", vars: { NEXT_PUBLIC_SUPABASE_URL: "https://alpha-offline.invalid", SUPABASE_SECRET_KEY: "OFFLINE_TEST_ONLY" }, args: [] },
  { name: "override arguments cannot reopen writes", vars: {}, args: ["--approved-live", "--force"] },
]) {
  // Node 24 strips this entrypoint's types natively. No tsx/compiler IPC is
  // needed to exercise the guard, so all sockets can remain denied.
  const result = spawnSync(process.execPath, ["--import", bootstrap, fileURLToPath(legacy), ...scenario.args],
    { cwd: root, env: { ...clean, ...scenario.vars }, encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
  assert.equal(result.error, undefined, scenario.name + ": child completes");
  assert.equal(result.status, 1, scenario.name + ": retired test fails closed");
  assert.equal(result.stdout, "", scenario.name + ": no data output");
  assert.equal(result.stderr.trim(), "RETIRED: legacy live-write watchdog verifier is blocked before environment loading. Use offline coverage checks or a reviewed disposable database fixture.",
    scenario.name + ": no environment, network or unexpected error path");
}
console.log("PASS legacy watchdog test guard (three offline entrypoint cases, no environment or network access)");
