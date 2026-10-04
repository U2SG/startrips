import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type ResolvedConfig } from "vite";

const apiTarget = process.env.API_DEV_TARGET ?? "http://127.0.0.1:8787";

// Fixtures in public/ that only the dev server, the legacy archive shell and
// browser QA load. They stay in public/ so `pnpm dev` and scripts reading them
// from disk keep working; a production build removes them from its output.
// A QA lane that serves a production build with `vite preview` and needs them
// sets STARTRIPS_KEEP_DEV_STATIC=1.
const developmentOnlyPublicDirs = ["artworks", "demo-media", "qa", "fonts"];

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(resolve(path, entry));
  return total;
}

let resolvedConfig: ResolvedConfig | undefined;

export default defineConfig({
  plugins: [{
    name: "production-public-boundary",
    apply: "build",
    configResolved(config) {
      resolvedConfig = config;
    },
    async closeBundle() {
      if (!resolvedConfig || process.env.STARTRIPS_KEEP_DEV_STATIC === "1") return;
      const outDir = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      let removed = 0;
      for (const name of developmentOnlyPublicDirs) {
        const path = resolve(outDir, name);
        removed += await sizeOf(path);
        await rm(path, { recursive: true, force: true });
      }
      resolvedConfig.logger.info(`production-public-boundary: removed ${removed} bytes (${developmentOnlyPublicDirs.join(", ")})`);
    },
  }, {
    name: "production-entry-boundary",
    apply: "build",
    generateBundle(_options, bundle) {
      const developmentOnly = /\/src\/(?:App\.tsx|data\/archiveRecords\.ts|preview\/[^/]+\.(?:ts|tsx)|reveal\/CoverRevealQaPreview\.tsx|styles\/(?:legacy-shell|archive-shell|artwork-browser|personal-artifact|personal-gallery)\.css)$/;
      const included = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          if (developmentOnly.test(id.replaceAll("\\", "/"))) included.add(id);
        }
      }
      if (included.size > 0) {
        this.error(`Development-only modules entered the production bundle: ${[...included].join(", ")}`);
      }
    },
  }],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
