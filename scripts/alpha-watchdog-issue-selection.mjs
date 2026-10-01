// Select one exact automated Issue title from bounded number/title-only JSON.
import { stdin, stdout } from "node:process";

const MAX_INPUT_BYTES = 65_536;
const MAX_ISSUES = 100;
const MAX_TITLE_LENGTH = 256;
const expectedTitle = process.argv[2];
let raw = "";

function reject() {
  console.error("Watchdog issue lookup response rejected.");
  process.exitCode = 2;
}

if (typeof expectedTitle !== "string" || expectedTitle.length < 1 ||
    expectedTitle.length > MAX_TITLE_LENGTH || /[\u0000-\u001f\u007f]/u.test(expectedTitle)) {
  reject();
} else {
  stdin.setEncoding("utf8");
  stdin.on("data", chunk => {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
      stdin.destroy();
      reject();
    }
  });
  stdin.on("end", () => {
    if (process.exitCode) return;
    try {
      const issues = JSON.parse(raw);
      if (!Array.isArray(issues) || issues.length >= MAX_ISSUES) throw new Error("shape");
      for (const issue of issues) {
        if (!issue || typeof issue !== "object" || Array.isArray(issue) ||
            Object.keys(issue).sort().join(",") !== "number,title" ||
            !Number.isSafeInteger(issue.number) || issue.number < 1 ||
            typeof issue.title !== "string" || issue.title.length > MAX_TITLE_LENGTH ||
            /[\u0000-\u001f\u007f]/u.test(issue.title)) {
          throw new Error("shape");
        }
      }
      const matches = issues.filter(issue => issue.title === expectedTitle);
      if (matches.length > 1) throw new Error("ambiguous");
      if (matches.length === 1) stdout.write(String(matches[0].number));
    } catch {
      reject();
    }
  });
  stdin.resume();
}
