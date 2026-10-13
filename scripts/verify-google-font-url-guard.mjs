// Offline loader regression fixtures only. No environment files, requests or installs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

assert.equal(process.argv.length, 2);
const installed = createRequire(import.meta.url);
assert.equal(installed("next/package.json").version, "16.3.8", "Review the patch for a new Next version");
const source = readFileSync(installed.resolve("next/dist/compiled/@next/font/dist/google/loader.js"), "utf8").replaceAll("\r\n", "\n");
const hash = text => createHash("sha256").update(text).digest("hex");
assert.equal(hash(source), "289ec117ffc83fd880aefea0a36fc6bec66f64f1f79df65a5204c16a6c9f85f3", "Reviewed Google font compatibility patch missing or changed");
const upstream = source.replace(/\/\/ Alpha compatibility patch:[\s\S]*?(?=const nextFontGoogleFontLoader =)/, "")
  .replace("const ext = getGoogleFontFileExtension(googleFontFileUrl, fontFileBuffer);", "const ext = /\\.(woff|woff2|eot|ttf|otf)$/.exec(googleFontFileUrl)[1];");
assert.equal(hash(upstream), "45e38a6da7efde1a8f53c29619af2eb8f202d352119dbc91c7714db07db385f4", "Changes outside reviewed extension selection");

let checks = 0;
const check = callback => { callback(); checks++; };
class NextFontError extends Error {}
function harness(url, buffer, text = source, options = {}) {
  const metrics = { cssFetches: 0, fontFetches: 0, emissions: [], logged: 0 };
  const css = `@font-face { font-family: 'Offline Font'; src: url(${url}) }\nbody { --unused: true }`;
  const modules = {
    "next/dist/build/output/log": { error() { metrics.logged++; } },
    "./validate-google-font-function-call": { validateGoogleFontFunctionCall: () => ({
      fontFamily: "Offline Font", weights: ["400"], styles: ["normal"], display: "swap",
      preload: options.preload ?? true, fallback: ["Arial"], adjustFontFallback: options.adjust ?? true,
      variable: "--font-offline", subsets: ["latin"],
    }) },
    "./get-font-axes": { getFontAxes: () => ({}) },
    "./get-google-fonts-url": { getGoogleFontsUrl: () => "https://fonts.googleapis.com/css2?family=Offline+Font" },
    "../next-font-error": { nextFontError(message) { throw new NextFontError(message); } },
    "./find-font-files-in-css": { findFontFilesInCss: (_css, subsets) => [{ googleFontFileUrl: url, preloadFontFile: !!subsets }] },
    "./get-fallback-font-override-metrics": { getFallbackFontOverrideMetrics: () => ({ fallbackFont: "Arial", ascentOverride: 90, descentOverride: 10, lineGapOverride: 0, sizeAdjust: 100 }) },
    "./fetch-css-from-google-fonts": { async fetchCSSFromGoogleFonts() { metrics.cssFetches++; return css; } },
    "./fetch-font-file": { async fetchFontFile(fullUrl) { check(() => assert.equal(fullUrl, url)); metrics.fontFetches++; return buffer; } },
  };
  const exports = {};
  vm.runInNewContext(text, { exports, Buffer, Map, console: { error() {} }, require(name) {
    assert(Object.hasOwn(modules, name), "Unexpected loader dependency"); return modules[name];
  } }, { timeout: 1000, filename: "offline-google-font-loader.js" });
  return { metrics, async run() {
    return exports.default({ functionName: "Offline_Font", data: [{}], isDev: options.dev ?? false, isServer: true,
      emitFontFile(...args) { metrics.emissions.push(args); return "/_next/static/media/offline." + args[1]; } });
  } };
}
// Headers are minimum format/bounds fixtures, never real product fonts.
function font(kind) {
  if (kind === "woff") {
    const b = Buffer.alloc(68); b.write("wOFF"); b.writeUInt32BE(b.length, 8); b.writeUInt16BE(1, 12);
    b.writeUInt32BE(64, 48); b.writeUInt32BE(4, 52); b.writeUInt32BE(4, 56); return b;
  }
  if (kind === "woff2") {
    const b = Buffer.alloc(52); b.write("wOF2"); b.writeUInt32BE(b.length, 8); b.writeUInt16BE(1, 12);
    b.writeUInt32BE(28, 16); b.writeUInt32BE(2, 20); return b;
  }
  const b = Buffer.alloc(32); b.writeUInt32BE(kind === "otf" ? 0x4f54544f : 0x00010000, 0);
  b.writeUInt16BE(1, 4); b.writeUInt32BE(28, 20); b.writeUInt32BE(4, 24); return b;
}
const extensionless = "https://fonts.gstatic.com/l/font?kit=offline&skey=fixture&v=1";
const baseline = harness(extensionless, font("woff2"), upstream);
await assert.rejects(baseline.run(), error => error.name === "TypeError" && /null/.test(error.message)); checks++;
check(() => assert.equal(baseline.metrics.emissions.length, 0));

