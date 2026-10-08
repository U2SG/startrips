import { readFile, readdir, stat, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

/**
 * Production first-load bundle measurement.
 *
 * Reads a finished `vite build` output directory and reports, deterministically:
 * every emitted file with raw, gzip (level 9) and brotli (quality 11) bytes; the
 * set of files the production entry loads eagerly (the entry script, its static
 * import closure and every modulepreload/stylesheet in index.html); eager and
 * total byte sums; a work-done count; and every error found on the way.
 *
 * The eager closure is taken from `.vite/manifest.json` when the build ran with
 * `--manifest`, otherwise from static `import`/`from` specifiers in the emitted
 * chunks. index.html is always parsed too, and any difference between the two
 * views is reported as an error, so a broken lever cannot pass silently.
 */

const KIND_BY_EXTENSION = new Map([
  [".js", "js"],
  [".mjs", "js"],
  [".css", "css"],
  [".html", "html"],
  [".woff", "font"],
  [".woff2", "font"],
  [".ttf", "font"],
  [".otf", "font"],
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".webp", "image"],
  [".avif", "image"],
  [".svg", "image"],
  [".gif", "image"],
  [".ico", "image"],
]);

export function kindOf(file) {
  return KIND_BY_EXTENSION.get(extname(file).toLowerCase()) ?? "other";
}

export function compressedSizes(buffer) {
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    }).length,
  };
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function toDistPath(url) {
  if (!url || /^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith("data:")) return null;
  const clean = url.split(/[?#]/)[0];
  return posix.normalize(clean.replace(/^\.?\//, ""));
}

/** Files index.html asks the browser to fetch before or with the entry. */
export function parseIndexHtml(html) {
  const scripts = [];
  const modulepreload = [];
  const stylesheets = [];
  const preloads = [];
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = attributes(match[0].slice(7, -1));
    if (attrs.type === "module" && attrs.src) {
      const path = toDistPath(attrs.src);
      if (path) scripts.push(path);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0].slice(5, -1));
    const path = toDistPath(attrs.href);
    if (!path) continue;
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload")) modulepreload.push(path);
    else if (rel.includes("stylesheet")) stylesheets.push(path);
    else if (rel.includes("preload")) preloads.push(path);
  }
  return { scripts, modulepreload, stylesheets, preloads };
}

/** Static import specifiers of an emitted ES chunk; `import("...")` is dynamic and excluded. */
export function staticImportsOf(code, chunkPath) {
  const imports = new Set();
  for (const match of code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
    const resolved = specifier.startsWith("/")
      ? posix.normalize(specifier.slice(1))
      : posix.normalize(posix.join(posix.dirname(chunkPath), specifier));
    imports.add(resolved);
  }
  return [...imports].sort();
}

/** Entry closure over a Vite manifest: the HTML entry plus its static imports and their CSS. */
export function manifestEagerClosure(manifest) {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
  const htmlEntries = entries.filter(([key]) => key.endsWith(".html"));
  const roots = htmlEntries.length > 0 ? htmlEntries : entries;
  const files = new Set();
  const visited = new Set();
  const stack = roots.map(([key]) => key);
  while (stack.length > 0) {
    const key = stack.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) continue;
    if (chunk.file) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) stack.push(imported);
  }
  return { roots: roots.map(([key]) => key).sort(), files: [...files].sort() };
}

/** Rendered (pre-minify) bytes per package or source file across the given chunks. */
export function aggregateModules(stats, chunkFiles, limit = 40) {
  const totals = new Map();
  let renderedLength = 0;
  for (const file of chunkFiles) {
    for (const module of stats.chunks?.[file] ?? []) {
      totals.set(module.id, (totals.get(module.id) ?? 0) + module.renderedLength);
      renderedLength += module.renderedLength;
    }
  }
  const ranked = [...totals]
    .map(([id, length]) => ({ id, renderedLength: length }))
    .sort((a, b) => b.renderedLength - a.renderedLength || a.id.localeCompare(b.id));
  return { renderedLength, modules: ranked.length, top: ranked.slice(0, limit) };
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).split("\\").join("/"));
  }
  return files.sort();
}

