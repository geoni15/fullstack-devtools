import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(appDir, '..', '..');

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
};

await build({
  ...commonOptions,
  entryPoints: [path.join(appDir, 'main', 'src', 'main.ts')],
  outfile: path.join(appDir, 'dist', 'main', 'main.js'),
  format: 'esm',
});

await build({
  ...commonOptions,
  entryPoints: [path.join(appDir, 'preload', 'src', 'preload.ts')],
  outfile: path.join(appDir, 'dist', 'preload', 'preload.cjs'),
  format: 'cjs',
});

await build({
  ...commonOptions,
  entryPoints: [path.join(appDir, 'preload', 'src', 'browser-chrome.ts')],
  outfile: path.join(appDir, 'dist', 'preload', 'browser-chrome.cjs'),
  format: 'cjs',
});

await build({
  ...commonOptions,
  entryPoints: [path.join(appDir, 'preload', 'src', 'inspection-panel.ts')],
  outfile: path.join(appDir, 'dist', 'preload', 'inspection-panel.cjs'),
  format: 'cjs',
});

await build({
  ...commonOptions,
  entryPoints: [path.join(appDir, 'preload', 'src', 'unified.ts')],
  outfile: path.join(appDir, 'dist', 'preload', 'unified.cjs'),
  format: 'cjs',
});

const grammarDir = path.join(appDir, 'dist', 'main', 'grammars');
await mkdir(grammarDir, { recursive: true });
const grammarFiles = [
  ['web-tree-sitter', 'tree-sitter.wasm'],
  ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-python', 'tree-sitter-python.wasm'],
];
for (const [packageName, fileName] of grammarFiles) {
  const source =
    packageName === 'web-tree-sitter'
      ? path.join(repoRoot, 'node_modules', packageName, 'web-tree-sitter.wasm')
      : path.join(repoRoot, 'node_modules', packageName, fileName);
  await copyFile(source, path.join(grammarDir, fileName));
}
