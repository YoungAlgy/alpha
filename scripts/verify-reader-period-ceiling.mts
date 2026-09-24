// Offline verification for reader-facing issue queries. Each source-extracted
// query chain executes against an inert, thenable Supabase-shaped fixture.
// No route, provider, network, environment, or real-reader dependency loads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentPeriodIso } from "../lib/cadence.ts";
import { latestVisibleIssue } from "../lib/latest-visible-issue.ts";

// Freeze the test clock, not the production date helper. The same extracted
// queries must keep passing after the calendar advances beyond this fixture.
const fixtureNow = new Date("2026-09-05T08:00:00.000Z");
const fixturePeriod = () => currentPeriodIso(fixtureNow);

type IssueFixture = {
  id: string;
  week_of: string;
  delivered_at: string | null;
  resend_message_id: string | null;
  user_id: string;
};

type QueryResult = { data: IssueFixture[] | IssueFixture | null; error: null };

class InertIssueQuery implements PromiseLike<QueryResult> {
  private ceiling: string | null = null;
  private equals = new Map<string, unknown>();
  private descending = false;
  private start = 0;
  private end: number | null = null;
  private single = false;

  constructor(private readonly fixtures: IssueFixture[]) {}

  select() { return this; }
  lte(column: string, value: string) {
    assert.equal(column, "week_of");
    this.ceiling = value;
    return this;
  }
  eq(column: string, value: unknown) {
    this.equals.set(column, value);
    return this;
  }
  order(column: string, options: { ascending: boolean }) {
    assert.equal(column, "week_of");
    this.descending = options.ascending === false;
    return this;
  }
  range(start: number, end: number) {
    this.start = start;
    this.end = end;
    return this;
  }
  limit(limit: number) {
    this.start = 0;
    this.end = limit - 1;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  private result(): QueryResult {
    let rows = this.fixtures.filter((fixture) => {
      if (this.ceiling && fixture.week_of > this.ceiling) return false;
      return [...this.equals].every(([column, value]) =>
        fixture[column as keyof IssueFixture] === value
      );
    });
    if (this.descending) {
      rows = [...rows].sort((left, right) => right.week_of.localeCompare(left.week_of));
    }
    rows = rows.slice(this.start, this.end === null ? undefined : this.end + 1);
    return { data: this.single ? rows[0] ?? null : rows, error: null };
  }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result()).then(onfulfilled, onrejected);
  }
}

function inertClient(fixtures: IssueFixture[]) {
  return {
    from(table: string) {
      assert.equal(table, "issues");
      return new InertIssueQuery(fixtures);
    },
  };
}

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function extractOne(file: string, pattern: RegExp, label: string): string {
  const matches = file.match(pattern) ?? [];
  assert.equal(matches.length, 1, `${label} must have one extractable issue query`);
  return matches[0];
}

async function executeChain(
  chain: string,
  fixtures: IssueFixture[],
  values: Record<string, unknown> = {}
): Promise<QueryResult> {
  const run = new Function(
    "sb", "currentPeriodIso", "session", "forIssueId", "from", "PAGE_SIZE",
    `return (async () => ${chain})();`
  ) as (
    sb: ReturnType<typeof inertClient>, period: typeof currentPeriodIso,
    session: { user: { id: string } }, forIssueId: string, from: number, pageSize: number
  ) => Promise<QueryResult>;
  return run(
    inertClient(fixtures), fixturePeriod, { user: { id: "unit-reader" } },
    (values.forIssueId as string | undefined) ?? "unit-current",
    (values.from as number | undefined) ?? 0,
    (values.PAGE_SIZE as number | undefined) ?? 100
  );
}

const inboxSource = source("../app/inbox/page.tsx");
const directSource = source("../app/inbox/[issueId]/page.tsx");
const archiveSource = source("../app/archive/page.tsx");
const letterSource = source("../app/letter/page.tsx");
// The inbox reads through latestVisibleIssue, one row window at a time.
const inboxChain = extractOne(inboxSource, /sb\s*\.from\("issues"\)[\s\S]*?\.range\(from, to\)/g, "inbox");
async function executeInbox(fixtures: IssueFixture[]): Promise<QueryResult> {
  const run = new Function(
    "sb", "currentPeriodIso", "latestVisibleIssue",
    `return latestVisibleIssue((from, to) => ${inboxChain});`
  ) as (sb: ReturnType<typeof inertClient>, period: typeof currentPeriodIso, walk: typeof latestVisibleIssue) => Promise<QueryResult>;
  return run(inertClient(fixtures), fixturePeriod, latestVisibleIssue);
}
const directChain = extractOne(directSource, /sb\s*\.from\("issues"\)[\s\S]*?\.maybeSingle\(\)/g, "direct inbox");
const archiveChains = archiveSource.match(/sb\s*\.from\("issues"\)[\s\S]*?\.range\([^\n]*\)/g) ?? [];
assert.equal(archiveChains.length, 2, "archive must have initial and load-more issue queries");
const [archiveInitialChain, archiveLoadMoreChain] = archiveChains;
const letterStart = letterSource.indexOf("const issueQuery = () => sb");
const letterEnd = letterSource.indexOf("// alpha-drift-r65-04", letterStart);
assert.ok(letterStart >= 0 && letterEnd > letterStart, "letter query setup must remain extractable");
// The setup ends by building issueRead, the exact v2 read or the legacy
// walk past hidden issues. Drop the one TypeScript generic so it runs as JS.
const letterSetup = letterSource.slice(letterStart, letterEnd).replace("latestVisibleIssue<IssueRow>(", "latestVisibleIssue(");
assert.ok(letterSetup.includes("const issueRead = weekOf"), "letter query setup must build issueRead");

