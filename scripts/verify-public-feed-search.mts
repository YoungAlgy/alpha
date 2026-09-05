import { parsePublicFeedXml } from "../lib/engine/public-feed-search.ts";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) return;
  failures++;
  console.error(`FAIL: ${label}`);
}

const results = parsePublicFeedXml(`<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[An &amp; useful update]]></title>
    <link>https://example.com/story</link>
    <description><![CDATA[The &lt;b&gt;important&lt;/b&gt; detail is here. https://example.com/tracker]]></description>
    <pubDate>Sun, 30 Aug 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Missing link</title>
    <description>Not usable</description>
  </item>
</channel></rss>`);

check("parses one usable item", results.length === 1);
check("decodes the title", results[0]?.title === "An & useful update");
check("keeps the absolute article URL", results[0]?.url === "https://example.com/story");
check("strips markup and bare URLs from the description", results[0]?.description === "The important detail is here.");
check("keeps publication metadata", results[0]?.age === "Sun, 30 Aug 2026 12:00:00 GMT");

if (failures > 0) {
  console.error(`verify-public-feed-search: ${failures} failure(s)`);
  process.exit(1);
}
console.log("PASS verify-public-feed-search (offline)");
