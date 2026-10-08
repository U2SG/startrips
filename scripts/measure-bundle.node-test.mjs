import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateModules, manifestEagerClosure, measureBundle, parseIndexHtml, staticImportsOf } from "./measure-bundle.mjs";

const html = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-a.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-b.js">
<link rel="stylesheet" crossorigin href="/assets/index-c.css">
<link rel="icon" href="/brand/icon.png">
</head><body><div id="root"></div></body></html>`;

test("parseIndexHtml separates entry, modulepreload and stylesheets", () => {
  assert.deepEqual(parseIndexHtml(html), {
    scripts: ["assets/index-a.js"],
    modulepreload: ["assets/vendor-b.js"],
    stylesheets: ["assets/index-c.css"],
    preloads: [],
  });
});

test("staticImportsOf ignores dynamic import()", () => {
  const code = `import{a as b}from"./vendor-b.js";import"./side-e.js";const l=()=>import("./lazy-d.js");`;
  assert.deepEqual(staticImportsOf(code, "assets/index-a.js"), ["assets/side-e.js", "assets/vendor-b.js"]);
});

test("manifestEagerClosure follows static imports and css, not dynamic imports", () => {
  const manifest = {
    "index.html": { file: "assets/index-a.js", isEntry: true, imports: ["_vendor"], css: ["assets/index-c.css"], dynamicImports: ["src/lazy.tsx"] },
    _vendor: { file: "assets/vendor-b.js" },
    "src/lazy.tsx": { file: "assets/lazy-d.js", isDynamicEntry: true, imports: ["_vendor"] },
  };
  assert.deepEqual(manifestEagerClosure(manifest), {
    roots: ["index.html"],
    files: ["assets/index-a.js", "assets/index-c.css", "assets/vendor-b.js"],
  });
});

test("measureBundle reports eager vs total and agrees across manifest, code and html", async () => {
  const dist = await mkdtemp(join(tmpdir(), "measure-bundle-"));
  try {
    await mkdir(join(dist, "assets"), { recursive: true });
    await mkdir(join(dist, ".vite"), { recursive: true });
    await writeFile(join(dist, "index.html"), html);
    await writeFile(join(dist, "assets", "index-a.js"), `import{v}from"./vendor-b.js";const l=()=>import("./lazy-d.js");console.log(v,l);`);
    await writeFile(join(dist, "assets", "vendor-b.js"), `export const v=${JSON.stringify("x".repeat(400))};`);
    await writeFile(join(dist, "assets", "lazy-d.js"), `import{v}from"./vendor-b.js";export default v;`);
    await writeFile(join(dist, "assets", "index-c.css"), "body{margin:0}");
    await writeFile(join(dist, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "assets/index-a.js", isEntry: true, imports: ["_vendor"], css: ["assets/index-c.css"], dynamicImports: ["src/lazy.tsx"] },
      _vendor: { file: "assets/vendor-b.js" },
      "src/lazy.tsx": { file: "assets/lazy-d.js", isDynamicEntry: true, src: "src/lazy.tsx", imports: ["_vendor"] },
    }));
    const report = await measureBundle(dist);
    assert.equal(report.errorCount, 0, report.errors.join("; "));
    assert.equal(report.closureSource, "manifest");
    assert.deepEqual(report.eager.files, ["assets/index-a.js", "assets/index-c.css", "assets/vendor-b.js"]);
    assert.equal(report.eager.js.files, 2);
    assert.equal(report.totals.js.files, 3);
    assert.equal(report.measured.files, 5);
    assert.ok(report.eager.js.gzip > 0 && report.eager.js.gzip < report.totals.js.gzip);

    // A file index.html preloads but the closure does not reach is an error.
    await writeFile(join(dist, "index.html"), html.replace("</head>", `<link rel="modulepreload" href="/assets/lazy-d.js"></head>`));
    const drift = await measureBundle(dist);
    assert.ok(drift.errors.some((error) => error.includes("assets/lazy-d.js")));
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("aggregateModules sums rendered bytes over the given chunks only", () => {
  const stats = {
    chunks: {
      "assets/index-a.js": [{ id: "three", renderedLength: 30 }, { id: "react-dom", renderedLength: 20 }],
      "assets/vendor-b.js": [{ id: "three", renderedLength: 5 }],
      "assets/lazy-d.js": [{ id: "maplibre-gl", renderedLength: 900 }],
    },
  };
  assert.deepEqual(aggregateModules(stats, ["assets/index-a.js", "assets/vendor-b.js"]), {
    renderedLength: 55,
    modules: 2,
    top: [{ id: "three", renderedLength: 35 }, { id: "react-dom", renderedLength: 20 }],
  });
});

test("measureBundle fails closed on a missing dist", async () => {
  const report = await measureBundle(join(tmpdir(), "measure-bundle-missing-dist-dir"));
  assert.equal(report.errorCount, 1);
});
