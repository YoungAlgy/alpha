// Offline render of the actual Settings access/billing JSX. Only this subtree
// is compiled. No page imports, effects, provider clients, or real reader data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { isInviteOnly } from "../lib/access-mode.ts";

const source = readFileSync(new URL("../app/settings/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("settings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let accessExpression: ts.ConditionalExpression | undefined;
let matches = 0;
function visit(node: ts.Node) {
  if (ts.isConditionalExpression(node) && node.condition.getText(ast) === "isInviteOnly() && !hasPaidSub") {
    accessExpression = node;
    matches += 1;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(matches, 1, "render exactly the actual access/billing subtree");
assert.ok(accessExpression);
const compiled = ts.transpileModule(`export const view = (${accessExpression.getText(ast)});`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length ?? 0, 0);

function render(options: { hasPaidSub: boolean; hasInviteAccess?: boolean; quotaLoaded?: boolean; confirmingRenewalCancel?: boolean }) {
  const exports: { view?: Parameters<typeof renderToStaticMarkup>[0] } = {};
  const scope = {
    exports,
    require: (name: string) => {
      assert.equal(name, "react/jsx-runtime", "all other imports are forbidden");
      return jsxRuntime;
    },
    isInviteOnly,
    hasPaidSub: options.hasPaidSub,
    hasInviteAccess: options.hasInviteAccess ?? false,
    quotaLoaded: options.quotaLoaded ?? true,
    confirmingRenewalCancel: options.confirmingRenewalCancel ?? false,
    monthlyDollars: 5,
    topicQuota: 5,
    confirmingTier: null,
    billingMsg: null,
    justAdded: false,
    renewalEndsAt: null,
    renewalCancelMsg: null,
    renewalCancelBusy: false,
    billingHeadingRef: { current: null },
    renewalCancelHeadingRef: { current: null },
    confirmRenewalCancellation: () => assert.fail("render must not mutate billing"),
    fetch: () => assert.fail("network is forbidden"),
    Section: ({ title, children }: { title: string; children: Parameters<typeof createElement>[2] }) =>
      createElement("section", null, createElement("h2", null, title), children),
  };
  runInNewContext(compiled.outputText, scope, { timeout: 1000 });
  assert.ok(exports.view);
  const html = renderToStaticMarkup(exports.view);
  assert.doesNotMatch(html, /Manage subscription|Update your card|Add 5 more topics|Drop 5 topics|\$5|Keep renewal on|Loading your plan/);
  return html;
}

const free = render({ hasPaidSub: false });
assert.match(free, /There is no monthly payment for your account/);
assert.doesNotMatch(free, /Cancel renewal|Previous subscription/);
const legacy = render({ hasPaidSub: true });
assert.match(legacy, /Previous subscription/);
assert.match(legacy, /Cancel renewal/);
assert.match(legacy, /current access stays through this paid period/);
const granted = render({ hasPaidSub: true, hasInviteAccess: true });
assert.match(granted, /permanent invite access stays active after this paid period/);
const confirming = render({ hasPaidSub: true, confirmingRenewalCancel: true });
assert.match(confirming, /Turn off renewal/);
assert.match(confirming, /Go back/);
const loading = render({ hasPaidSub: true, quotaLoaded: false });
assert.match(loading, /Loading account status/);
console.log("PASS verify-free-settings-ui (5 offline render scenarios)");
