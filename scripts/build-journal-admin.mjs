import { createRequire } from 'node:module';
// Reuse the pinned bundler already supplied by Vite; no download or install.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
await build({ entryPoints: ['server/admin/journal-import-cli.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external', outfile: process.argv[2] ?? 'artifacts/journal-import.mjs' });
