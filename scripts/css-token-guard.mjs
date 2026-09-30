import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Guard against CSS custom properties that are referenced but never defined.
 *
 * `var(--missing)` is not a build error. The declaration that uses it is simply
 * dropped at computed-value time, so the property silently falls back to the
 * inherited or initial value. That is how `living-atlas.css` shipped
 * `color: var(--atlas-accent)` on the delete-undo control while `--atlas-accent`
 * existed in no stylesheet and no module: the label rendered in the inherited
 * notice colour and nothing complained.
 *
 * The guard therefore collects every custom-property definition and every
 * reference across the CSS the build actually includes, plus the custom
 * properties modules provide at runtime through inline styles or
 * `style.setProperty`, and fails when a reference resolves to nothing.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose tracked sources take part in the client bundle. */
export const SOURCE_ROOTS = ["src", "templates"];

const CSS_EXTENSION = ".css";
const MODULE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** `--name` as CSS defines it: a leading `--` then name code points. */
const CUSTOM_PROPERTY = "--[A-Za-z0-9_-]+";
const DEFINITION_PATTERN = new RegExp(`(${CUSTOM_PROPERTY})[ \\t]*:`, "g");
const REFERENCE_PATTERN = new RegExp(`\\bvar\\([ \\t]*(${CUSTOM_PROPERTY})[ \\t]*([,)])`, "g");
const RUNTIME_DEFINITION_PATTERNS = [
  new RegExp(`\\.setProperty\\([ \\t]*["'\`](${CUSTOM_PROPERTY})["'\`]`, "g"),
  new RegExp(`["'\`](${CUSTOM_PROPERTY})["'\`][ \\t]*:`, "g"),
];
const RUNTIME_CALL_PATTERN = /\.setProperty\(/;
const RUNTIME_LITERAL_PATTERN = new RegExp(`["'\`](${CUSTOM_PROPERTY})["'\`]`, "g");

/**
 * Blank out comment bodies and string bodies while preserving every offset and
 * every newline, so reported line numbers still point at the real source.
 *
 * A `content: "var(--x)"` string, a `url("a--b: c")` string, and a
 * `color: var(--typo)` line that only exists inside a block comment must all
 * fail to read as real CSS values, and a comment opener inside a string must
 * not start a comment. A single left-to-right pass with a string state machine
 * is the simplest thing that gets all of that right.
 */
export function sanitizeCss(source) {
  const out = source.split("");
  const length = source.length;
  let quote = null;
  let index = 0;

  const blank = (position) => {
    if (out[position] !== "\n") out[position] = " ";
  };

  while (index < length) {
    const char = source[index];

    if (quote) {
      if (char === "\\") {
        blank(index);
        if (index + 1 < length) {
          blank(index + 1);
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      if (char === quote) quote = null;
      blank(index);
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      blank(index);
      index += 1;
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      let end = index + 2;
      while (end < length && !(source[end] === "*" && source[end + 1] === "/")) {
        blank(end);
        end += 1;
      }
      if (end < length) {
        blank(end);
        blank(end + 1);
        index = end + 2;
      } else {
        index = length;
      }
      continue;
    }

    index += 1;
  }

  return out.join("");
}

/** Brace depth for every offset, so prelude text can be told apart from values. */
function depthAtEachOffset(text) {
  const depth = new Int16Array(text.length);
  let current = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") current += 1;
    else if (char === "}") current = current > 0 ? current - 1 : 0;
    depth[index] = current;
  }
  return depth;
}

function lineOf(text, index, lineStarts) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function buildLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/**
 * The selector and the property a reference sits in, so a failure report can
 * point at the declaration instead of asking the reader to go and look.
 */
export function ruleContext(text, index) {
  const openBrace = text.lastIndexOf("{", index);
  const closeBrace = text.lastIndexOf("}", index);
  const block = text.slice(Math.max(openBrace, closeBrace) + 1, index);
  const semicolon = block.indexOf(";");
  const declarationStart = semicolon === -1 ? 0 : block.lastIndexOf(";") + 1;
  const property = block.slice(declarationStart).replace(/\s+/g, " ").trim().replace(/:$/, "");
  let selector = "";
  if (openBrace > closeBrace) {
    const head = text.slice(0, openBrace);
    const start = Math.max(head.lastIndexOf("}"), head.lastIndexOf("{"), head.lastIndexOf(";"));
    selector = head.slice(start + 1);
  }
  return {
    selector: clip(selector.replace(/\s+/g, " ").trim()),
    property: clip(property),
  };
}

function clip(text, limit = 110) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/**
 * Every custom-property definition and reference in one stylesheet.
 *
 * Both are restricted to brace depth greater than zero. A `--name:` at depth
 * zero is a selector or an at-rule prelude, not a declaration, and a `var()`
 * outside a block is not a value the cascade would drop.
 */
export function parseCss(source) {
  const text = sanitizeCss(source);
  const depth = depthAtEachOffset(text);
  const lineStarts = buildLineStarts(text);
  const definitions = [];
  const references = [];

  for (const match of text.matchAll(DEFINITION_PATTERN)) {
    const index = match.index;
    if (depth[index] < 1) continue;
    definitions.push({ name: match[1], line: lineOf(text, index, lineStarts) });
  }

  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const index = match.index;
    if (depth[index] < 1) continue;
    references.push({
      name: match[1],
      line: lineOf(text, index, lineStarts),
      hasFallback: match[2] === ",",
      ...ruleContext(text, index),
    });
  }

  return { definitions, references };
}

/**
 * Custom properties a module supplies at runtime, through
 * `element.style.setProperty("--x", ...)` or a `--x` key in a `style` object.
 *
 * These are real definitions: the browser sees them even though no stylesheet
 * declares them. Without this the guard would reject legitimate hooks such as
 * `--stack-depth`, which `StoryMediaPages.tsx` sets per page and
 * `story-media-pages.css` reads with a fallback.
 *
 * A module that calls `setProperty` at all also counts every custom-property
 * name it mentions as a string, because the name is routinely handed to a local
 * helper rather than to `setProperty` directly. `ParticleEarthScene.tsx` passes
 * `--journey-temporal-progress` into an `applyTemporalProgress` closure that
 * calls `setProperty` for it, and nothing in the call site reads like a
 * definition.
 */
export function parseRuntimeDefinitions(source) {
  const names = new Set();
  for (const pattern of RUNTIME_DEFINITION_PATTERNS) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  if (RUNTIME_CALL_PATTERN.test(source)) {
    for (const match of source.matchAll(RUNTIME_LITERAL_PATTERN)) names.add(match[1]);
  }
  return names;
}

/**
 * Resolve a scanned tree into a guard verdict.
 *
 * `sources` is a list of `{ filePath, kind, source }`, where `kind` is `"css"`
 * for a stylesheet and `"module"` for a TypeScript source. Only stylesheets
 * contribute references; both kinds contribute definitions.
 */
export function analyze(sources) {
  const definitions = new Map();
  const runtime = new Map();
  const references = [];

  for (const file of sources) {
    if (file.kind === "css") {
      const parsed = parseCss(file.source);
      for (const definition of parsed.definitions) {
        const sites = definitions.get(definition.name) ?? [];
        sites.push({ filePath: file.filePath, line: definition.line });
        definitions.set(definition.name, sites);
      }
      for (const reference of parsed.references) {
        references.push({ ...reference, filePath: file.filePath });
      }
    } else {
      for (const name of parseRuntimeDefinitions(file.source)) {
        const sites = runtime.get(name) ?? [];
        sites.push(file.filePath);
        runtime.set(name, sites);
      }
    }
  }

  const violations = [];
  const fallbackOnly = [];
  const seen = new Set();
  for (const reference of references) {
    if (definitions.has(reference.name) || runtime.has(reference.name)) continue;
    if (reference.hasFallback) {
      if (!fallbackOnly.some((entry) => entry.name === reference.name)) {
        fallbackOnly.push(reference);
      }
      continue;
    }
    const key = `${reference.filePath}:${reference.line}:${reference.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push(reference);
  }

  violations.sort((a, b) =>
    a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath),
  );

  return {
    violations,
    fallbackOnly,
    definitions,
    runtime,
    referenceCount: references.length,
    cssFileCount: sources.filter((file) => file.kind === "css").length,
    moduleFileCount: sources.filter((file) => file.kind === "module").length,
  };
}

/** Human-readable report. Returns the process exit code the guard should use. */
export function formatReport(result) {
  const lines = [];
  lines.push(
    `Scanned ${result.cssFileCount} stylesheets and ${result.moduleFileCount} module sources.`,
  );
  lines.push(
    `Custom properties: ${result.definitions.size} defined in CSS, ` +
      `${result.runtime.size} provided at runtime, ${result.referenceCount} references.`,
  );

  if (!result.violations.length) {
    lines.push("No undefined var() references.");
  } else {
    lines.push("");
    lines.push(`Undefined var() references (${result.violations.length}):`);
    for (const violation of result.violations) {
      lines.push(
        `  ${violation.filePath}:${violation.line}  var(${violation.name})  ` +
          `in ${violation.property || "<declaration>"}`,
      );
      if (violation.selector) lines.push(`    selector: ${violation.selector}`);
      lines.push(
        "    no stylesheet defines it and no module provides it at runtime, " +
          "so the declaration is dropped at computed-value time",
      );
    }
  }

  if (result.fallbackOnly.length) {
    lines.push("");
    lines.push(`Resolved only by a var() fallback (${result.fallbackOnly.length}):`);
    for (const entry of result.fallbackOnly) {
      lines.push(
        `  ${entry.name}  first seen at ${entry.filePath}:${entry.line}  in ${entry.property}`,
      );
    }
  }

  return lines.join("\n");
}

/** Read the tracked sources the guard covers. */
export function scan(cwd = ROOT) {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", ...SOURCE_ROOTS, `*${CSS_EXTENSION}`],
    { cwd, encoding: "utf8" },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const files = [];
  for (const filePath of tracked) {
    const extension = path.extname(filePath);
    if (extension === CSS_EXTENSION) {
      files.push({ filePath, kind: "css", source: fs.readFileSync(path.join(cwd, filePath), "utf8") });
    } else if (MODULE_EXTENSIONS.has(extension)) {
      files.push({ filePath, kind: "module", source: fs.readFileSync(path.join(cwd, filePath), "utf8") });
    }
  }
  return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function main() {
  const result = analyze(scan());
  console.log(formatReport(result));
  if (result.violations.length) {
    console.error(
      "Define each custom property, or remove the reference. An undefined var() is not a build error:",
    );
    console.error("the declaration is discarded at computed-value time and the property falls back silently.");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

export { ROOT };
