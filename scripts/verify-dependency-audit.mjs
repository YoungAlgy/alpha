#!/usr/bin/env node
// Public dependency metadata only. Never load the app, env files or raw audit logs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const exceptionPolicy = Object.freeze({
  advisory: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  source: 1240992,
  package: "braces",
  version: "3.0.3",
  range: "<=3.0.3",
  notBefore: "2026-10-03T00:00:00.000Z",
  expiresAt: "2026-11-02T00:00:00.000Z",
  approval: "Alex approved local preparation October 3. No release permission.",
});
const reviewed = new Map([
  ["eslint-config-next", ["16.3.6", "@next/eslint-plugin-next", "16.3.6"]],
  ["@next/eslint-plugin-next", ["16.3.6", "fast-glob", "3.3.1"]],
  ["fast-glob", ["3.3.1", "micromatch", "^4.0.4"]],
  ["patch-package", ["8.0.1", "find-yarn-workspace-root", "^2.0.0"]],
  ["find-yarn-workspace-root", ["2.0.0", "micromatch", "^4.0.2"]],
  ["micromatch", ["4.0.8", "braces", "^3.0.3"]],
  ["braces", ["3.0.3", null]],
]);
const severities = ["info", "low", "moderate", "high", "critical"];
const own = (object, key) => Object.hasOwn(object, key);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const packageName = value => typeof value === "string" && value.length <= 214
  && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value);
const nodePath = (path, name) => {
  if (typeof path !== "string" || path.length > 512 || !path.endsWith("/" + name)) return false;
  const parts = path.split("/");
  for (let i = 0; i < parts.length;) {
    if (parts[i++] !== "node_modules") return false;
    let part = parts[i++];
    if (part?.startsWith("@")) part += "/" + parts[i++];
    if (!packageName(part) || part.split("/").some(value => value === "." || value === "..")) return false;
  }
  return true;
};

