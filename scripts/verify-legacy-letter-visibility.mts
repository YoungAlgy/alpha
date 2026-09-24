// Execute /letter's issue selection with in-memory rows. No server, database,
// tokens, or provider connection is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { latestVisibleIssue } from "../lib/latest-visible-issue.ts";
import { issueIsReaderVisible } from "../lib/issue-visibility.ts";

const page = readFileSync(new URL("../app/letter/page.tsx", import.meta.url), "utf8");
const start = page.indexOf("const issueQuery = () => sb");
const end = page.indexOf(": latestVisibleIssue<IssueRow>((from, to) => issueQuery().range(from, to));", start);
assert.ok(start >= 0 && end > start, "the page must keep separate exact and legacy selection");
const selection = page.slice(start, end + ": latestVisibleIssue<IssueRow>((from, to) => issueQuery().range(from, to));".length);
const source = ts.transpileModule(
  `async function selectIssue(sb, weekOf, userId, currentPeriodIso, latestVisibleIssue) { ${selection} return issueRead; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;
const selectIssue = new Function(`${source}\nreturn selectIssue;`)() as (
  sb: unknown, weekOf: string | null, userId: string,
  currentPeriodIso: () => string, latestVisibleIssue: typeof import("../lib/latest-visible-issue.ts").latestVisibleIssue,
) => Promise<{ data: { week_of: string; editor_intro: string; sections: unknown[] } | null; error: unknown }>;

const rows = [
  { user_id: "reader", week_of: "2026-09-24", editor_intro: "New", sections: [{ items: [{ body: "(full text unavailable, snippet: broken)" }] }] },
  { user_id: "reader", week_of: "2026-09-23", editor_intro: "Good", sections: [{ items: [{ body: "Real sourced story." }] }] },
  { user_id: "other", week_of: "2026-09-25", editor_intro: "Other reader", sections: [] },
];
const reads: Array<{ from?: number; to?: number; exact?: string }> = [];
const sb = { from(table: string) {
  assert.equal(table, "issues");
  const filters: Record<string, string> = {};
  let limit = Infinity;
  const query = {
    select: () => query,
    lte: () => query,
    eq: (field: string, value: string) => { filters[field] = value; return query; },
    order: () => query,
    limit: (value: number) => { limit = value; return query; },
    maybeSingle: async () => {
      reads.push({ exact: filters.week_of });
      return { data: rows.filter((row) => row.user_id === filters.user_id &&
        (!filters.week_of || row.week_of === filters.week_of)).slice(0, limit)[0] ?? null, error: null };
    },
    range: async (from: number, to: number) => {
      reads.push({ from, to });
      return { data: rows.filter((row) => row.user_id === filters.user_id).slice(from, to + 1), error: null };
    },
  };
  return query;
} };

const legacy = await selectIssue(sb, null, "reader", () => "2026-09-24", latestVisibleIssue);
assert.equal(legacy.data?.week_of, "2026-09-23", "legacy links skip the hidden newest issue");
assert.equal(issueIsReaderVisible(legacy.data ?? {}), true);
// One full issue first, then a wider window only because it was hidden.
assert.deepEqual(reads, [{ from: 0, to: 0 }, { from: 1, to: 24 }]);

reads.length = 0;
const exactHidden = await selectIssue(sb, "2026-09-24", "reader", () => "2026-09-24", latestVisibleIssue);
assert.equal(exactHidden.data?.week_of, "2026-09-24", "v2 selects its exact week, without substitution");
assert.equal(issueIsReaderVisible(exactHidden.data ?? {}), false, "the page must hide that exact issue");
assert.deepEqual(reads, [{ exact: "2026-09-24" }]);
assert.match(page, /issueRow && issueIsReaderVisible\(issueRow\)/);

reads.length = 0;
const exactGood = await selectIssue(sb, "2026-09-23", "reader", () => "2026-09-24", latestVisibleIssue);
assert.equal(exactGood.data?.week_of, "2026-09-23");
assert.deepEqual(reads, [{ exact: "2026-09-23" }]);
console.log("Legacy and exact letter selection offline fixtures passed.");
