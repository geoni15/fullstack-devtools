import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rendererRoot = fileURLToPath(new URL('./renderer', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/renderer', import.meta.url));

export default defineConfig({
  root: rendererRoot,
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: false,
  },
});
