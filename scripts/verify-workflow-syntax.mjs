#!/usr/bin/env node
// Fully local workflow gate. Parses every YAML file and asks Bash to syntax
// check each run block through stdin. It does not execute a workflow command.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { load } from "js-yaml";

const workflowDir = path.resolve(".github/workflows");
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();
const windowsBash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const bash = process.platform === "win32" && existsSync(windowsBash)
  ? windowsBash
  : "bash";

let runBlocks = 0;
for (const name of workflows) {
  const file = path.join(workflowDir, name);
  const document = load(readFileSync(file, "utf8"));
  if (!document || typeof document !== "object" || !document.jobs) {
    throw new Error(`${name}: expected a workflow object with jobs`);
  }
  for (const [jobName, job] of Object.entries(document.jobs)) {
    if (!job || typeof job !== "object" || !Array.isArray(job.steps)) continue;
    for (const [index, step] of job.steps.entries()) {
      if (!step || typeof step !== "object" || typeof step.run !== "string") {
        continue;
      }
      if (typeof step.shell === "string" && !/bash|sh/i.test(step.shell)) {
        continue;
      }
      runBlocks += 1;
      const checked = spawnSync(bash, ["-n"], {
        input: step.run,
        encoding: "utf8",
      });
      if (checked.status !== 0) {
        throw new Error(
          `${name}:${jobName}:step ${index + 1} Bash syntax failed:\n${
            checked.stderr || checked.stdout
          }`
        );
      }
    }
  }
}

console.log(
  `PASS workflow syntax (${workflows.length} YAML files, ${runBlocks} Bash run blocks)`
);
