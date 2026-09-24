// Pure local fixtures. No search, subscriber data, or provider requests.
import assert from "node:assert/strict";
import { rankAndDedup } from "../lib/engine/source-rank.ts";

const result = (title: string, url: string, description = "") => ({
  title, url, description, age: "1 day ago",
});

const githubCiIssue = result(
  "SHA-pin GitHub Actions",
  "https://github.com/agigante80/Actual-sync/issues/249",
  "Update an Actions workflow",
);
const githubBettingIssue = result(
  "Betting software issue",
  "https://github.com/callancapitolo17/NFLWork/issues/132",
  "NFL odds parser bug",
);
const gitlabRepo = result("Sports odds parser", "https://gitlab.com/dev/odds-parser/-/merge_requests/7");
const actualOdds = result(
  "NFL lines move after the injury report",
  "https://www.actionnetwork.com/nfl/odds-injury-report",
  "The market repriced the matchup",
);
assert.deepEqual(
  rankAndDedup([githubCiIssue, githubBettingIssue, gitlabRepo, actualOdds], 2, undefined, "sports-betting").map((s) => s.url),
  [actualOdds.url],
);
assert.equal(rankAndDedup([githubCiIssue], 2, undefined, "ai-news").length, 1);
assert.equal(rankAndDedup([githubCiIssue]).length, 1, "legacy callers retain ranking");

// Boy Harsher is a shape-only local fixture, not a claim about live metadata.
const unrelatedAlbumReview = result(
  "Boy Harsher: Album Review",
  "https://pitchfork.com/reviews/albums/boy-harsher-example/",
  "An electronic duo releases a new record",
);
const hiphopReview = result(
  "A new rap album review",
  "https://pitchfork.com/reviews/albums/example-rapper-release/",
  "A rapper builds a vivid new record",
);
const dedicatedHipHop = result(
  "Artist's new release",
  "https://www.xxlmag.com/artist-new-album/",
  "A new release",
);
assert.deepEqual(
  rankAndDedup([unrelatedAlbumReview, hiphopReview, dedicatedHipHop], 2, undefined, "music-hiphop").map((s) => s.url),
  [hiphopReview.url, dedicatedHipHop.url],
);
assert.equal(rankAndDedup([unrelatedAlbumReview], 2, undefined, "music-indie").length, 1);
assert.equal(rankAndDedup([
  { ...unrelatedAlbumReview, url: unrelatedAlbumReview.url.replace("pitchfork.com", "amp.pitchfork.com") },
], 2, undefined, "music-hiphop").length, 0, "publisher mirrors use the same topic guard");
assert.equal(rankAndDedup([dedicatedHipHop], 2, undefined, "music-hiphop").length, 1);

// Filtering happens before authority sort and the per-host cap.
const survived = rankAndDedup([unrelatedAlbumReview, hiphopReview], 1, undefined, "music-hiphop");
assert.deepEqual(survived.map((s) => s.url), [hiphopReview.url]);
assert.equal(survived[0]?.tier, "trusted");

console.log("PASS verify-source-topic-relevance (topic-specific source guards and legacy ranking)");
