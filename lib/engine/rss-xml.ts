import { decodeTextEntities } from "@/lib/text-entities";
import { cleanField } from "./text-clean";

type XmlToken = {
  start: number;
  end: number;
  name?: string;
  closing?: boolean;
  selfClosing?: boolean;
};

function unwrapCdata(raw: string): string {
  const open = /<!\[CDATA\[/gi;
  const parts: string[] = [];
  let cursor = 0;
  for (let match = open.exec(raw); match; match = open.exec(raw)) {
    const close = raw.indexOf("]]>", open.lastIndex);
    if (close < 0) break;
    parts.push(raw.slice(cursor, match.index), raw.slice(open.lastIndex, close));
    cursor = close + 3;
    open.lastIndex = cursor;
  }
  parts.push(raw.slice(cursor));
  return parts.join("");
}

// This bounded RSS tokenizer is not a general XML implementation. CDATA,
// comments and processing instructions stay opaque. Each scan advances its
// cursor so malformed public text cannot force repeated suffix searches.
function nextXmlToken(xml: string, from: number): XmlToken | undefined {
  const start = xml.indexOf("<", from);
  if (start < 0) return;
  if (xml.startsWith("<![CDATA[", start)) {
    const close = xml.indexOf("]]>", start + 9);
    return close < 0 ? undefined : { start, end: close + 3 };
  }
  if (xml.startsWith("<!--", start)) {
    const close = xml.indexOf("-->", start + 4);
    return close < 0 ? undefined : { start, end: close + 3 };
  }
  if (xml.startsWith("<?", start)) {
    const close = xml.indexOf("?>", start + 2);
    return close < 0 ? undefined : { start, end: close + 2 };
  }
  if (xml.startsWith("<!", start)) {
    const close = xml.indexOf(">", start + 2);
    return close < 0 ? undefined : { start, end: close + 1 };
  }

  let quote = "";
  let end = start + 1;
  for (; end < xml.length; end++) {
    const char = xml[end]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "<") {
      return;
    } else if (char === ">") {
      break;
    }
  }
  if (end >= xml.length || quote) return;
  let nameStart = start + 1;
  while (nameStart < end && /\s/.test(xml[nameStart]!)) nameStart++;
  const closing = xml[nameStart] === "/";
  if (closing) nameStart++;
  while (nameStart < end && /\s/.test(xml[nameStart]!)) nameStart++;
  const name = xml.slice(nameStart, end).match(/^[A-Za-z_][\w:.-]*/)?.[0];
  if (!name) return { start, end: end + 1 };
  const afterName = nameStart + name.length;
  if (afterName < end && !/\s/.test(xml[afterName]!) && xml[afterName] !== "/") return;
  // Closing tags have no attributes or self-closing suffix. A name prefix
  // alone must not make malformed markup count as a matched closing tag.
  if (closing) {
    let tail = afterName;
    while (tail < end && /\s/.test(xml[tail]!)) tail++;
    if (tail !== end) return;
    return { start, end: end + 1, name: name.toLowerCase(), closing, selfClosing: false };
  }
  // Opening-tag suffixes may contain quoted attributes or a final slash.
  // A slash/name fragment must not masquerade as a normal element name.
  let tail = afterName;
  let selfClosing = false;
  const attributes = new Set<string>();
  const attributeName = /[A-Za-z_][\w:.-]*/y;
  while (tail < end) {
    const beforeSpace = tail;
    while (tail < end && /\s/.test(xml[tail]!)) tail++;
    if (tail === end) break;
    if (xml[tail] === "/") {
      if (tail !== end - 1) return;
      selfClosing = true;
      break;
    }
    if (tail === beforeSpace) return;
    attributeName.lastIndex = tail;
    const attribute = attributeName.exec(xml)?.[0];
    if (!attribute || attributes.has(attribute)) return;
    attributes.add(attribute);
    tail += attribute.length;
    while (tail < end && /\s/.test(xml[tail]!)) tail++;
    if (xml[tail++] !== "=") return;
    while (tail < end && /\s/.test(xml[tail]!)) tail++;
    const delimiter = xml[tail];
    if (delimiter !== "\"" && delimiter !== "'") return;
    const close = xml.indexOf(delimiter, tail + 1);
    if (close < 0 || close >= end || xml.slice(tail + 1, close).includes("<")) return;
    tail = close + 1;
  }
  return { start, end: end + 1, name: name.toLowerCase(), closing, selfClosing };
}

/** Validate the whole feed before returning direct channel item blocks. */
export function rssItemBlocks(xml: string, maxItems = 100, label = "RSS"): string[] {
  const stack: string[] = [];
  const blocks: string[] = [];
  let itemStart: number | undefined;
  let rssRootCount = 0;
  let channelCount = 0;
  let rssClosed = false;
  let offset = 0;
  while (offset < xml.length) {
    const token = nextXmlToken(xml, offset);
    if (!token) {
      if (xml.slice(offset).trim()) throw new Error(`${label} invalid feed`);
      break;
    }
    if (stack.length === 0 && xml.slice(offset, token.start).trim()) {
      throw new Error(`${label} invalid feed`);
    }
    if (xml.startsWith("<!", token.start) &&
        !xml.startsWith("<!--", token.start) && !xml.startsWith("<![CDATA[", token.start)) {
      throw new Error(`${label} unsupported declaration`);
    }
    offset = token.end;
    if (!token.name) {
      const opaque = xml.startsWith("<!--", token.start) || xml.startsWith("<?", token.start) ||
        (stack.length > 0 && xml.startsWith("<![CDATA[", token.start));
      if (!opaque) {
        throw new Error(`${label} invalid feed`);
      }
      continue;
    }

    const name = token.name;
    if (token.closing) {
      if (stack.at(-1) !== name) throw new Error(`${label} invalid feed`);
      if (name === "rss" && stack.length === 1) rssClosed = true;
      if (name === "item" && itemStart !== undefined && stack.length === 3) {
        if (blocks.length < maxItems) blocks.push(xml.slice(itemStart, token.end));
        itemStart = undefined;
      }
      stack.pop();
      continue;
    }

    if (stack.length === 0) {
      if (name !== "rss" || rssRootCount !== 0 || rssClosed) throw new Error(`${label} invalid feed`);
      rssRootCount++;
    }
    if (name === "channel" && stack.length === 1 && stack[0] === "rss") {
      channelCount++;
      if (channelCount > 1) throw new Error(`${label} invalid feed`);
    }
    if (name === "item" && !token.selfClosing && stack.length === 2 && stack[0] === "rss" && stack[1] === "channel") {
      itemStart = token.start;
    }
    if (!token.selfClosing) stack.push(name);
    else if (name === "rss" || (name === "channel" && stack.length === 1)) {
      throw new Error(`${label} invalid feed`);
    }
  }
  if (rssRootCount !== 1 || channelCount !== 1 || !rssClosed || stack.length !== 0 || itemStart !== undefined) {
    throw new Error(`${label} invalid feed`);
  }
  return blocks;
}

/** Only direct item children can supply title, link, date or attribution. */
export function directChildValues(block: string, wantedTag: string, rawText = false, label = "RSS"): string[] {
  const stack: { name: string; valueStart: number }[] = [];
  const values: string[] = [];
  let offset = 0;
  while (offset < block.length) {
    const token = nextXmlToken(block, offset);
    if (!token) throw new Error(`${label} invalid item`);
    offset = token.end;
    if (!token.name) continue;
    if (token.closing) {
      const open = stack.pop();
      if (!open || open.name !== token.name) throw new Error(`${label} invalid item`);
      if (open.name === wantedTag && stack.length === 1 && stack[0]?.name === "item") {
        const raw = unwrapCdata(block.slice(open.valueStart, token.start));
        // Public adapters decode before their existing sanitizer pass. Licensed
        // metadata keeps its prior cleanField rules. Links always retain URLs.
        const clean = rawText || wantedTag === "link" ? decodeTextEntities(raw).trim() : cleanField(raw);
        if (clean) values.push(clean);
      }
      continue;
    }
    if (!token.selfClosing) stack.push({ name: token.name, valueStart: token.end });
  }
  if (stack.length !== 0) throw new Error(`${label} invalid item`);
  return values;
}
