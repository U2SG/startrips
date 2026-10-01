import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyze,
  formatReport,
  parseCss,
  parseRuntimeDefinitions,
  sanitizeCss,
} from "./css-token-guard.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function css(filePath, source) {
  return { filePath, kind: "css", source };
}

function moduleFile(filePath, source) {
  return { filePath, kind: "module", source };
}

function names(entries) {
  return entries.map((entry) => entry.name);
}

test("comments and strings do not read as declarations, and lines survive", () => {
  const source = [
    ".a {",
    "  /* color: var(--commented); --commented-token: red; */",
    '  content: "var(--quoted) --quoted-token: red";',
    "  color: var(--real);",
    "}",
  ].join("\n");

  const sanitized = sanitizeCss(source);
  assert.equal(sanitized.split("\n").length, source.split("\n").length);
  assert.ok(!sanitized.includes("commented"));
  assert.ok(!sanitized.includes("quoted"));

  const parsed = parseCss(source);
  assert.deepEqual(names(parsed.references), ["--real"]);
  assert.equal(parsed.references[0].line, 4);
  assert.deepEqual(parsed.definitions, []);
});

test("a comment opener inside a string is not a comment", () => {
  const source = '.a::after { content: "/* not a comment */ var(--inside)"; color: var(--real); }';
  const parsed = parseCss(source);
  assert.deepEqual(names(parsed.references), ["--real"]);
});

test("a comment terminator inside a string is not a comment", () => {
  const source = '.a::after { content: "ends */ here"; color: var(--real); }';
  const parsed = parseCss(source);
  assert.deepEqual(names(parsed.references), ["--real"]);
});

test("a reference nested in a fallback is a reference too", () => {
  const source = ".a { color: var(--outer, var(--inner)); }";
  const parsed = parseCss(source);
  assert.deepEqual(names(parsed.references), ["--outer", "--inner"]);
  // Only the outer reference carries a fallback; the nested one is the last resort.
  assert.deepEqual(
    parsed.references.map((reference) => reference.hasFallback),
    [true, false],
  );
});

test("only a reference with a fallback is marked as having one", () => {
  const source = ".a { color: var(--plain); border-color: var(--fallback, red); }";
  const parsed = parseCss(source);
  assert.deepEqual(
    parsed.references.map((reference) => [reference.name, reference.hasFallback]),
    [
      ["--plain", false],
      ["--fallback", true],
    ],
  );
});

test("a definition counts wherever it lives, not only in :root", () => {
  const source = [
    ":root { --shared: #fff; }",
    ".living-atlas { --atlas-acid: #c8ff3d; }",
    "@media (min-width: 980px) { .card { --card-edge: 1px; } }",
    ".a { color: var(--shared); border-color: var(--atlas-acid); outline-color: var(--card-edge); }",
  ].join("\n");

  const parsed = parseCss(source);
  assert.deepEqual(names(parsed.definitions).sort(), ["--atlas-acid", "--card-edge", "--shared"]);
  assert.deepEqual(analyze([css("tokens.css", source)]).violations, []);
});

test("selector and at-rule prelude text is not a declaration", () => {
  const source = '@media (--prelude-token: 1) { .a { color: var(--real); } }\n.x--selector-token: 2 { }';
  const parsed = parseCss(source);
  assert.deepEqual(names(parsed.definitions), []);
  assert.deepEqual(names(parsed.references), ["--real"]);
});

test("a reference in a computed value is still a reference", () => {
  const source = ".a { z-index: calc(3 - var(--stack-depth, 0)); opacity: calc(1 - var(--p) * 0.18); }";
  assert.deepEqual(names(parseCss(source).references), ["--stack-depth", "--p"]);
});

test("CRLF sources report the same line numbers as LF sources", () => {
  const parsed = parseCss(".a {\r\n  color: var(--missing);\r\n}\r\n");
  assert.equal(parsed.references[0].line, 2);
  assert.equal(parsed.references[0].name, "--missing");
});

test("runtime definitions are recognised through setProperty, style keys and helper arguments", () => {
  const setProperty = 'element.style.setProperty("--stack-depth", "1");';
  const styleKey = 'const style = { "--page-offset": offset } as CSSProperties;';
  const helperArgument = 'applyTemporalProgress(entry.group, "--journey-temporal-progress", 1);';
  const module = [setProperty, styleKey, helperArgument].join("\n");
  assert.deepEqual(
    [...parseRuntimeDefinitions(module)].sort(),
    ["--journey-temporal-progress", "--page-offset", "--stack-depth"],
  );
});

