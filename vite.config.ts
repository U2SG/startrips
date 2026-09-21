import { defineConfig } from "vite";

const apiTarget = process.env.API_DEV_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [{
    name: "production-entry-boundary",
    apply: "build",
    generateBundle(_options, bundle) {
      const developmentOnly = /\/src\/(?:App\.tsx|data\/archiveRecords\.ts|preview\/qaEntry\.tsx|styles\/(?:archive-shell|artwork-browser|personal-artifact|personal-gallery)\.css)$/;
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
