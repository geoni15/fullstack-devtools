import fs from 'node:fs';
import path from 'node:path';
import type { FileNode, TreeStats } from '@bdt/protocol';
import { isIgnoredName, LIMITS } from '../config';

export interface BuiltTree {
  tree: FileNode;
  stats: TreeStats;
}

function compareEntries(a: fs.Dirent, b: fs.Dirent): number {
  const aIsDir = a.isDirectory();
  const bIsDir = b.isDirectory();
  if (aIsDir !== bIsDir) {
    return aIsDir ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function buildFileTree(rootReal: string, rootName: string): BuiltTree {
  const stats: TreeStats = { files: 0, dirs: 0, truncated: false };
  let countedEntries = 0;

  const walk = (absoluteDir: string, relativeDir: string, depth: number): FileNode[] => {
    if (depth > LIMITS.maxTreeDepth) {
      stats.truncated = true;
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return [];
    }

    entries.sort(compareEntries);
    const children: FileNode[] = [];

    for (const entry of entries) {
      if (countedEntries >= LIMITS.maxTreeEntries) {
        stats.truncated = true;
        break;
      }
      if (isIgnoredName(entry.name) || entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = path.join(absoluteDir, entry.name);

      if (entry.isDirectory()) {
        countedEntries += 1;
        stats.dirs += 1;
        children.push({
          name: entry.name,
          path: relativePath,
          kind: 'dir',
          children: walk(absolutePath, relativePath, depth + 1),
        });
      } else if (entry.isFile()) {
        countedEntries += 1;
        stats.files += 1;
        children.push({ name: entry.name, path: relativePath, kind: 'file' });
      }
    }

    return children;
  };

  return {
    tree: {
      name: rootName,
      path: '',
      kind: 'dir',
      children: walk(rootReal, '', 1),
    },
    stats,
  };
}
