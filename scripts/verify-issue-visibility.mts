import { issueHasLeakedSourceNote, issueIsReaderVisible } from "../lib/issue-visibility.ts";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let checks = 0;
function check(label: string, passes: boolean) {
  checks++;
  if (!passes) throw new Error(label);
}

const leaked = {
  editor_intro: "A fresh issue today.",
  sections: [{
    topicLabel: "Music",
    items: [{
      body: "(full text unavailable, snippet: The Official U.K. Albums Chart)",
      primaryRef: { url: "https://www.billboard.com/charts/official-uk-albums/" },
    }],
  }],
};
check("real historical resolver wrapper is hidden", !issueIsReaderVisible(leaked));
check("original em dash resolver wrapper is hidden", issueHasLeakedSourceNote("(full text unavailable — snippet: chart)"));
check("ellipsis variant is hidden", issueHasLeakedSourceNote("full text unavailable... snippet: chart"));
check("plain-language missing full text is allowed", !issueHasLeakedSourceNote("The full text is unavailable from this publisher."));
check("plain unavailable phrase without internal snippet label is allowed", !issueHasLeakedSourceNote("Full text unavailable, see the publisher for access."));
check("one failed optional rewrite does not hide a letter", issueIsReaderVisible({
  editor_intro: "A few useful reads today.",
  sections: [{ items: [{ body: "Read the piece for the details on music." }] }],
}));
check("nested marker in editor note is hidden", !issueIsReaderVisible({ editorIntro: "full text unavailable: snippet: chart" }));

const cron = readFileSync(new URL("../app/api/cron/weekly-send/route.ts", import.meta.url), "utf8");
const senderStart = cron.indexOf("async function runPersistAndSend(");
const upsertAt = cron.indexOf('sb.from("issues").upsert(', senderStart);
const senderGuard = cron.slice(senderStart, upsertAt).match(
  /if \(!issueIsReaderVisible\(issue\)\) \{\s*throw new Error\([^)]*\);\s*\}/
)?.[0];
check("sender guard exists before the first issue write", !!senderGuard && senderStart >= 0 && upsertAt > senderStart);
if (!senderGuard) throw new Error("sender guard missing");
const runSenderGuard = (issue: unknown) => vm.runInNewContext(
  `(function(issue, issueIsReaderVisible) { ${senderGuard} return true; })`,
  {}
)(issue, issueIsReaderVisible);
check("actual sender guard refuses leaked content before any write", (() => {
  try { runSenderGuard(leaked); return false; } catch { return true; }
})());
check("actual sender guard permits clean content", runSenderGuard({ editorIntro: "Clean", sections: [] }) === true);

const pendingCondition = cron.match(/if \((usableIssue \|\| \(persistedRetry && !issueIsReaderVisible\(persistedRetry\)\))\) \{/)
  ?.[1];
check("pending-row guard exists before backup selection", !!pendingCondition &&
  cron.indexOf(pendingCondition) < cron.indexOf("// LAYER 0 — cache-borrow"));
if (!pendingCondition) throw new Error("pending guard missing");
const mustSkipBackup = (persistedRetry: unknown, usableIssue: unknown) => vm.runInNewContext(
  `(function(persistedRetry, usableIssue, issueIsReaderVisible) { return ${pendingCondition}; })`,
  {}
)(persistedRetry, usableIssue, issueIsReaderVisible);
check("marked pending row cannot be replaced by backup", mustSkipBackup(leaked, null) === true);
check("a clean pending row is eligible for normal retry", mustSkipBackup({ editor_intro: "Clean", sections: [] }, null) === false);

const archive = readFileSync(new URL("../app/archive/page.tsx", import.meta.url), "utf8");
check("archive advances by raw rows after filtering", archive.includes("const from = rawCount;") &&
  archive.includes("setRawCount(from + rows.length);") &&
  archive.includes("const visibleRows = rows.filter(issueIsReaderVisible);"));
check("stale backup and same-day cache skip marked content", cron.includes(".find((candidate) => candidate.sections && issueIsReaderVisible(candidate))") &&
  cron.includes("b.items.length > 0 && issueIsReaderVisible({ sections: [b] })"));
console.log(`PASS verify-issue-visibility (${checks} assertions, offline)`);
