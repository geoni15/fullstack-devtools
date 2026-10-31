import path from 'node:path';

export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}
