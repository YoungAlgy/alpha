// Memory-only pagination checks. No environment, database, or provider access.
import assert from "node:assert/strict";
import { latestVisibleIssue } from "../lib/latest-visible-issue.ts";

const good = { editor_intro: "Current source summary", sections: [] };
const bad = { editor_intro: "", sections: [{ body: "(full text unavailable - snippet: source excerpt)" }] };
const pages: Array<[number, number]> = [];
const mixed = [...Array.from({ length: 25 }, () => bad), bad, good];
const found = await latestVisibleIssue(async (from, to) => {
  pages.push([from, to]);
  return { data: mixed.slice(from, to + 1), error: null };
});
assert.equal(found.data, good);
assert.deepEqual(pages, [[0, 24], [25, 49]]);
assert.equal(found.error, null);
assert.deepEqual(await latestVisibleIssue(async () => ({ data: [bad], error: null })), { data: null, error: null });
const failure = new Error("offline fixture");
assert.equal((await latestVisibleIssue(async () => ({ data: null, error: failure }))).error, failure);
let calls = 0;
const bounded = await latestVisibleIssue(async () => {
  calls++;
  return { data: Array.from({ length: 25 }, () => bad), error: null };
});
assert.equal(calls, 4);
assert.ok(bounded.error, "a full safety window is not reported as no letters");
assert.equal(bounded.data, null);
console.log("Latest visible issue offline checks passed.");
