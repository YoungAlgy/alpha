// Verify the custom-topic helpers (encoding, labels, validation). Pure, fast.
// Run: npx tsx scripts/verify-custom-topic.mts
const { isCustomTopic, customTopicText, makeCustomTopic, topicLabel, topicEmoji, topicAnchor, CUSTOM_PREFIX, isZodiacTopicId, SUBTOPICS, PARENT_TOPIC } =
  await import("../lib/topics.ts");
const { zodiacQueries } = await import("../lib/engine/topic-queries.ts");

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
check("topicLabel custom title-cases the text", topicLabel("custom:crypto trends in asia") === "Crypto Trends in Asia");
// titleCaseTopic intent: significant words capitalize, small connectors stay
// lowercase mid-phrase (but capitalize when leading), and existing caps are
// preserved (so a stored acronym / a legacy mixed-case id keeps its case).
check("topicLabel keeps mid-phrase connectors lowercase", topicLabel("custom:lord of the rings") === "Lord of the Rings");
check("topicLabel capitalizes a leading connector", topicLabel("custom:the future of work") === "The Future of Work");
check("topicLabel preserves existing caps (legacy mixed-case id)", topicLabel("custom:islam and Quran - inspiring Hadiths") === "Islam and Quran - Inspiring Hadiths");
check("topicLabel unknown catalog id falls back to id", topicLabel("not-a-topic") === "not-a-topic");

// emoji
check("topicEmoji custom = sparkle", topicEmoji("custom:anything") === "✨");
check("topicEmoji catalog resolves registry", topicEmoji("trading-cards") === "🃏");

// anchor (valid HTML id, consistent for section + TOC jump)
check("topicAnchor catalog unchanged", topicAnchor("ai-news") === "s-ai-news");
check("topicAnchor custom is slugified (no spaces/colons)", topicAnchor("custom:crypto trends in Asia") === "s-custom-crypto-trends-in-asia");
check("topicAnchor produces a valid id (no whitespace)", !/\s/.test(topicAnchor("custom:a b c")));

// zodiac (parent picker id vs per-sign derived id)
console.log("(6) zodiac topic");
check("isZodiacTopicId: parent + per-sign true", isZodiacTopicId("zodiac") && isZodiacTopicId("zodiac-leo"));
check("isZodiacTopicId: a normal id is false", !isZodiacTopicId("music") && !isZodiacTopicId("ai-news"));
check("parent label = catalog label", topicLabel("zodiac") === "Zodiac & astrology");
check("per-sign label = the sign", topicLabel("zodiac-leo") === "Leo" && topicLabel("zodiac-scorpio") === "Scorpio");
check("per-sign emoji = crystal ball", topicEmoji("zodiac-leo") === "🔮");
check("per-sign anchor is a valid slug", topicAnchor("zodiac-leo") === "s-zodiac-leo");
check("zodiacQueries builds sign-specific search", zodiacQueries("zodiac-leo").every((q: string) => q.includes("Leo")) && zodiacQueries("zodiac-leo").length === 3);
check("zodiacQueries empty for a non-zodiac id", zodiacQueries("music").length === 0);

// religion (parent + subtopics, like music)
console.log("(7) religion topic");
check("faith-meaning relabeled to the umbrella", topicLabel("faith-meaning") === "Faith & religion");
check("faith subtopics labeled", topicLabel("faith-christianity") === "Christianity" && topicLabel("faith-islam") === "Islam");
check("SUBTOPICS lists the 6 faith options", (SUBTOPICS["faith-meaning"]?.length ?? 0) === 6);
check("PARENT_TOPIC maps a sub back to faith-meaning", PARENT_TOPIC["faith-buddhism"] === "faith-meaning");
check("a faith sub is NOT a custom or zodiac topic", !isCustomTopic("faith-judaism") && !isZodiacTopicId("faith-judaism"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("CUSTOM TOPIC HELPER VERIFICATION FAILED");
  process.exit(1);
}
console.log("ALL CUSTOM-TOPIC HELPER ASSERTIONS PASS");
