// Common publisher/XML entities plus numeric Unicode references. This returns
// plain text, not safe HTML. Callers must strip markup/URLs AFTER decoding.
// Bounded repeat passes handle double-encoded search/RSS snippets without an
// unbounded unescape loop or a new dependency in the delivery runtime.
export function decodeTextEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
    ldquo: "“", rdquo: "”", hellip: "…",
  };
  let result = value;
  for (let pass = 0; pass < 3; pass++) {
    const decoded = result.replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|lsquo|rsquo|ldquo|rdquo|hellip);/gi,
      (_, entity: string) => {
        if (!entity.startsWith("#")) return named[entity.toLowerCase()];
        const hex = entity[1]?.toLowerCase() === "x";
        const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : "\uFFFD";
      }
    );
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}
