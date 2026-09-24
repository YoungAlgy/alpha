import { topicLabel } from "@/lib/topics";
import { sanitizeVoice } from "./voice-guard";
import { cleanField } from "./text-clean";
import { normalizeUrl } from "./url-guard";
import { codePointSafeTruncate } from "@/lib/text-truncate";
import type { TopicBlurb, TopicSignal, BlurbItem, SignalSource } from "./types";

/**
 * A no-model last resort for a topic that already has a real live signal.
 *
 * This is intentionally a formatter, not a summarizer. It never invents a
 * claim, URL, date, or statistic. It turns the resolver's chosen source
 * titles and snippets into short, citable read items. The normal model
 * waterfall still runs first. This path exists so a provider outage or a
 * zero-cost mode can preserve a grounded issue instead of dropping the topic
 * after search has already succeeded.
 */

const MAX_SOURCES = 3;
const MAX_TITLE_CHARS = 160;
const MAX_EXCERPT_CHARS = 900;

function firstLineTitle(line: string): string | null {
  const match = line.match(/^\s*\[\d+\]\s+(.+?)\s*$/);
  return match?.[1] ? cleanField(match[1]) : null;
}

function sourceIsAllowed(signal: TopicSignal, url: string): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  // Live signals carry an explicit allow-set built from the resolver's source
  // fields. Mock callers from older tests may omit it, so parsed source URLs
  // remain acceptable in that legacy shape.
  return !signal.citableUrls || signal.citableUrls.has(normalized);
}

function safeExcerpt(text: string): string {
  const cleaned = sanitizeVoice(cleanField(text));
  if (!cleaned) return "";
  const truncated = codePointSafeTruncate(cleaned, MAX_EXCERPT_CHARS - 3);
  return truncated.truncated ? `${truncated.text.trimEnd()}...` : truncated.text;
}

/** Compatibility for legacy context-only signals. Live resolvers use sources. */
function parseDeepSources(signal: TopicSignal): SignalSource[] {
  const sources: SignalSource[] = [];
  // The resolver does not put a dashed separator before its breadth section or
  // footer. Stop at those boundaries before reading the final source body.
  const deepContext = signal.context.replace(/\r\n/g, "\n")
    .split(/^=== (?:MORE THIS WEEK|THIS WEEK) \(headlines \+ links\) ===|^All URLs (?:labeled SOURCE|listed above)/m)[0];
  const blocks = deepContext.split(/\n+----------\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const sourceLine = lines.findIndex((line) => /^\s*SOURCE:\s*https?:\/\//i.test(line));
    if (sourceLine < 0) continue;
    const url = lines[sourceLine].replace(/^\s*SOURCE:\s*/i, "").trim();
    if (!sourceIsAllowed(signal, url)) continue;
    const titleLine = lines.find((line, index) => index < sourceLine && firstLineTitle(line) !== null);
    const title = (titleLine && firstLineTitle(titleLine)) || new URL(url).hostname;
    const raw = lines.slice(sourceLine + 1).join("\n").trim();
    const excerpt = raw.replace(/^\(full text unavailable — snippet: ([\s\S]*)\)$/, "$1");
    sources.push({ title, url, excerpt });
  }
  return sources;
}

/** Extract the headline-plus-snippet blocks emitted for breadth sources. */
function parseHeadlineSources(signal: TopicSignal): SignalSource[] {
  const sources: SignalSource[] = [];
  // Brave/You.com breadth blocks include a host in parentheses. Gemini's
  // grounded-search fallback emits the same bullet shape without that host.
  // Keep the parenthesized part optional so both resolver-owned formats are
  // handled without loosening the URL or bullet boundaries.
  // A breadth excerpt is exactly the immediately following indented line.
  // source-resolver emits two leading spaces even for an empty description.
  // Requiring horizontal indentation keeps an empty description from consuming
  // the next bullet as this source's excerpt.
  const headlineRe = /^\s*-\s+(.+?)(?:\s+\([^\n]*?\))?\s+—\s+(https?:\/\/\S+)(?:\r?\n[ \t]+([^\r\n]*))?/gm;
  for (const match of signal.context.matchAll(headlineRe)) {
    const title = cleanField(match[1]);
    const url = match[2].trim();
    if (!title || !sourceIsAllowed(signal, url)) continue;
    sources.push({ title, url, excerpt: match[3] ?? "" });
  }
  return sources;
}

function uniqueSources(signal: TopicSignal): SignalSource[] {
  const seen = new Set<string>();
  const result: SignalSource[] = [];
  const candidates = signal.sources ?? [...parseDeepSources(signal), ...parseHeadlineSources(signal)];
  for (const source of candidates) {
    const normalized = normalizeUrl(source.url);
    if (!normalized || !sourceIsAllowed(signal, source.url) || seen.has(normalized)) continue;
    const title = sanitizeVoice(cleanField(source.title)) || new URL(source.url).hostname;
    seen.add(normalized);
    result.push({
      ...source,
      title: codePointSafeTruncate(title, MAX_TITLE_CHARS).text.trim(),
      excerpt: safeExcerpt(source.excerpt),
      // Keep the original absolute URL for the reader's clickable reference.
      // The normalized value is only an internal identity for deduplication
      // and the resolver's citable allow-set.
      url: source.url.trim(),
    });
    if (result.length >= MAX_SOURCES) break;
  }
  return result;
}

function itemForSource(topic: string, source: SignalSource): BlurbItem {
  const body = source.excerpt
    ? source.excerpt
    : `Read the piece for the details on ${topic.toLowerCase()}.`;
  return {
    kind: "read",
    headline: source.title,
    body,
    primaryRef: {
      label: source.title,
      url: source.url,
    },
    supplementaryRefs: [],
  };
}

export function buildDeterministicBlurb(signal: TopicSignal): TopicBlurb | null {
  const sources = uniqueSources(signal);
  if (sources.length === 0) return null;
  const label = topicLabel(signal.topicId);
  return {
    topicId: signal.topicId,
    topicLabel: label,
    weekOf: signal.weekOf,
    intro: `A few useful reads on ${label.toLowerCase()} today.`,
    items: sources.map((source) => itemForSource(label, source)),
  };
}
