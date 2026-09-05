// Render the actual Digest module entirely offline. In-memory issue fixtures
// never reach a database or provider. Only visual wrapper helpers are mocked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { Issue, Reference } from "../lib/types";

const source = readFileSync(new URL("../components/Digest.tsx", import.meta.url), "utf8");
const exports: { Digest?: (props: { issue: Issue }) => ReactNode } = {};
let networkAttempts = 0;
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText, {
  exports,
  URL,
  fetch() { networkAttempts++; throw new Error("Network forbidden in render check"); },
  require(name: string) {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "./ScrollFadeIn") return { ScrollFadeIn: ({ children }: { children: ReactNode }) => children };
    if (name === "./Wordmark") return { Wordmark: () => "Alpha" };
    if (name === "@/lib/cadence") return { SEND_HOUR_UTC: 14 };
    if (name === "@/lib/topics") return {
      topicEmoji: () => "", topicAnchor: () => "fixture-topic", TOPIC_BY_ID: {},
    };
    throw new Error(`Unexpected Digest import: ${name}`);
  },
}, { timeout: 1000 });

function render(primary?: Reference, supplementary: Reference[] = []): string {
  const issue: Issue = {
    id: "offline-issue", volume: 1, number: 1, weekOf: "2026-09-04",
    recipientFirstName: "Reader", recipientCity: "", editorIntro: "Offline render fixture.",
    sections: [{
      topicId: "ai-news", topicLabel: "Fixture", intro: "", items: [{
        kind: "read", headline: "Fixture headline", body: "Fixture text.",
        primaryRef: primary, supplementaryRefs: supplementary,
      }],
    }],
  };
  return renderToStaticMarkup(createElement(exports.Digest!, { issue }));
}

let assertions = 0;
const primary = { label: "Primary source", url: "https://example.org/private-path?token=fixture-sensitive#section" };
const supplementary = { label: "Other source", url: "https://example.net/report?query=fixture-sensitive" };
const html = render(primary, [supplementary]);
const icons = html.match(/<img\b[^>]*>/g) ?? [];
assert.equal(icons.length, 2);
assertions++;
for (const [index, tag] of icons.entries()) {
  assert.match(tag, /referrerPolicy="no-referrer"/i);
  assert.match(tag, /loading="lazy"/);
  assert.match(tag, /decoding="async"/);
  assert.match(tag, /width="14"/);
  assert.match(tag, /height="14"/);
  assert.match(tag, /alt=""/);
  const src = tag.match(/\bsrc="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  const url = new URL(src ?? "");
  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.pathname, "/s2/favicons");
  assert.equal(url.searchParams.get("domain"), index === 0 ? "example.org" : "example.net");
  assert.equal(url.searchParams.get("sz"), "64");
  assert.equal([...url.searchParams.keys()].length, 2);
  assert.doesNotMatch(tag, /fixture-sensitive|private-path|_next\/image|srcset=/);
  assertions += 12;
}
assert.ok(html.includes('href="https://example.org/private-path?token=fixture-sensitive#section"'));
assert.ok(html.includes('href="https://example.net/report?query=fixture-sensitive"'));
assert.match(html, /rel="noopener noreferrer"/);
assertions += 3;
for (const invalid of ["javascript:alert(1)", "data:text/plain,fixture", "not a URL"]) {
  const invalidHtml = render({ label: "Invalid", url: invalid }, [{ label: "Invalid", url: invalid }]);
  assert.doesNotMatch(invalidHtml, /<img\b/);
  assert.doesNotMatch(invalidHtml, /<a\b/);
  assertions += 2;
}
assert.doesNotMatch(render(), /<img\b/);
assert.equal(networkAttempts, 0);
assertions += 2;
console.log(`PASS verify-digest-source-icons (${assertions} assertions, offline actual Digest render)`);
