// Offline replacement for the retired live account/provider mutation test.
// Inspect all production TypeScript imports and calls without importing app
// code. The dormant recovery implementation and held transport are the only
// permitted definitions. No application entry point may call or import them.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbiddenNames = new Set([
  "recoverResendSuppression", "removeResendSuppression", "removeResendSuppressionWithTransport",
  "claim_resend_suppression_recovery", "finalize_resend_suppression_recovery",
]);
const allowed = new Set([
  "lib/email.ts", "lib/suppression-recovery.ts", "lib/resend-suppression-response.ts",
]);
let files = 0;
let assertions = 0;
function inspect(directory: string): void {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { inspect(relative); continue; }
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    const source = readFileSync(path.join(root, relative), "utf8");
    const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
    const findings: string[] = [];
    function visit(node: ts.Node): void {
      if (!allowed.has(relative)) {
        if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) findings.push(node.text);
        if (ts.isStringLiteralLike(node) && (
          forbiddenNames.has(node.text) || /(?:^|\/)suppression-recovery$/.test(node.text) ||
          node.text.includes("api.resend.com/suppressions")
        )) findings.push(node.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.deepEqual(findings, [], `${relative}: manual recovery must have no production caller`);
    assertions++;
    files++;
  }
}
for (const directory of ["app", "lib", "src"]) inspect(directory);
assert.ok(files > 100, "production scan must not be empty");
assertions++;
console.log(`PASS verify-resend-suppression-callsites (${assertions} assertions, ${files} production files, offline only)`);
