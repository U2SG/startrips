import { defineConfig } from "vite";

const apiTarget = process.env.API_DEV_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
