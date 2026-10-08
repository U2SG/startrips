import process from "node:process";
import { build } from "vite";

/**
 * Production build for bundle measurement: the normal `vite build` (vite.config.ts
 * is loaded as usual) plus a manifest and `.vite/module-stats.json`, Rollup's
 * rendered (post tree-shaking, pre-minify) length of every module in every
 * chunk. scripts/measure-bundle.mjs attributes eager bytes with it.
 */

export function packageOf(id) {
  const path = id.replaceAll("\\", "/").replace(/^\0/, "");
  const nodeModules = path.lastIndexOf("/node_modules/");
  if (nodeModules >= 0) {
    const rest = path.slice(nodeModules + "/node_modules/".length).split("/");
    return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  const source = path.indexOf("/src/");
  if (source >= 0) return path.slice(source + 1).split("?")[0];
  return path.split("?")[0];
}

function moduleStats() {
  return {
    name: "perf-bundle-module-stats",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunks[output.fileName] = Object.entries(output.modules)
          .map(([id, module]) => ({ id: packageOf(id), renderedLength: module.renderedLength }))
          .filter((module) => module.renderedLength > 0)
          .sort((a, b) => b.renderedLength - a.renderedLength || a.id.localeCompare(b.id));
      }
      this.emitFile({
        type: "asset",
        fileName: ".vite/module-stats.json",
        source: `${JSON.stringify({ schema: 1, chunks }, null, 2)}\n`,
      });
    },
  };
}

await build({
  build: { manifest: true },
  plugins: [moduleStats()],
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