async function executeLetter(fixtures: IssueFixture[], weekOf: string | undefined): Promise<QueryResult> {
  const run = new Function(
    "sb", "currentPeriodIso", "userId", "weekOf", "latestVisibleIssue",
    `return (async () => { ${letterSetup} return await issueRead; })();`
  ) as (
    sb: ReturnType<typeof inertClient>, period: typeof currentPeriodIso,
    userId: string, weekOf: string | undefined, walk: typeof latestVisibleIssue
  ) => Promise<QueryResult>;
  return run(inertClient(fixtures), fixturePeriod, "unit-reader", weekOf, latestVisibleIssue);
}

const fixture = (id: string, weekOf: string, extra: Partial<IssueFixture> = {}): IssueFixture => ({
  id, week_of: weekOf, delivered_at: null, resend_message_id: null, user_id: "unit-reader", ...extra,
});
const periodFixtures = [
  fixture("unit-older", "2026-09-04", { delivered_at: "2026-09-04T14:01:00.000Z", resend_message_id: "unit-message" }),
  fixture("unit-current", "2026-09-05"),
  fixture("unit-future", "2026-09-06"),
];

let checks = 0;
function check(condition: boolean, message: string) {
  assert.ok(condition, message);
  checks += 1;
}

const inbox = await executeInbox(periodFixtures);
assert.equal((inbox.data as IssueFixture | null)?.id, "unit-current");
check(true, "inbox executes its actual latest-period query");

const directCurrent = await executeChain(directChain, periodFixtures, { forIssueId: "unit-current" });
assert.equal((directCurrent.data as IssueFixture | null)?.id, "unit-current");
const directFuture = await executeChain(directChain, periodFixtures, { forIssueId: "unit-future" });
assert.equal(directFuture.data, null, "direct issue query must deny a future-period id");
check(true, "direct inbox executes current and future-id query paths");

const paginationFixtures = Array.from({ length: 101 }, (_, index) => fixture(`unit-page-${index}`, "2026-09-05"))
  .concat(fixture("unit-page-future", "2026-09-06"));
const archiveInitial = await executeChain(archiveInitialChain, paginationFixtures);
assert.equal((archiveInitial.data as IssueFixture[]).length, 100);
assert.equal((archiveInitial.data as IssueFixture[])[0].id, "unit-page-0");
const archiveMore = await executeChain(archiveLoadMoreChain, paginationFixtures, { from: 100 });
assert.deepEqual((archiveMore.data as IssueFixture[]).map((row) => row.id), ["unit-page-100"]);
check(true, "archive initial and load-more chains retain the period ceiling");

const archiveDeliveryStates = await executeChain(archiveInitialChain, periodFixtures);
assert.deepEqual(
  (archiveDeliveryStates.data as IssueFixture[]).map((row) => row.id),
  ["unit-current", "unit-older"],
  "archive keeps both a current undelivered issue and an older delivered issue"
);
check(true, "reader queries do not substitute provider delivery proof for period access");

const letterV2Future = await executeLetter(periodFixtures, "2026-09-06");
assert.equal(letterV2Future.data, null, "v2 token cannot select a future issue");
const letterLegacy = await executeLetter(periodFixtures, undefined);
assert.equal((letterLegacy.data as IssueFixture | null)?.id, "unit-current");
check(true, "letter v2 and legacy-fallback chains execute the same UTC ceiling");

assert.equal(currentPeriodIso(new Date("2026-09-04T23:59:59.999Z")), "2026-09-04");
assert.equal(currentPeriodIso(new Date("2026-09-04T20:00:00.000-04:00")), "2026-09-05");
assert.equal(currentPeriodIso(new Date("2026-09-05T14:00:00.000+14:00")), "2026-09-05");
check(true, "UTC period helper is stable across midnight and reader offsets");

const currentUndelivered = await executeInbox([fixture("unit-current-undelivered", "2026-09-05")]);
assert.equal((currentUndelivered.data as IssueFixture | null)?.id, "unit-current-undelivered");
check(true, "current-period undelivered issue remains readable");

console.log(`PASS verify-reader-period-ceiling (${checks} extracted-query checks, offline)`);