// Pure classification for focused tests. CI has no saved-report or bypass flag.
export function evaluateAudit(report, lock, { status, now }) {
  assert(plain(report) && !own(report, "error") && report.auditReportVersion === 2, "AUDIT_REPORT_INVALID");
  assert(plain(report.vulnerabilities) && plain(report.metadata?.vulnerabilities), "AUDIT_REPORT_INVALID");
  assert(lock?.lockfileVersion === 3 && plain(lock.packages), "AUDIT_LOCK_INVALID");
  const counts = report.metadata.vulnerabilities;
  assert.deepEqual(Object.keys(counts).sort(), [...severities, "total"].sort(), "AUDIT_COUNTS_INVALID");
  for (const severity of [...severities, "total"]) {
    assert(Number.isSafeInteger(counts[severity]) && counts[severity] >= 0, "AUDIT_COUNTS_INVALID");
  }
  const entries = Object.entries(report.vulnerabilities);
  assert(entries.length <= 2000, "AUDIT_REPORT_TOO_LARGE");
  const computed = Object.fromEntries(severities.map(value => [value, 0]));
  for (const [name, finding] of entries) {
    assert(packageName(name) && plain(finding) && finding.name === name, "AUDIT_ENTRY_INVALID");
    assert(severities.includes(finding.severity) && typeof finding.isDirect === "boolean", "AUDIT_ENTRY_INVALID");
    assert(Array.isArray(finding.nodes) && finding.nodes.length > 0 && finding.nodes.length <= 256, "AUDIT_NODES_INVALID");
    assert(new Set(finding.nodes).size === finding.nodes.length, "AUDIT_NODES_INVALID");
    for (const path of finding.nodes) {
      assert(nodePath(path, name) && own(lock.packages, path) && plain(lock.packages[path]), "AUDIT_NODES_INVALID");
    }
    assert(Array.isArray(finding.via) && finding.via.length > 0 && finding.via.length <= 256, "AUDIT_VIA_INVALID");
    for (const via of finding.via) {
      if (typeof via === "string") {
        assert(packageName(via) && own(report.vulnerabilities, via), "AUDIT_REFERENCE_INVALID");
      } else {
        assert(plain(via) && Number.isSafeInteger(via.source) && via.source > 0
          && packageName(via.name) && packageName(via.dependency)
          && severities.includes(via.severity) && typeof via.range === "string" && via.range.length > 0
          && typeof via.url === "string" && via.url.startsWith("https://"), "AUDIT_ADVISORY_INVALID");
      }
    }
    computed[finding.severity]++;
  }
  assert(severities.every(value => computed[value] === counts[value]) && counts.total === entries.length, "AUDIT_COUNTS_INVALID");
  assert(status === (counts.high + counts.critical > 0 ? 1 : 0), "AUDIT_EXIT_INVALID");
  const checkedAt = new Date(now).getTime();
  assert(Number.isFinite(checkedAt), "AUDIT_CLOCK_INVALID");
  const memo = new Map();
  const leaves = (name, visiting = new Set()) => {
    assert(!visiting.has(name) && visiting.size < 64, "AUDIT_GRAPH_INVALID");
    if (memo.has(name)) return memo.get(name);
    const next = new Set(visiting).add(name);
    const result = [];
    for (const via of report.vulnerabilities[name].via) {
      if (typeof via === "string") result.push(...leaves(via, next));
      else result.push({ parent: name, via });
      assert(result.length <= 2000, "AUDIT_GRAPH_TOO_LARGE");
    }
    memo.set(name, result);
    return result;
  };
  // Reject cyclic/dangling shapes even below the existing high threshold.
  for (const [name, finding] of entries) {
    const all = leaves(name);
    assert(all.every(({ via }) => severities.indexOf(via.severity) <= severities.indexOf(finding.severity)), "AUDIT_SEVERITY_INVALID");
  }
  const blocked = entries.filter(([, finding]) => finding.severity === "critical");
  let waived = 0;
  const verifyReviewedNode = name => {
    const expected = reviewed.get(name);
    assert(expected, "AUDIT_EXCEPTION_GRAPH_DRIFT");
    const path = "node_modules/" + name;
    const finding = report.vulnerabilities[name];
    assert(finding.nodes.length === 1 && finding.nodes[0] === path, "AUDIT_EXCEPTION_GRAPH_DRIFT");
    const pkg = lock.packages[path];
    assert(pkg.version === expected[0] && pkg.dev === true && !pkg.link
      && (pkg.name === undefined || pkg.name === name), "AUDIT_EXCEPTION_VERSION_DRIFT");
    const copies = Object.keys(lock.packages).filter(value => nodePath(value, name));
    assert.deepEqual(copies, [path], "AUDIT_EXCEPTION_COPY_DRIFT");
    const [via] = finding.via;
    assert(finding.via.length === 1 && (expected[1] === null ? plain(via) : via === expected[1]), "AUDIT_EXCEPTION_GRAPH_DRIFT");
    if (expected[1]) {
      assert(own(pkg.dependencies ?? {}, expected[1]) && pkg.dependencies[expected[1]] === expected[2]
        && own(lock.packages, "node_modules/" + expected[1]), "AUDIT_EXCEPTION_EDGE_DRIFT");
    }
    assert(finding.isDirect === ["eslint-config-next", "patch-package"].includes(name), "AUDIT_EXCEPTION_GRAPH_DRIFT");
  };
  for (const [name, finding] of entries) {
    if (finding.severity !== "high") continue;
    const all = leaves(name);
    const exact = all.every(({ parent, via }) => parent === exceptionPolicy.package
      && via.name === exceptionPolicy.package && via.dependency === exceptionPolicy.package
      && via.url === exceptionPolicy.advisory && via.source === exceptionPolicy.source
      && via.severity === "high" && via.range === exceptionPolicy.range);
    if (!exact || !reviewed.has(name)) { blocked.push([name, finding]); continue; }
    assert(checkedAt >= Date.parse(exceptionPolicy.notBefore) && checkedAt < Date.parse(exceptionPolicy.expiresAt), "AUDIT_EXCEPTION_EXPIRED");
    // Validate every dependency along this exception path, never just its leaf.
    let current = name;
    while (current) { verifyReviewedNode(current); current = reviewed.get(current)[1]; }
    waived++;
  }
  assert(blocked.length === 0, "AUDIT_OTHER_HIGH_OR_CRITICAL");
  return { rawCounts: { ...counts }, waivedHighPackageEntries: waived,
    blockingHighOrCritical: 0, exceptionUsed: waived > 0,
    advisory: waived ? exceptionPolicy.advisory : null,
    expiresAt: waived ? exceptionPolicy.expiresAt : null };
}

