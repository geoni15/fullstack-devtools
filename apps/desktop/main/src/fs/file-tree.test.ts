import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileNode } from '@bdt/protocol';
import { buildFileTree } from './file-tree';

let rootDir = '';
let junctionCreated = false;

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-tree-'));
  fs.mkdirSync(path.join(rootDir, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'b.txt'), 'b', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'src', 'A.ts'), 'a', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'src', 'z.ts'), 'z', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'src', 'nested', 'deep.ts'), 'd', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.git', 'config'), 'x', 'utf8');

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-tree-outside-'));
  fs.writeFileSync(path.join(outside, 'secreto.txt'), 'x', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(rootDir, 'enlace'), 'junction');
    junctionCreated = true;
  } catch {
    junctionCreated = false;
  }
});

afterAll(() => {
  if (rootDir !== '') {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function childNames(node: FileNode): string[] {
  return (node.children ?? []).map((child) => child.name);
}

describe('buildFileTree', () => {
  it('ordena carpetas primero y luego por nombre', () => {
    const { tree } = buildFileTree(rootDir, 'proyecto');
    expect(tree.path).toBe('');
    expect(tree.name).toBe('proyecto');
    const names = childNames(tree);
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('b.txt'));
    expect(names.slice(names.indexOf('b.txt'))).toEqual(['b.txt']);
  });

  it('ignora node_modules y .git', () => {
    const { tree } = buildFileTree(rootDir, 'proyecto');
    const names = childNames(tree);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('usa rutas POSIX y cuenta archivos y carpetas', () => {
    const { tree, stats } = buildFileTree(rootDir, 'proyecto');
    const src = (tree.children ?? []).find((child) => child.name === 'src');
    const nested = (src?.children ?? []).find((child) => child.name === 'nested');
    expect(nested?.children?.[0]?.path).toBe('src/nested/deep.ts');
    expect(stats.files).toBe(4);
    expect(stats.truncated).toBe(false);
  });

  it('no sigue enlaces simbólicos', () => {
    if (!junctionCreated) {
      return;
    }
    const { tree } = buildFileTree(rootDir, 'proyecto');
    expect(childNames(tree)).not.toContain('enlace');
  });

  it('marca truncated al superar la profundidad máxima', () => {
    const deepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-tree-deep-'));
    let cursor = deepRoot;
    for (let level = 0; level < 25; level += 1) {
      cursor = path.join(cursor, `n${level}`);
      fs.mkdirSync(cursor);
    }
    fs.writeFileSync(path.join(cursor, 'f.txt'), 'x', 'utf8');

    const { stats } = buildFileTree(deepRoot, 'deep');
    expect(stats.truncated).toBe(true);

    fs.rmSync(deepRoot, { recursive: true, force: true });
  });
});
