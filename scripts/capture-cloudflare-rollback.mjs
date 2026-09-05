#!/usr/bin/env node
// Runs only inside an explicitly approved deployment. It captures the active
// 100% Worker version before deployment and saves a small local release record.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const releaseCommit = process.argv[2]?.trim() || "";
if (!/^[0-9a-f]{40}$/.test(releaseCommit)) {
  console.error("::error:: capture-cloudflare-rollback requires the full release commit SHA.");
  process.exit(1);
}

const wrangler = path.resolve("node_modules/.bin/wrangler");
let deployment;
try {
  const raw = execFileSync(
    wrangler,
    ["deployments", "status", "--name", "alpha", "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  deployment = JSON.parse(raw);
} catch {
  console.error("::error:: Could not capture the current Alpha Worker deployment.");
  process.exit(1);
}

const stable = Array.isArray(deployment?.versions)
  ? deployment.versions.filter(
      (version) =>
        version?.percentage === 100 &&
        typeof version?.version_id === "string" &&
        /^[0-9a-f-]{36}$/i.test(version.version_id)
    )
  : [];
if (stable.length !== 1) {
  console.error(
    `::error:: Expected one 100% active Alpha Worker version, found ${stable.length}. Resolve traffic splitting before release.`
  );
  process.exit(1);
}

const capturedAt = new Date().toISOString();
const safeTimestamp = capturedAt.replace(/[:.]/g, "-");
const recordDir =
  process.env.ALPHA_RELEASE_RECORD_DIR?.trim() ||
  "backup/release-records";
mkdirSync(recordDir, { recursive: true });
const recordPath = path.join(
  recordDir,
  `${safeTimestamp}-${releaseCommit.slice(0, 12)}-predeploy.json`
);
writeFileSync(
  recordPath,
  JSON.stringify(
    {
      formatVersion: 1,
      capturedAt,
      worker: "alpha",
      releaseCommit,
      activeVersionId: stable[0].version_id,
      activePercentage: 100,
      deploymentId:
        typeof deployment?.id === "string" ? deployment.id : null,
      deploymentCreatedAt:
        typeof deployment?.created_on === "string"
          ? deployment.created_on
          : null,
      rollbackCommand: `./node_modules/.bin/wrangler rollback ${stable[0].version_id} --name alpha`,
    },
    null,
    2
  ),
  { mode: 0o600 }
);
console.error(`Saved pre-deploy rollback record: ${recordPath}`);
process.stdout.write(stable[0].version_id);
