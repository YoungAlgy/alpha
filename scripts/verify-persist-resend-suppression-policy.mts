import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/engine/persist.ts", import.meta.url), "utf8");

let assertions = 0;
function check(value: unknown, label: string): void {
  assertions += 1;
  assert.ok(value, label);
}

check(
  source.includes('import { sendOpsAlert } from "@/lib/email";'),
  "persistence keeps its alert dependency without importing suppression cleanup"
);
check(
  !source.includes("removeResendSuppression"),
  "account creation persistence contains no provider suppression-removal call"
);
check(
  source.includes("verificationType"),
  "account creation persistence still returns the Auth verification type"
);

const persistBodyStart = source.indexOf("export async function persistIssueIfPossible");
const profileSyncStart = source.indexOf("// Sync the profile fields onto public.users", persistBodyStart);
check(persistBodyStart >= 0 && profileSyncStart > persistBodyStart, "persistence function boundaries are present");
const persistenceBeforeProfileSync = source.slice(persistBodyStart, profileSyncStart);
check(
  !persistenceBeforeProfileSync.includes("fetch(") &&
    !persistenceBeforeProfileSync.includes("api.resend.com"),
  "the account-creation path performs no provider request before local persistence"
);

console.log(`Persist suppression policy verification passed: ${assertions}/${assertions}`);
