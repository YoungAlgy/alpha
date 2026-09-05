// Verify the generic-fallback pool extension: when a reader's own topics
// (mains + backups) can't fill the letter, the tail we reach for next is a
// short, deliberately BROAD list (money/markets/AI first), never a narrow or
// demographic topic nobody but some other reader chose. Pure function, no
// Claude/Brave/DB — see lib/engine/assemble.ts's buildGenerationPool.
// Run: npx tsx scripts/verify-generic-fallback.mts
import type { TopicId } from "../lib/types.ts";

const { buildGenerationPool } = await import("../lib/engine/assemble.ts");
const { GENERIC_FALLBACK_TOPICS } = await import("../lib/topics.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  if (cond) pass++;
  else fail++;
};

// (1) Reader pool shares nothing with the fallback list → fallback appended
// in full, in its defined order, after every reader topic untouched.
{
  const readerPool: TopicId[] = ["healthcare-recruiting", "sales-persuasion"];
  const out = buildGenerationPool(readerPool);
  check(
    "(1) reader topics first, unchanged",
    out[0] === "healthcare-recruiting" && out[1] === "sales-persuasion"
  );
  check(
    "(1) full fallback tail appended, in GENERIC_FALLBACK_TOPICS order",
    JSON.stringify(out.slice(2)) === JSON.stringify(GENERIC_FALLBACK_TOPICS)
  );
  check("(1) total length = reader + fallback, no dupes", out.length === readerPool.length + GENERIC_FALLBACK_TOPICS.length);
}

// (2) Reader already has a fallback topic ranked → not duplicated, and it
// keeps its OWN rank rather than also appearing again in the tail.
{
  const readerPool: TopicId[] = ["macro-markets", "sales-persuasion", "personal-finance"];
  const out = buildGenerationPool(readerPool);
  const occurrences = (id: string) => out.filter((x) => x === id).length;
  check("(2) macro-markets appears exactly once", occurrences("macro-markets") === 1);
  check("(2) personal-finance appears exactly once", occurrences("personal-finance") === 1);
  check("(2) macro-markets keeps its own rank (index 0)", out[0] === "macro-markets");
  check(
    "(2) only the NOT-already-ranked fallback topics got appended",
    out.length === readerPool.length + (GENERIC_FALLBACK_TOPICS.length - 2)
  );
}

// (3) Reader's pool already covers every fallback topic → nothing appended.
{
  const readerPool: TopicId[] = [...GENERIC_FALLBACK_TOPICS, "music"];
  const out = buildGenerationPool(readerPool);
  check("(3) no extra topics appended when fallback set is a subset", out.length === readerPool.length);
  check("(3) pool returned unchanged, in order", JSON.stringify(out) === JSON.stringify(readerPool));
}

// (4) Doesn't mutate the caller's array.
{
  const readerPool: TopicId[] = ["music"];
  const before = JSON.stringify(readerPool);
  buildGenerationPool(readerPool);
  check("(4) input array not mutated", JSON.stringify(readerPool) === before);
}

// (5) Empty reader pool (defensive — generateIssue itself guards against this
// upstream, but the pure helper shouldn't misbehave if ever called directly).
{
  const out = buildGenerationPool([]);
  check("(5) empty reader pool → just the fallback tail", JSON.stringify(out) === JSON.stringify(GENERIC_FALLBACK_TOPICS));
}

// (6) The fallback list itself never includes a narrow/demographic/personal
// topic — the whole point of the feature. Regression guard for future edits.
{
  const banned = [
    "womens-health",
    "mental-health",
    "parenting",
    "faith-meaning",
    "faith-christianity",
    "faith-islam",
    "faith-judaism",
    "faith-hinduism",
    "faith-buddhism",
    "faith-spiritual",
    "sports-betting",
    "music",
    "music-edm",
    "music-hiphop",
    "music-indie",
    "music-country",
    "trading-cards",
    "style-fashion",
    "web3-updates",
    "zodiac",
  ];
  const overlap = GENERIC_FALLBACK_TOPICS.filter((id) => banned.includes(id));
  check("(6) fallback list carries no narrow/demographic topic", overlap.length === 0);
  check("(6) fallback list leads with money/markets (investing first)", GENERIC_FALLBACK_TOPICS[0] === "personal-finance");
  check("(6) fallback list is non-empty", GENERIC_FALLBACK_TOPICS.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("GENERIC-FALLBACK ASSERTIONS FAILED");
  process.exit(1);
}
console.log("ALL GENERIC-FALLBACK ASSERTIONS PASS");
