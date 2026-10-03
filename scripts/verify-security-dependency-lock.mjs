#!/usr/bin/env node
// Offline regression check for the September 2026 dependency security repair.
// This reads package metadata only. It does not load the app or environment files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const semver = require("semver");
const root = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const manifest = readJson("package.json");
const lock = readJson("package-lock.json");
assert.equal(lock.lockfileVersion, 3);

const floors = new Map([
  ["next", "16.3.3"],
  ["eslint-config-next", "16.3.3"],
  ["sharp", "0.35.4"],
  ["wrangler", "4.131.0"],
  ["miniflare", "5.20260910.0-alpha"],
  ["undici", "7.29.1"],
  ["js-yaml", "5.4.1"],
  ["qs", "6.16.0"],
]);
const seen = new Set();
let checked = 0;
for (const [path, pkg] of Object.entries(lock.packages)) {
  const name = path.split("node_modules/").at(-1);
  const floor = name === "js-yaml" && semver.satisfies(pkg.version, ">=4.0.0 <5")
    ? "4.3.2"
    : floors.get(name);
  if (!floor) continue;
  assert.ok(semver.valid(pkg.version), `${path}: valid version required`);
  assert.ok(semver.gte(pkg.version, floor), `${path}: below reviewed security floor ${floor}`);
  if (name === "undici") {
    assert.equal(semver.major(pkg.version), 7, `${path}: a new Undici major needs a separate security review`);
  }
  assert.ok(pkg.resolved.startsWith("https://registry.npmjs.org/"), `${path}: public registry required`);
  assert.match(pkg.integrity, /^sha512-/);
  seen.add(name);
  checked += 1;
  if (process.argv.includes("--installed")) {
    assert.equal(readJson(`${path}/package.json`).version, pkg.version, `${path}: install/lock drift`);
  }
}
for (const name of floors.keys()) assert.ok(seen.has(name), `${name}: missing from lock`);
for (const name of ["next", "eslint-config-next", "sharp", "wrangler", "js-yaml"]) {
  const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  assert.ok(semver.valid(declared), `${name}: exact reviewed version pin required`);
  assert.equal(declared, lock.packages[`node_modules/${name}`].version);
  assert.equal(declared, lock.packages[""].dependencies?.[name] ?? lock.packages[""].devDependencies?.[name]);
}
assert.equal(lock.packages["node_modules/next"].version, lock.packages["node_modules/eslint-config-next"].version);
assert.equal(manifest.overrides?.["@eslint/eslintrc"]?.["js-yaml"], "4.3.2");
assert.equal(manifest.overrides?.qs, "6.16.0");
// Patch the affected transport without changing the reviewed Wrangler/workerd pair.
assert.equal(manifest.overrides?.["miniflare@5.20260910.0-alpha"]?.undici, "7.29.1");
assert.equal(manifest.scripts.postinstall, "patch-package --error-on-fail && node scripts/verify-braces-depth-guard.mjs", "tokenizer and braces patches must apply with a fail-closed depth check");
assert.equal(manifest.scripts.prebuild, "node scripts/verify-braces-depth-guard.mjs", "build must reject an unpatched braces install");
if (process.argv.includes("--installed")) {
  assert.equal(readJson("node_modules/gpt-tokenizer/package.json").exports["./esm/*"].require, "./esm/*.js");
}
console.log(`PASS verify-security-dependency-lock (${checked} locked package paths${process.argv.includes("--installed") ? ", installed versions and tokenizer patch checked" : ""})`);