test("a module that never touches setProperty does not claim bare names", () => {
  assert.deepEqual([...parseRuntimeDefinitions('const label = "--not-a-token";')], []);
});

test("a reference with a definition in a module is resolved", () => {
  const result = analyze([
    css("a.css", ".a { color: var(--stack-depth, 0); }"),
    moduleFile("b.tsx", 'el.style.setProperty("--stack-depth", "2");'),
  ]);
  assert.deepEqual(result.violations, []);
});

test("an undefined reference is reported with its file, line, property and selector", () => {
  const source = [
    ".panel { color: #fff; }",
    ".panel button.living-atlas__notice-undo {",
    "  padding: 0 13px;",
    "  color: var(--atlas-accent);",
    "}",
  ].join("\n");

  const result = analyze([css("src/styles/living-atlas.css", source)]);
  assert.equal(result.violations.length, 1);
  const [violation] = result.violations;
  assert.equal(violation.name, "--atlas-accent");
  assert.equal(violation.filePath, "src/styles/living-atlas.css");
  assert.equal(violation.line, 4);
  assert.equal(violation.property, "color");
  assert.equal(violation.selector, ".panel button.living-atlas__notice-undo");

  const report = formatReport(result);
  assert.match(report, /src\/styles\/living-atlas\.css:4 {2}var\(--atlas-accent\)/);
  assert.match(report, /Undefined var\(\) references \(1\)/);
});

test("a fallback-only reference is reported without failing", () => {
  const result = analyze([css("a.css", ".a { opacity: var(--temporal-progress, 1); }")]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(names(result.fallbackOnly), ["--temporal-progress"]);
  assert.match(formatReport(result), /Resolved only by a var\(\) fallback \(1\)/);
});

// Review P2 #1. `.auth-card--login-v3::after` sits at depth 1 inside a media
// block, so brace depth alone let its `--login-v3:` fragment register as a
// property. A `var(--login-v3)` would then pass the guard while the browser
// still discarded it — a false negative in the one direction that matters.
test("a selector inside a media block is not a custom-property definition", () => {
  const source = [
    "@media (min-width: 800px) {",
    "  .auth-card--login-v3::after {",
    "    content: \"\";",
    "  }",
    "}",
    "",
    ":root { --real: 1; }",
  ].join("\n");

  assert.deepEqual(names(parseCss(source).definitions), ["--real"]);

  const result = analyze([css("auth-gate.css", `${source}\n.a { color: var(--login-v3); }`)]);
  assert.deepEqual(
    result.violations.map((violation) => violation.name),
    ["--login-v3"],
  );
});

// Review P2 #2. `LivingAtlasApp.test.ts` asserts that nothing calls
// `style.setProperty("--journey-route-scale"`. Reading that quoted name as a
// runtime definition would let a real undefined reference inherit the very
// token whose absence the test proves.
test("test modules do not supply runtime definitions", async () => {
  const { isTestModule } = await import("./css-token-guard.mjs");
  assert.equal(isTestModule("src/journey/LivingAtlasApp.test.ts"), true);
  assert.equal(isTestModule("scripts/css-token-guard.node-test.mjs"), true);
  assert.equal(isTestModule("scripts/qa-fragment-observation.node-test.mjs"), true);
  assert.equal(isTestModule("src/journey/LivingAtlasApp.tsx"), false);
  assert.equal(isTestModule("src/scene/StoryMediaPages.tsx"), false);
  // A name is only "provided" where the pattern really runs, but the parser
  // itself still sees the string; the scan is what must skip test modules.
  const source = `expect(other).not.toContain('style.setProperty("--journey-route-scale"');`;
  assert.deepEqual([...parseRuntimeDefinitions(source)], ["--journey-route-scale"]);
});

test("the checked-in stylesheets have no undefined token reference", async () => {
  const { scan } = await import("./css-token-guard.mjs");
  const files = scan(ROOT.replace(/[\\/]$/, ""));
  assert.equal(
    files.some((file) => file.filePath.endsWith(".test.ts")),
    false,
    "test modules must not be scanned as client sources",
  );
  const result = analyze(files);
  assert.ok(result.cssFileCount >= 20, "expected the guard to cover the client stylesheets");
  assert.deepEqual(
    result.violations.map((violation) => `${violation.filePath}:${violation.line} ${violation.name}`),
    [],
  );
});
