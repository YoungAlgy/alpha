#!/usr/bin/env node
// Local-only install/build gate for the identified braces recursion-depth patch.
// No environment files, providers, subscriber data or network access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = createRequire(join(root, "package.json"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const expected = {
  "compile.js": "51a48b3b43dfdbe46236ad90074a27752a3f6f6a091a8ac26e5338aca76fc96a",
  "constants.js": "f9fb688959232eee3e6ad7906a5b0e3234815db49ee857ef86983d65b917dc7c",
  "expand.js": "cc147c2f95d4021caa5785d513606b9765e47ada0c1cdb9514f49f8f59f4f016",
  "parse.js": "ea400f09d9ef8360fa577ba46435f785cc5cc7041182b690006ace7508ba43f1",
  "stringify.js": "0db52dcf27110580feeff76c690a6e87acaa0ea24075facb38eb9760939b2a9f"
};
const hash = value => createHash("sha256").update(value).digest("hex");
const copies = [];
function scanModules(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    assert(!entry.isSymbolicLink(), "Linked package needs a separate depth-patch review");
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith("@")) { scanModules(path); continue; }
    if (entry.name === "braces") copies.push(path);
    const nested = join(path, "node_modules");
    if (existsSync(nested)) scanModules(nested);
  }
}
scanModules(join(root, "node_modules"));
const declared = Object.keys(lock.packages).filter(path => /(?:^|\/)node_modules\/braces$/.test(path)).sort();
assert.deepEqual(copies.map(path => relative(root, path).replaceAll("\\", "/")).sort(), declared,
  "Installed braces copies differ from the reviewed lockfile");
assert(copies.length > 0, "Required braces dependency missing");

let groups = 0;
const check = callback => { callback(); groups++; };
const rejected = callback => assert.throws(callback, error =>
  (error instanceof SyntaxError || error instanceof RangeError) && /exceeds max depth/.test(error.message));
const pattern = (depth, opener = "{", closer = "}") => opener.repeat(depth) + "a" + closer.repeat(depth);
function tree(depth, type = "brace", rooted = true) {
  let node = { type: "text", value: "a" };
  for (let i = 0; i < depth; i++) { const parent = { type, nodes: [node], commas: 0, ranges: 0 }; node.parent = parent; node = parent; }
  if (rooted) { const parent = { type: "root", nodes: [node] }; node.parent = parent; node = parent; }
  return node;
}
for (const copy of copies) {
  const packageName = relative(root, copy).replaceAll("\\", "/");
  assert.equal(realpathSync(copy), copy);
  const metadata = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  assert.equal(metadata.name, "braces");
  assert.equal(metadata.version, "3.0.3", "New braces version needs review and patch removal");
  assert.equal(lock.packages[packageName].version, "3.0.3");
  for (const [file, pinned] of Object.entries(expected)) {
    assert.equal(hash(readFileSync(join(copy, "lib", file), "utf8").replaceAll("\r\n", "\n")), pinned,
      "braces depth patch absent or changed: " + file);
  }
  const braces = installed(copy);
  check(() => assert.equal(braces.compile("src/{app,lib}/**/*.{ts,tsx}"), "src/(app|lib)/**/*.(ts|tsx)"));
  check(() => assert.deepEqual(braces.expand("topic-{1..3}"), ["topic-1", "topic-2", "topic-3"]));
  check(() => assert.deepEqual(braces.expand("{a,b}", { nodupes: true }), ["a", "b"]));
  check(() => assert.equal(braces.stringify("a/{b,c}/d"), "a/{b,c}/d"));
  for (const method of [braces.parse, braces.compile, braces.expand, braces.stringify, braces]) {
    check(() => assert.doesNotThrow(() => method(pattern(100))));
    check(() => rejected(() => method(pattern(101))));
    check(() => rejected(() => method(pattern(101, "(", ")"))));
    check(() => rejected(() => method("{(".repeat(51) + "a" + ")}".repeat(51))));
    check(() => rejected(() => method("{".repeat(101))));
    check(() => assert.doesNotThrow(() => method("{" + "(".repeat(99) + "a" + ")".repeat(99) + "}")));
    check(() => assert.doesNotThrow(() => method('"'+pattern(101)+'"')));
    check(() => assert.doesNotThrow(() => method("["+pattern(101)+"]")));
    check(() => assert.doesNotThrow(() => method("\\{".repeat(101)+"a"+"\\}".repeat(101))));
    check(() => rejected(() => method(pattern(3), { maxDepth: 2 })));
    check(() => assert.doesNotThrow(() => method(pattern(2), { maxDepth: 2 })));
    for (const maxDepth of [101, 100000, Infinity, NaN, false, "1000"]) {
      check(() => rejected(() => method(pattern(101), { maxDepth })));
    }
    check(() => rejected(() => method(pattern(2), { maxDepth: 1.9 })));
    check(() => rejected(() => method("{a}", { maxDepth: -1 })));
    check(() => assert.doesNotThrow(() => method("plain", { maxDepth: 0 })));
  }
  for (const method of [braces.compile, braces.expand, braces.stringify]) {
    check(() => assert.doesNotThrow(() => method(tree(100))));
    check(() => rejected(() => method(tree(101))));
    check(() => assert.doesNotThrow(() => method(tree(100, "brace", false))));
    check(() => rejected(() => method(tree(101, "brace", false))));
    check(() => rejected(() => method(tree(101, "paren"))));
    check(() => rejected(() => method(tree(3), { maxDepth: 2 })));
    check(() => assert.doesNotThrow(() => method(tree(2), { maxDepth: 2 })));
    check(() => { const cycle = { type: "root", nodes: [] }; cycle.nodes.push(cycle); rejected(() => method(cycle)); });
  }
  check(() => {
    const parent = { type: "paren", nodes: [], queue: [] }; parent.parent = parent;
    const child = { type: "brace", nodes: [], parent };
    const ast = { type: "root", nodes: [parent] }; parent.nodes.push(child);
    rejected(() => braces.expand(ast));
  });
  check(() => {
    const ast = { type: "paren", nodes: [] }; ast.parent = ast;
    rejected(() => braces.expand(ast));
  });
  check(() => assert.deepEqual(braces.expand("{a,b}"), ["a", "b"]));
}
const micromatch = installed("micromatch");
check(() => assert.deepEqual(micromatch(["app/a.ts", "lib/b.tsx", "public/a.png"], "{app,lib}/**/*.{ts,tsx}"), ["app/a.ts", "lib/b.tsx"]));
check(() => assert.deepEqual(micromatch.braceExpand("src/{app,lib}"), ["src/app", "src/lib"]));
check(() => rejected(() => micromatch.braces(pattern(101), { expand: true })));
console.log("BRACES_DEPTH_GUARD " + JSON.stringify({ copies: copies.length, groupedChecks: groups, patchedVersion: "3.0.3+local-depth-guard", auditAdvisoryStillApplicableToPublishedVersion: true }));
