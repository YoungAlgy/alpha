// Verify the ranked-pool letter selection: backfill, rank order, filler
// fallback, and the cost bound (dry topics cost no extra generation).
// Run: npx tsx scripts/verify-select-sections.mts
const { selectLetterSections, poolCap } = await import("../lib/engine/select-sections.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// genLive: returns a section unless the topic is in `dry`. Records call order.
function liveGen(dry: Set<string>, calls: string[]) {
  return async (id: string) => {
    calls.push(id);
    return dry.has(id) ? null : `live:${id}`;
  };
}
// genFiller: returns filler unless the topic is "nofiller" (e.g. a custom topic).
function fillerGen(noFiller: Set<string> = new Set()) {
  return async (id: string) => (noFiller.has(id) ? null : `filler:${id}`);
}
const ids = (r: { chosen: { topicId: string }[] }) => r.chosen.map((c) => c.topicId).join(",");

// (1) All favorites fresh → all chosen, in order, no backups touched.
{
  const calls: string[] = [];
  const r = await selectLetterSections(["a", "b", "c", "d", "e", "f", "g"], 5, liveGen(new Set(), calls), fillerGen());
  check("(1) top 5 fresh → chosen a,b,c,d,e", ids(r) === "a,b,c,d,e");
  check("(1) backups NOT generated (cost = letterSize)", calls.length === 5);
  check("(1) no filler used", r.usedFiller.length === 0);
}

// (2) Two favorites quiet → skipped, backfilled from the pool, rank order kept.
{
  const calls: string[] = [];
  const r = await selectLetterSections(["a", "b", "c", "d", "e", "f", "g"], 5, liveGen(new Set(["b", "d"]), calls), fillerGen());
  check("(2) b,d quiet → chosen a,c,e,f,g (backfilled, rank order)", ids(r) === "a,c,e,f,g");
  check("(2) cost = letterSize + 2 dry probes", calls.length === 7);
  check("(2) no filler (live backups covered it)", r.usedFiller.length === 0);
  check("(2) skippedDry = b,d", r.skippedDry.slice().sort().join(",") === "b,d");
}

// (3) Whole pool quiet + pool smaller than letterSize → filler keeps it full.
{
  const r = await selectLetterSections(["a", "b", "c"], 5, liveGen(new Set(["b"]), []), fillerGen());
  check("(3) a,c live + b filler, rank order a,b,c", ids(r) === "a,b,c");
  check("(3) b came from filler", r.usedFiller.join(",") === "b");
}

// (4) Regression: pool == letterSize, all fresh → identical to today.
{
  const r = await selectLetterSections(["a", "b", "c", "d", "e"], 5, liveGen(new Set(), []), fillerGen());
  check("(4) current-user case unchanged: a,b,c,d,e", ids(r) === "a,b,c,d,e");
}

// (5) Regression: pool == letterSize, one quiet, no backups → filler fills it
//     (so a current user's letter stays full, exactly like the old mock path).
{
  const r = await selectLetterSections(["a", "b", "c", "d", "e"], 5, liveGen(new Set(["c"]), []), fillerGen());
  check("(5) c quiet, no backup → filler keeps letter full, order a,b,c,d,e", ids(r) === "a,b,c,d,e");
  check("(5) c is the filler", r.usedFiller.join(",") === "c");
}

// (6) Quiet custom topic with no filler → dropped, letter just shorter.
{
  const r = await selectLetterSections(["custom:x", "b"], 2, liveGen(new Set(["custom:x"]), []), fillerGen(new Set(["custom:x"])));
  check("(6) quiet custom (no mock) dropped → only b", ids(r) === "b");
  check("(6) custom counted as skippedDry", r.skippedDry.join(",") === "custom:x");
}

// (7) Output is rank-ordered regardless of generation completion timing.
{
  const slowFirst = async (id: string) => {
    if (id === "a") await new Promise((r) => setTimeout(r, 20));
    return `live:${id}`;
  };
  const r = await selectLetterSections(["a", "b", "c"], 3, slowFirst, fillerGen());
  check("(7) rank order even if 'a' resolves last", ids(r) === "a,b,c");
}

// (8) poolCap: letterSize + a fixed 5 backups, capped at the catalog max.
check("(8) poolCap(5) = 10 (5 favorites + 5 backups)", poolCap(5) === 10);
check("(8) poolCap(10) = 15 (add a bundle, still 5 backups)", poolCap(10) === 15);
check("(8) poolCap(20) = 25", poolCap(20) === 25);
check("(8) poolCap(25) = 25 (top tier capped, no backups)", poolCap(25) === 25);
check("(8) poolCap(1) = 6", poolCap(1) === 6);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("SELECT-SECTIONS VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL SELECT-SECTIONS ASSERTIONS PASS");
