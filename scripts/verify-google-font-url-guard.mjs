// Offline local-font boundary. No environment files, requests or installs.
// Reviewed Next 16.4.3 already handles extensionless URLs upstream.
// Full asset/license/theme/preload verification stays in verify-local-fonts.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
assert.equal(process.argv.length, 2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = createRequire(import.meta.url);
assert.equal(installed("next/package.json").version, "16.4.3", "Review font boundary for a new Next version");
const hash = text => createHash("sha256").update(text).digest("hex");
const upstreamFiles = [
  ["next/dist/compiled/@next/font/dist/google/loader.js", "4543a03ce3505386ad1e2b3cbee93d7adb58f6420acff09af940d0733820e6f9"],
  ["next/dist/compiled/@next/font/dist/google/find-font-files-in-css.js", "42c1fd2f37ffde6cdcc4ab5484c1075c2e32ec4ad67a420c298f60f81a7279a7"],
];
for (const [path, expected] of upstreamFiles) {
  const source = readFileSync(installed.resolve(path), "utf8").replaceAll("\r\n", "\n");
  assert.equal(hash(source), expected, "Reviewed unmodified Next font source changed");
  assert(!source.includes("Alpha compatibility patch"), "Obsolete vendor patch must remain retired");
}
assert(!readdirSync(join(root, "patches")).some(name => /^next\+.+\.patch$/.test(name)), "Local fonts do not require a Next Google-loader patch");
const ts = installed("typescript");
const forbiddenModule = text => /(?:^|\/)(?:next\/font\/google|@next\/font(?:\/dist)?\/google)(?:\/|$)/i.test(text);
const forbiddenHost = text => /fonts\.(?:googleapis|gstatic)\.com/i.test(text);
function staticText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left), right = staticText(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = staticText(span.expression); if (value === null) return null;
      result += value + span.literal.text;
    }
    return result;
  }
  return null;
}
function inspectSource(source, file = "fixture.tsx") {
  assert(!forbiddenHost(source), "Google font host reference is forbidden");
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  assert.equal(tree.parseDiagnostics.length, 0, "Application source must parse before font review");
  let moduleReferences = 0;
  function moduleReference(node) {
    const text = staticText(node);
    assert(text !== null, "Computed module specifier requires explicit font-boundary review");
    assert(!forbiddenModule(text), "Google font dependency is forbidden");
    assert(!forbiddenHost(text), "Google font host reference is forbidden");
    moduleReferences++;
  }
  function visit(node) {
    const text = staticText(node);
    if (text !== null) {
      assert(!forbiddenModule(text), "Google font dependency is forbidden");
      assert(!forbiddenHost(text), "Google font host reference is forbidden");
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) moduleReference(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) moduleReference(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) moduleReference(node.argument.literal);
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expr) && expr.text === "require") ||
          (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "require" && expr.name.text === "resolve"))
        moduleReference(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return moduleReferences;
}
let fixtureChecks = 0;
for (const source of [
  'import { Inter } from "next/font/google";', 'export * from "next/font/google";',
  'const google = require("next/font/google");', 'const google = import("next/font/google");',
  'require.resolve("next/font/google");', 'import google = require("@next/font/google");',
  'type Google = import("next/font/google");', 'import("next/font/" + "google");',
  'import("next\\x2ffont/google");',
  'import(' + String.fromCharCode(96) + 'next/font/' + '$' + '{"google"}' + String.fromCharCode(96) + ');',
  'require("next/dist/compiled/@next/font/dist/google/loader");',
  'const font = "https://fonts." + "googleapis.com/css2";',
  'const font = "https://fonts.gstatic.com/font.woff2";', 'import(variableModule);',
]) {
  assert.throws(() => inspectSource(source), /Google font|Computed module/); fixtureChecks++;
}
for (const source of ['import "./fonts.css";', 'import { preload } from "react-dom";',
  'const api = import("@/lib/supabase/client");', 'const path = "/fonts/example.woff2";',
  '// Historical next/font/google mention in a comment.']) {
  inspectSource(source); fixtureChecks++;
}
const excludedDirectories = new Set(["node_modules", ".git", ".next", ".open-next", ".wrangler", "scripts", "patches", "docs", "public", "supabase", ".claude", ".github"]);
let sourceFiles = 0, sourceBytes = 0, moduleReferences = 0;
function scan(directory, filesystem = { lstatSync, readdirSync }) {
  assert(!filesystem.lstatSync(directory).isSymbolicLink(), "Application directory must be ordinary");
  for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
    // Dirent.isDirectory() is false for directory symlinks. Reject links before
    // either filtering names or deciding which entries need source inspection.
    assert(!entry.isSymbolicLink(), "Application entry must be ordinary");
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path, filesystem);
    else if (/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) {
      assert(entry.isFile() && !entry.isSymbolicLink(), "Application source must be ordinary");
      const content = readFileSync(path); sourceFiles++; sourceBytes += content.length;
      assert(sourceFiles <= 2000 && content.length <= 2 * 1024 * 1024 && sourceBytes <= 16 * 1024 * 1024, "Source review bound exceeded");
      const source = content.toString("utf8");
      assert(Buffer.from(source, "utf8").equals(content), "Application source must be UTF-8");
      if (entry.name.endsWith(".css")) assert(!forbiddenHost(source), "Google font host reference is forbidden");
      else moduleReferences += inspectSource(source, relative(root, path));
    }
  }
}
for (const name of ["linked-components", "linked-fonts.ts", "public"]) {
  const linkedEntry = { name, isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  assert.throws(() => scan("offline-fixture", {
    lstatSync: () => ({ isSymbolicLink: () => false }),
    readdirSync: () => [linkedEntry],
  }), { message: "Application entry must be ordinary" });
  fixtureChecks++;
}
scan(root); assert(sourceFiles > 0);
console.log(JSON.stringify({ status: "PASS", next: "16.4.3", upstreamFilesVerified: upstreamFiles.length,
  googleLoaderPatchRetired: true, sourceFiles, sourceBytes, moduleReferences, fixtureChecks,
  googleFontDependencies: 0, googleFontHosts: 0, networkCalls: 0, environmentFilesRead: 0,
  localFontAssetsPreloadsLicenses: "verified separately by unchanged verify-local-fonts.mjs" }));
