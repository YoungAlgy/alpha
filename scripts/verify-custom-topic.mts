// Verify the custom-topic helpers (encoding, labels, validation). Pure, fast.
// Run: npx tsx scripts/verify-custom-topic.mts
const { isCustomTopic, customTopicText, makeCustomTopic, topicLabel, topicEmoji, CUSTOM_PREFIX } =
  await import("../lib/topics.ts");

let pass = 0,
  fail = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "OK " : "XX "} ${label}`);
  cond ? pass++ : fail++;
};

// make + encode
check("makeCustomTopic encodes with prefix", makeCustomTopic("crypto trends in Asia") === `${CUSTOM_PREFIX}crypto trends in Asia`);
check("makeCustomTopic trims + collapses whitespace", makeCustomTopic("  F1   aero  ") === `${CUSTOM_PREFIX}F1 aero`);
check("makeCustomTopic rejects empty", makeCustomTopic("   ") === null);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CUSTOM TOPIC HELPER VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CUSTOM-TOPIC HELPER ASSERTIONS PASS");
