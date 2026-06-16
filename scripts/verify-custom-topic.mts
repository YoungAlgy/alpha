// Verify the custom-topic helpers (encoding, labels, validation). Pure, fast.
// Run: npx tsx scripts/verify-custom-topic.mts
const { isCustomTopic, customTopicText, makeCustomTopic, topicLabel, topicEmoji, topicAnchor, CUSTOM_PREFIX } =
  await import("../lib/topics.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// make + encode
check("makeCustomTopic encodes with prefix + lowercases", makeCustomTopic("crypto trends in Asia") === `${CUSTOM_PREFIX}crypto trends in asia`);
check("makeCustomTopic trims + collapses whitespace + lowercases", makeCustomTopic("  F1   aero  ") === `${CUSTOM_PREFIX}f1 aero`);
check("makeCustomTopic rejects empty", makeCustomTopic("   ") === null);
// The whole point of normalizing: same words in any case = the SAME shared id,
// so two readers share one cached generation instead of paying for two.
check("makeCustomTopic: EDM and edm share one id", makeCustomTopic("EDM") === makeCustomTopic("edm") && makeCustomTopic("EDM") === `${CUSTOM_PREFIX}edm`);
check("makeCustomTopic: 'EDM music' and 'edm  music' share one id", makeCustomTopic("EDM music") === makeCustomTopic("edm  music"));
check("makeCustomTopic rejects 1 char", makeCustomTopic("a") === null);
check("makeCustomTopic truncates to 80 chars", (makeCustomTopic("x".repeat(120)) ?? "").length === CUSTOM_PREFIX.length + 80);

// detect
check("isCustomTopic true for custom", isCustomTopic("custom:foo") === true);
check("isCustomTopic false for catalog", isCustomTopic("ai-news") === false);

// text
check("customTopicText strips prefix", customTopicText("custom:Crypto in Asia") === "Crypto in Asia");

// labels (catalog vs custom)
check("topicLabel catalog resolves registry", topicLabel("trading-cards") === "Trading cards");
check("topicLabel custom capitalizes the text", topicLabel("custom:crypto trends in asia") === "Crypto trends in asia");
check("topicLabel unknown catalog id falls back to id", topicLabel("not-a-topic") === "not-a-topic");

// emoji
check("topicEmoji custom = sparkle", topicEmoji("custom:anything") === "✨");
check("topicEmoji catalog resolves registry", topicEmoji("trading-cards") === "🃏");

// anchor (valid HTML id, consistent for section + TOC jump)
check("topicAnchor catalog unchanged", topicAnchor("ai-news") === "s-ai-news");
check("topicAnchor custom is slugified (no spaces/colons)", topicAnchor("custom:crypto trends in Asia") === "s-custom-crypto-trends-in-asia");
check("topicAnchor produces a valid id (no whitespace)", !/\s/.test(topicAnchor("custom:a b c")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CUSTOM TOPIC HELPER VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CUSTOM-TOPIC HELPER ASSERTIONS PASS");