for (const kind of ["woff", "woff2", "ttf", "otf", "eot"]) {
  for (const suffix of ["", "?version=1", "#fragment", "?version=1#fragment"]) {
    const h = harness(`https://fonts.gstatic.com/s/offline/font.${kind}${suffix}`, Buffer.from("unchanged legacy suffix handling"));
    const result = await h.run();
    check(() => assert.equal(h.metrics.emissions[0][1], kind));
    check(() => assert(result.css.includes("/_next/static/media/offline." + kind)));
  }
}
for (const kind of ["woff", "woff2", "ttf", "otf"]) {
  for (const url of [extensionless, "https://fonts.gstatic.com/l/font?kit=value.woff2", "https://fonts.gstatic.com/l/font#fragment.ttf"]) {
    const b = font(kind); const h = harness(url, b); const result = await h.run();
    check(() => assert.equal(h.metrics.emissions[0][1], kind));
    check(() => assert.equal(h.metrics.emissions[0][0], b));
    check(() => assert(!result.css.includes(url)));
    check(() => assert(!result.css.includes("body {")));
  }
}
const bad = [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(2), Buffer.alloc(3), Buffer.from("wOFF"), Buffer.from("wOF2"),
  Buffer.from("OTTO"), Buffer.from([0, 1, 0, 0]), Buffer.from("<html>error</html>"), Buffer.from('{"error":true}'),
  Buffer.from("ttcf"), Buffer.alloc(32), Buffer.from("EOT unsupported")];
for (const kind of ["woff", "woff2", "ttf", "otf"]) {
  const b = font(kind); bad.push(b.subarray(0, b.length - 1));
  const noTables = Buffer.from(b); noTables.writeUInt16BE(0, kind.startsWith("woff") ? 12 : 4); bad.push(noTables);
  if (kind.startsWith("woff")) {
    const length = Buffer.from(b); length.writeUInt32BE(b.length + 1, 8); bad.push(length);
    const reserved = Buffer.from(b); reserved.writeUInt16BE(1, 14); bad.push(reserved);
  }
  if (kind === "woff2") {
    const empty = Buffer.from(b); empty.writeUInt32BE(0, 20); bad.push(empty);
    const tooLarge = Buffer.from(b); tooLarge.writeUInt32BE(5, 20); bad.push(tooLarge);
    const missingDirectory = Buffer.alloc(49); missingDirectory.write("wOF2"); missingDirectory.writeUInt32BE(49, 8);
    missingDirectory.writeUInt16BE(1, 12); missingDirectory.writeUInt32BE(28, 16); missingDirectory.writeUInt32BE(1, 20); bad.push(missingDirectory);
    const tinySfnt = Buffer.from(b); tinySfnt.writeUInt32BE(27, 16); bad.push(tinySfnt);
  } else {
    const offset = Buffer.from(b); offset.writeUInt32BE(0xffffffff, kind === "woff" ? 48 : 20); bad.push(offset);
    const length = Buffer.from(b); length.writeUInt32BE(0xffffffff, kind === "woff" ? 52 : 24); bad.push(length);
    const insideDirectory = Buffer.from(b); insideDirectory.writeUInt32BE(0, kind === "woff" ? 48 : 20); bad.push(insideDirectory);
    const empty = Buffer.from(b); empty.writeUInt32BE(0, kind === "woff" ? 52 : 24); bad.push(empty);
  }
}
for (const b of bad) {
  const h = harness(extensionless, b);
  await assert.rejects(h.run(), error => error instanceof NextFontError && /Unsupported or truncated/.test(error.message)); checks++;
  check(() => assert.equal(h.metrics.emissions.length, 0));
}
for (const preload of [false, true]) for (const adjust of [false, true]) {
  const b = font("woff2"); const h = harness(extensionless, b, source, { preload, adjust });
  const first = await h.run(); const second = await h.run();
  check(() => assert.deepEqual(h.metrics.emissions[0], [b, "woff2", preload, adjust]));
  check(() => assert.deepEqual(h.metrics.emissions[1], h.metrics.emissions[0]));
  check(() => assert.equal(first.css, second.css));
  check(() => assert.equal(h.metrics.cssFetches, 1));
  check(() => assert.equal(h.metrics.fontFetches, 1));
  await h.run();
  check(() => assert.equal(h.metrics.cssFetches, 2));
  check(() => assert.equal(h.metrics.fontFetches, 2));
}
const dev = harness(extensionless, Buffer.from("<html>bad</html>"), source, { dev: true });
const fallback = await dev.run();
check(() => assert(fallback.css.includes("Offline Font Fallback")));
check(() => assert.equal(dev.metrics.emissions.length, 0));
check(() => assert.equal(dev.metrics.logged, 1));
console.log(JSON.stringify({ status: "PASS", assertions: checks, upstreamRegressionReproduced: true,
  malformedFallbacksRejected: bad.length, networkCalls: 0, environmentFilesRead: 0,
  scope: "format identification and basic bounds, not full font validation" }));