export function parseAuditProcess(result) {
  assert(!result.error && result.signal === null && [0, 1].includes(result.status), "AUDIT_PROCESS_FAILED");
  assert(typeof result.stdout === "string" && result.stdout.trim().length > 0, "AUDIT_OUTPUT_MISSING");
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error("AUDIT_JSON_INVALID"); }
  return report;
}

function main() {
  assert(process.argv.length === 2 && process.platform === "linux", "AUDIT_LINUX_RUNNER_REQUIRED");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert(!existsSync(join(root, ".npmrc")), "AUDIT_PROJECT_CONFIG_FORBIDDEN");
  const home = mkdtempSync(join(tmpdir(), "alpha-audit-"));
  // No credentials, NODE_OPTIONS hooks, app configuration or alternate registry.
  const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", CI: "1",
    npm_config_userconfig: join(home, "empty-user.npmrc"), npm_config_globalconfig: join(home, "empty-global.npmrc"),
    npm_config_cache: join(home, "cache"), npm_config_update_notifier: "false", npm_config_fund: "false" };
  for (const script of ["verify-security-dependency-lock.mjs", "verify-braces-depth-guard.mjs"]) {
    const args = [join(root, "scripts", script), ...(script.includes("dependency-lock") ? ["--installed"] : [])];
    const guard = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    assert(!guard.error && guard.signal === null && guard.status === 0, "AUDIT_MITIGATION_FAILED");
  }
  console.log("ALPHA_AUDIT_MITIGATION_VERIFIED");
  // Match installed parent tooling too, not just the patched leaf and lockfile.
  for (const [name, [version]] of reviewed) {
    const path = join(root, "node_modules", name);
    assert(realpathSync(path) === path, "AUDIT_INSTALLED_GRAPH_DRIFT");
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    assert(pkg.name === name && pkg.version === version, "AUDIT_INSTALLED_GRAPH_DRIFT");
  }
  const npm = join(dirname(process.execPath), "npm");
  assert(existsSync(npm), "AUDIT_NPM_MISSING");
  const audit = spawnSync(npm, ["audit", "--json", "--audit-level=high", "--include=dev", "--include=optional", "--include=peer",
    "--registry=https://registry.npmjs.org/", "--fetch-retries=0", "--fetch-timeout=30000"],
  { cwd: root, env, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  const report = parseAuditProcess(audit);
  const checkedAt = new Date();
  const result = evaluateAudit(report, JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")), { status: audit.status, now: checkedAt });
  console.log("ALPHA_DEPENDENCY_AUDIT " + JSON.stringify({ checkedAt: checkedAt.toISOString(), ...result }));
  if (result.exceptionUsed) console.log("::warning::One high advisory remains reported. Verified local depth mitigation exception expires 2026-11-02T00:00:00Z.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch {
    // Do not expose npm stderr, URLs with auth, raw report content or error data.
    console.error("ALPHA_DEPENDENCY_AUDIT_BLOCKED: mitigation, report, process or policy verification failed.");
    process.exitCode = 1;
  }
}
