import type { BraveResult } from "@/lib/brave";
import { MIRROR_SUBDOMAIN_RE } from "./url-guard";

// A small, topic-specific guard for source shapes that search recency and
// global host authority cannot make relevant. Keep it before ranking so a
// rejected result cannot consume a trusted slot or a per-host cap slot.
export function sourceFitsTopic(topicId: string, source: BraveResult): boolean {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(MIRROR_SUBDOMAIN_RE, "");

  if (topicId === "sports-betting") {
    // These hosts publish repository, issue, PR and CI pages. A software issue
    // mentioning betting or odds is not a sports-market report.
    if (host === "github.com" || host === "gitlab.com") return false;
  }

  if (topicId === "music-hiphop" &&
      (host === "pitchfork.com" || host === "stereogum.com")) {
    const reviewPath = /(?:^|[-/])(?:album|albums|review|reviews)(?:[-/]|$)/i.test(url.pathname);
    if (reviewPath) {
      // These are genre-general outlets. A review needs explicit genre evidence
      // before it can fill a hip-hop slot. Sparse metadata may make the topic
      // quiet, allowing the normal backup-topic selection to take over.
      const evidence = `${source.title} ${source.description} ${url.pathname}`;
      if (!/\b(?:hip[\s-]?hop|rap|rapper|rappers|rapping)\b/i.test(evidence)) return false;
    }
  }

  return true;
}
