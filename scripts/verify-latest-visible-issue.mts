// Memory-only pagination checks. No environment, database, or provider access.
import assert from "node:assert/strict";
import { latestVisibleIssue } from "../lib/latest-visible-issue.ts";

const good = { editor_intro: "Current source summary", sections: [] };
const bad = { editor_intro: "", sections: [{ body: "(full text unavailable - snippet: source excerpt)" }] };

// The common case reads exactly one issue.
const firstReads: Array<[number, number]> = [];
const first = await latestVisibleIssue(async (from, to) => {
  firstReads.push([from, to]);
  return { data: [good, bad].slice(from, to + 1), error: null };
});
assert.equal(first.data, good);
assert.deepEqual(firstReads, [[0, 0]]);

// Hidden rows widen the window until a visible one appears.
const pages: Array<[number, number]> = [];
const mixed = [...Array.from({ length: 25 }, () => bad), bad, good];
const found = await latestVisibleIssue(async (from, to) => {
  pages.push([from, to]);
  return { data: mixed.slice(from, to + 1), error: null };
});
assert.equal(found.data, good);
assert.deepEqual(pages, [[0, 0], [1, 24], [25, 49]]);
assert.equal(found.error, null);
assert.deepEqual(await latestVisibleIssue(async () => ({ data: [], error: null })), { data: null, error: null });
assert.deepEqual(
  await latestVisibleIssue(async (from, to) => ({ data: [bad, bad].slice(from, to + 1), error: null })),
  { data: null, error: null },
  "a short final window means there are no more rows",
);
const failure = new Error("offline fixture");
assert.equal((await latestVisibleIssue(async () => ({ data: null, error: failure }))).error, failure);
let calls = 0;
const allHidden = Array.from({ length: 150 }, () => bad);
const bounded = await latestVisibleIssue(async (from, to) => {
  calls++;
  return { data: allHidden.slice(from, to + 1), error: null };
});
assert.equal(calls, 5);
assert.ok(bounded.error, "a full safety window is not reported as no letters");
assert.equal(bounded.data, null);
console.log("Latest visible issue offline checks passed.");
