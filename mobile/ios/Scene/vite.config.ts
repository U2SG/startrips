import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = resolve(root, "../../..");
const output = resolve(root, "../Resources/Scene");
export default defineConfig({
  root, base: "/", publicDir: false,
  build: { outDir: output, emptyOutDir: true },
  plugins: [{
    name: "bundled-production-scene-resources",
    async closeBundle() {
      // Actual production inputs; no demo images, QA entry or login bundle.
      for (const name of ["earth", "fonts", "brand"]) {
        await mkdir(output, { recursive: true });
        await cp(resolve(repository, "public", name), resolve(output, name), { recursive: true });
      }
    },
    generateBundle(_options, bundle) {
      for (const entry of Object.values(bundle)) {
        if (entry.type !== "chunk") continue;
        for (const id of Object.keys(entry.modules)) {
          if (/\/src\/(auth|preview)\//.test(id.replaceAll("\\", "/"))) this.error(`Sensitive or QA module in scene: ${id}`);
        }
      }
    },
  }],
});
