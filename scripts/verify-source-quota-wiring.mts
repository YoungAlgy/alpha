// Offline call-site contract. No runtime route import, env loading, or fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(child: ts.Node) { found.push(child); ts.forEachChild(child, visit); }
  visit(node);
  return found;
}
function namedFunction(source: ts.SourceFile, name: string) {
  const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn?.body, `${name} has a function body`);
  return fn;
}
function calls(node: ts.Node, name: string) {
  return descendants(node).filter((item): item is ts.CallExpression =>
    ts.isCallExpression(item) && ts.isIdentifier(item.expression) && item.expression.text === name);
}
function assertFreshState(node: ts.Node | undefined, label: string) {
  assert.ok(node && ts.isObjectLiteralExpression(node), `${label} is a fresh object`);
  const property = node.properties.find((item) => item.name?.getText() === "monthlyExhausted");
  assert.ok(property && ts.isPropertyAssignment(property));
  assert.equal(property.initializer.kind, ts.SyntaxKind.FalseKeyword, `${label} starts unexhausted`);
}

const cron = parse("../app/api/cron/weekly-send/route.ts");
const handler = namedFunction(cron, "GET");
const states = descendants(handler.body!).filter((node): node is ts.VariableDeclaration =>
  ts.isVariableDeclaration(node) && node.name.getText() === "sourceQuotaState");
assert.equal(states.length, 1, "one caller-owned quota state is created inside the handler");
assertFreshState(states[0].initializer, "handler quota state");
assert.ok(ts.isVariableDeclarationList(states[0].parent));
assert.ok(ts.isVariableStatement(states[0].parent.parent));
assert.equal(states[0].parent.parent.parent, handler.body, "state belongs to the request, outside reader loops");
const generations = calls(handler, "generateIssue");
assert.equal(generations.length, 2, "normal and fast-fallback generation paths are covered");
for (const call of generations) {
  assert.equal(call.arguments.length, 9);
  assert.equal(call.arguments[8].getText(), "sourceQuotaState", "both paths share request state");
}

const assemble = parse("../lib/engine/assemble.ts");
const generate = namedFunction(assemble, "generateIssue");
assert.equal(generate.parameters[8].name.getText(), "quotaState");
assertFreshState(generate.parameters[8].initializer, "standalone generation state");
const searches = calls(generate, "resolveTopicSignal");
assert.equal(searches.length, 2, "narrow and wider search windows are covered");
for (const call of searches) {
  const options = call.arguments[2];
  assert.ok(ts.isObjectLiteralExpression(options));
  assert.ok(options.properties.some((property) =>
    ts.isShorthandPropertyAssignment(property) && property.name.text === "quotaState"),
  "both windows receive the same quota state");
}
console.log("PASS verify-source-quota-wiring (offline request-scope and call-site contracts)");