function sum(records) {
  return records.reduce(
    (total, record) => ({
      files: total.files + 1,
      raw: total.raw + record.raw,
      gzip: total.gzip + record.gzip,
      brotli: total.brotli + record.brotli,
    }),
    { files: 0, raw: 0, gzip: 0, brotli: 0 },
  );
}

export async function measureBundle(distDirectory) {
  const dist = resolve(distDirectory);
  const errors = [];
  const info = await stat(dist).catch(() => null);
  if (!info?.isDirectory()) {
    return { schema: 1, dist: distDirectory, errors: [`dist directory not found: ${distDirectory}`], errorCount: 1 };
  }

  const allFiles = (await listFiles(dist)).filter((file) => !file.startsWith(".vite/"));
  const manifestText = await readFile(join(dist, ".vite", "manifest.json"), "utf8").catch(() => null);
  let manifest = null;
  if (manifestText) {
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      errors.push(`manifest is not valid JSON: ${error.message}`);
    }
  }

  const html = await readFile(join(dist, "index.html"), "utf8").catch(() => null);
  if (html === null) errors.push("index.html missing from dist");
  const htmlEntry = html ? parseIndexHtml(html) : { scripts: [], modulepreload: [], stylesheets: [], preloads: [] };
  if (html !== null && htmlEntry.scripts.length === 0) errors.push("index.html has no module entry script");

  const sizes = new Map();
  for (const file of allFiles) {
    const buffer = await readFile(join(dist, file));
    sizes.set(file, compressedSizes(buffer));
  }

  // Static import closure from emitted code: independent of the manifest.
  const codeClosure = new Set();
  const stack = [...htmlEntry.scripts];
  while (stack.length > 0) {
    const file = stack.pop();
    if (codeClosure.has(file)) continue;
    codeClosure.add(file);
    if (!sizes.has(file)) {
      errors.push(`eager file referenced but not emitted: ${file}`);
      continue;
    }
    if (kindOf(file) !== "js") continue;
    const code = await readFile(join(dist, file), "utf8");
    for (const imported of staticImportsOf(code, file)) {
      if (kindOf(imported) === "js") stack.push(imported);
    }
  }

  const htmlEager = new Set([...htmlEntry.scripts, ...htmlEntry.modulepreload, ...htmlEntry.stylesheets]);
  let closureSource = "code";
  let closure = new Set([...codeClosure, ...htmlEntry.stylesheets]);
  let manifestRoots = [];
  if (manifest) {
    const fromManifest = manifestEagerClosure(manifest);
    manifestRoots = fromManifest.roots;
    if (fromManifest.files.length === 0) errors.push("manifest has no entry chunk");
    else {
      closureSource = "manifest";
      closure = new Set(fromManifest.files);
    }
    for (const file of codeClosure) {
      if (!closure.has(file)) errors.push(`static import in emitted code missing from manifest closure: ${file}`);
    }
  }
  for (const file of htmlEager) {
    if (!closure.has(file)) errors.push(`index.html loads a file outside the entry closure: ${file}`);
  }
  for (const file of closure) {
    if (!htmlEager.has(file)) errors.push(`entry closure file not referenced by index.html: ${file}`);
    if (!sizes.has(file)) errors.push(`entry closure file not emitted: ${file}`);
  }

  const manifestByFile = new Map();
  if (manifest) {
    for (const [key, chunk] of Object.entries(manifest)) {
      if (chunk.file) manifestByFile.set(chunk.file, { key, chunk });
    }
  }

  const files = allFiles.map((file) => {
    const entry = manifestByFile.get(file);
    return {
      file,
      kind: kindOf(file),
      eager: closure.has(file),
      ...(entry?.chunk.isEntry ? { isEntry: true } : {}),
      ...(entry?.chunk.isDynamicEntry ? { isDynamicEntry: true } : {}),
      ...(entry?.chunk.src || entry?.chunk.name ? { source: entry.chunk.src ?? entry.chunk.name } : {}),
      ...sizes.get(file),
    };
  });

  const eagerRecords = files.filter((record) => record.eager);
  const byKind = (records, kind) => records.filter((record) => record.kind === kind);
  const kinds = [...new Set(files.map((record) => record.kind))].sort();

  // Optional attribution written by scripts/perf-bundle-build.mjs.
  let eagerModules = null;
  const statsText = await readFile(join(dist, ".vite", "module-stats.json"), "utf8").catch(() => null);
  if (statsText) {
    try {
      eagerModules = aggregateModules(JSON.parse(statsText), byKind(eagerRecords, "js").map((record) => record.file));
    } catch (error) {
      errors.push(`module-stats is not valid JSON: ${error.message}`);
    }
  }

  return {
    schema: 1,
    dist: distDirectory,
    closureSource,
    manifestRoots,
    indexHtml: htmlEntry,
    eager: {
      js: sum(byKind(eagerRecords, "js")),
      css: sum(byKind(eagerRecords, "css")),
      all: sum(eagerRecords),
      files: eagerRecords.map((record) => record.file),
    },
    totals: {
      ...Object.fromEntries(kinds.map((kind) => [kind, sum(byKind(files, kind))])),
      all: sum(files),
    },
    largestJs: byKind(files, "js")
      .slice()
      .sort((a, b) => b.gzip - a.gzip || a.file.localeCompare(b.file))
      .slice(0, 15)
      .map(({ file, eager, gzip, raw, source }) => ({ file, eager, gzip, raw, ...(source ? { source } : {}) })),
    ...(eagerModules ? { eagerModules } : {}),
    measured: { files: files.length, jsChunks: byKind(files, "js").length, eagerFiles: eagerRecords.length },
    files,
    errors,
    errorCount: errors.length,
  };
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function renderSummary(report) {
  if (!report.eager) return `## Bundle measurement\n\nFailed: ${report.errors.join("; ")}\n`;
  const lines = [
    "## Bundle measurement",
    "",
    `Primary metric, eager JS gzip on the production entry: **${report.eager.js.gzip} B (${kib(report.eager.js.gzip)})**`,
    "",
    "| Set | Files | Raw | Gzip | Brotli |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...[
      ["Eager JS", report.eager.js],
      ["Eager CSS", report.eager.css],
      ["Eager all", report.eager.all],
      ["All JS", report.totals.js ?? { files: 0, raw: 0, gzip: 0, brotli: 0 }],
      ["All assets", report.totals.all],
    ].map(([label, value]) => `| ${label} | ${value.files} | ${value.raw} | ${value.gzip} | ${value.brotli} |`),
    "",
    "| Largest JS (gzip) | Eager | Gzip |",
    "| --- | --- | ---: |",
    ...report.largestJs.map((record) => `| \`${record.file}\` ${record.source ? `(${record.source})` : ""} | ${record.eager ? "yes" : "no"} | ${record.gzip} |`),
    "",
    ...(report.eagerModules ? [
      `| Eager module or package (${report.eagerModules.modules} total) | Rendered bytes |`,
      "| --- | ---: |",
      ...report.eagerModules.top.slice(0, 25).map((module) => `| \`${module.id}\` | ${module.renderedLength} |`),
      "",
    ] : []),
    `Measured ${report.measured.files} files (${report.measured.jsChunks} JS chunks, ${report.measured.eagerFiles} eager) via ${report.closureSource}; errors: ${report.errorCount}.`,
    ...report.errors.map((error) => `- ${error}`),
    "",
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { dist: "dist", output: null, summary: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--dist") options.dist = value;
    else if (name === "--output") options.output = value;
    else if (name === "--summary") options.summary = value;
    else throw new Error(`unknown argument: ${name}`);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await measureBundle(options.dist);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(resolve(options.output)), { recursive: true });
    await writeFile(options.output, json);
  } else {
    process.stdout.write(json);
  }
  if (options.summary) await appendFile(options.summary, renderSummary(report));
  if (report.eager) {
    process.stderr.write(`eager JS gzip ${report.eager.js.gzip} B, eager all gzip ${report.eager.all.gzip} B, all assets gzip ${report.totals.all.gzip} B, errors ${report.errorCount}\n`);
  }
  if (report.errorCount > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
