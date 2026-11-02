import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeLocation, CodeLocationRequest } from '@bdt/protocol';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function filePathFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') {
    return null;
  }
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

function relativeFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    return null;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  const trimmed = pathname.replace(/^\/+/, '');
  return trimmed === '' ? null : trimmed;
}

export function normalizeCodeLocation(
  root: string | null,
  request: CodeLocationRequest,
): CodeLocation | null {
  if (root === null) {
    return null;
  }
  const raw = request.path.trim();
  if (raw === '') {
    return null;
  }

  let candidate = raw;
  if (URL_SCHEME.test(raw)) {
    const absoluteFromFile = filePathFromUrl(raw);
    if (absoluteFromFile !== null) {
      candidate = absoluteFromFile;
    } else {
      const fromUrl = relativeFromUrl(raw);
      if (fromUrl === null) {
        return null;
      }
      candidate = fromUrl;
    }
  }

  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  try {
    if (!fs.statSync(absolute).isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const endLine = request.endLine ?? null;
  return {
    path: relative.split(path.sep).join('/'),
    line: request.line,
    endLine: endLine !== null && endLine > request.line ? endLine : null,
  };
}
