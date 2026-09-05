/**
 * Replace SQL comments, quoted strings, quoted identifiers, and dollar-quoted
 * bodies with spaces while preserving statement separators and line breaks.
 *
 * Regex-only masking can join neighboring SQL literals and accidentally leave
 * words such as INSERT visible. A small scanner also lets the release guard
 * reject unterminated input instead of classifying a partial string as code.
 */
export function maskSqlNonCode(source) {
  let output = "";
  let index = 0;
  let state = "code";
  let blockDepth = 0;
  let dollarTag = "";

  const masked = (value) => (value === "\n" || value === "\r" ? value : " ");

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1] ?? "";

    if (state === "line-comment") {
      output += masked(current);
      index++;
      if (current === "\n") state = "code";
      continue;
    }

    if (state === "block-comment") {
      if (current === "/" && next === "*") {
        output += "  ";
        blockDepth++;
        index += 2;
        continue;
      }
      if (current === "*" && next === "/") {
        output += "  ";
        blockDepth--;
        index += 2;
        if (blockDepth === 0) state = "code";
        continue;
      }
      output += masked(current);
      index++;
      continue;
    }

    if (state === "single-quote") {
      if (current === "'" && next === "'") {
        output += "  ";
        index += 2;
        continue;
      }
      output += masked(current);
      index++;
      if (current === "'") state = "code";
      continue;
    }

    if (state === "double-quote") {
      if (current === '"' && next === '"') {
        output += "  ";
        index += 2;
        continue;
      }
      output += masked(current);
      index++;
      if (current === '"') state = "code";
      continue;
    }

    if (state === "dollar-quote") {
      if (source.startsWith(dollarTag, index)) {
        output += " ".repeat(dollarTag.length);
        index += dollarTag.length;
        state = "code";
        dollarTag = "";
        continue;
      }
      output += masked(current);
      index++;
      continue;
    }

    if (current === "-" && next === "-") {
      output += "  ";
      index += 2;
      state = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      state = "block-comment";
      blockDepth = 1;
      continue;
    }
    if (current === "'") {
      output += " ";
      index++;
      state = "single-quote";
      continue;
    }
    if (current === '"') {
      output += " ";
      index++;
      state = "double-quote";
      continue;
    }
    if (current === "$") {
      const tag = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        output += " ".repeat(tag.length);
        index += tag.length;
        state = "dollar-quote";
        dollarTag = tag;
        continue;
      }
    }

    output += current;
    index++;
  }

  if (state !== "code" && state !== "line-comment") {
    throw new Error(`SQL contains an unterminated ${state}`);
  }
  return output;
}
