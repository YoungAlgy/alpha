// Offline source/assets verification. No framework, browser, environment or network.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const fontsDir = join(root, "public/fonts");
const manifest = JSON.parse(readFileSync(join(fontsDir, "manifest.json"), "utf8"));
const css = readFileSync(join(root, "app/fonts.css"), "utf8");
const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
const preloadSource = readFileSync(join(root, "components/FontPreloads.tsx"), "utf8");
const headers = readFileSync(join(root, "public/_headers"), "utf8").replaceAll("\r\n", "\n");
assert.equal(manifest.version, 1);
assert.deepEqual(manifest.sourceArtifact, {
  id: "music-release-build-20261019",
  artifactSha256: "eadd5b045b1c79454a2a6dcd3aa6e765a601609d057a060a09c3992ec73ba9b2",
});
assert.equal(manifest.fonts.length, 30);
assert.equal(manifest.files.length, 41);
assert.equal(manifest.licenses.length, 10);
const tree = [];
function walk(directory, prefix = "") {
  assert(!lstatSync(directory).isSymbolicLink());
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink());
    const path = prefix + entry.name;
    if (entry.isDirectory()) walk(join(directory, entry.name), path + "/");
    else { assert(entry.isFile()); tree.push(path); }
  }
}
walk(fontsDir);
assert.deepEqual(tree.sort(), [...manifest.files.map(file => file.path), "manifest.json"].sort());
for (const file of manifest.files) {
  assert(/^(?:[a-f0-9]{16}-s(?:\.p)?\.woff2|NOTICES\.txt|licenses\/[A-Za-z0-9-]+\.(?:txt|md))$/.test(file.path));
  const bytes = readFileSync(join(fontsDir, file.path));
  assert.equal(bytes.length, file.bytes);
  assert.equal(sha(bytes), file.sha256);
}
const faceRules = [...css.matchAll(/@font-face\{[^{}]*\}/g)].map(match => match[0]);
assert.equal(faceRules.length, 101);
assert.equal(sha(faceRules.map(face => face.replaceAll("/fonts/", "/_next/static/media/")).join("\n")),
  "d8b9bf97f531f5c942324e43f687d3a5b2d6c48df9578360465c15018a5888c7", "Every original face/weight/range/fallback metric must survive");
assert.deepEqual(faceRules, manifest.faces);
const variables = [...css.matchAll(/(--font-[a-z-]+):([^;{}]+);/g)].map(match => ({ name: match[1], value: match[2] }));
assert.equal(variables.length, 8);
assert.equal(sha(JSON.stringify(variables)), "761fae31fd8eb28dd8677b3d631b5e9b44c016ab836082a3863c05b2b1b5f73f");
assert.deepEqual(variables, manifest.variables);
assert.equal(sha(JSON.stringify(manifest.fonts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path)))),
  "cc9d3e9958ea4adaa76e9b72a5114bd6415bcd02085ca9b1017c5f6c1347ba2d", "Exact original font tree must survive");
assert.equal(manifest.fonts.reduce((total, font) => total + font.bytes, 0), 772524);
const preloads = ["/fonts/e4af272ccee01ff0-s.p.woff2", "/fonts/5611c55482296524-s.p.woff2", "/fonts/597b6a5d799c44de-s.p.woff2"];
assert.deepEqual(manifest.preloads, preloads);
assert.deepEqual([...preloadSource.matchAll(/"(\/fonts\/[^"\n]+\.woff2)"/g)].map(match => match[1]), preloads);
assert(preloadSource.startsWith('"use client";'));
assert(/import \{ preload \} from "react-dom"/.test(preloadSource));
assert(/preload\(href, \{ as: "font", type: "font\/woff2", crossOrigin: "anonymous" \}\)/.test(preloadSource));
assert(/import \{ FontPreloads \} from "@\/components\/FontPreloads"/.test(layout));
assert.equal((layout.match(/<FontPreloads\s*\/>/g) ?? []).length, 1);
assert(!/<link\b[^>]*\brel="preload"/.test(layout + preloadSource), "Literal RSC preload links duplicate SSR resource hints");
assert(layout.indexOf('import "./fonts.css"') < layout.indexOf('import "./globals.css"'));
assert(!/next\/font\/(?:google|local)|\.variable/.test(layout));
// Native React SSR fixture only. No Next/framework build, environment loading,
// server, browser or network. Duplicate component renders must retain 3 hints.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const react = require("react");
const reactDom = require("react-dom");
const { renderToStaticMarkup } = require("react-dom/server");
const compiled = ts.transpileModule(preloadSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} });
const fixtureModule = { exports: {} };
runInNewContext(compiled.outputText, { module: fixtureModule, exports: fixtureModule.exports,
  require: name => { assert.equal(name, "react-dom"); return reactDom; } }, { timeout: 1000 });
const rendered = renderToStaticMarkup(react.createElement("html", null,
  react.createElement("body", null, react.createElement(fixtureModule.exports.FontPreloads), react.createElement(fixtureModule.exports.FontPreloads))));
const renderedHints = [...rendered.matchAll(/<link\b[^>]*>/g)].map(match => match[0]).filter(tag => /\bas="font"/.test(tag));
assert.deepEqual(renderedHints.map(tag => /\bhref="([^"]+)"/.exec(tag)?.[1]).sort(), [...preloads].sort());
for (const tag of renderedHints) assert(/\btype="font\/woff2"/.test(tag) && /\bcrossorigin="(?:anonymous)?"/.test(tag));
assert(!/https?:|fonts\.googleapis|fonts\.gstatic/.test(css));
const referenced = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]))].sort();
assert.deepEqual(referenced, manifest.fonts.map(font => "/fonts/" + font.path).sort());
assert(headers.startsWith("# Content-hash-named static bundles"));
assert(headers.includes("/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable"));
for (const font of manifest.fonts) assert(headers.includes(`/fonts/${font.path}\n  Cache-Control: public, max-age=31536000, immutable`));
assert(!headers.includes("/fonts/*") && !headers.includes("/fonts/manifest.json") && !headers.includes("/fonts/licenses"));
const notices = readFileSync(join(fontsDir, "NOTICES.txt"), "utf8");
for (const font of manifest.fonts) {
  const bytes = readFileSync(join(fontsDir, font.path));
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2");
  assert(notices.includes(font.notices.en));
}
for (const license of manifest.licenses) {
  const text = readFileSync(join(fontsDir, license.path), "utf8");
  assert(/SIL OPEN FONT LICENSE Version 1\.1/.test(text));
  assert(/PERMISSION\s*(?:&|AND)\s*CONDITIONS/.test(text));
  assert(text.includes("DISCLAIMER") && text.includes("TERMINATION"));
  assert(notices.includes(license.url));
  // Source acquisition hash remains as evidence. CRLF->LF in text packaging is
  // harmless and distinct from the byte-identical font binaries.
}
for (const directory of ["app", "components", "lib"]) {
  function scan(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) scan(target);
      else if (/\.(?:[cm]?js|tsx?|mts)$/.test(entry.name)) assert(!/from\s*["']next\/font\/google["']|import\s*\(["']next\/font\/google["']\)/.test(readFileSync(target, "utf8")), "No app-side Google font import");
    }
  }
  scan(join(root, directory));
}
console.log("PASS local fonts: 30 unchanged binaries, 101 exact faces, 8 variables, 3 deduplicated React SSR preloads, 10 complete licenses and exact asset cache scope. Full Next build qualification remains separate.");
