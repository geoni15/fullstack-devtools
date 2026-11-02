const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const HTML_FILE = /\.(?:html?|xhtml)$/i;

export interface WorkspaceFileIndex {
  resolve(reference: string | null | undefined): string | null;
  page(reference: string | null | undefined): string | null;
}

function normalizePath(value: string): string {
  let result = value.replace(/\\/g, '/').trim();
  result = result.replace(/^\.\/+/, '');
  result = result.replace(/\/+/g, '/');
  while (result.startsWith('/')) result = result.slice(1);
  return result;
}

function pathFromReference(reference: string): string | null {
  const trimmed = reference.trim();
  if (trimmed === '') return null;
  let candidate = trimmed;
  if (!WINDOWS_DRIVE.test(trimmed) && URL_SCHEME.test(trimmed)) {
    try {
      candidate = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  const withoutQuery = candidate.split(/[?#]/, 1)[0] ?? candidate;
  try {
    return normalizePath(decodeURIComponent(withoutQuery));
  } catch {
    return normalizePath(withoutQuery);
  }
}

function shortest(paths: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of paths) {
    if (
      best === null ||
      candidate.length < best.length ||
      (candidate.length === best.length && candidate.localeCompare(best, 'es') < 0)
    ) {
      best = candidate;
    }
  }
  return best;
}

function tailMatches(candidate: string, path: string): boolean {
  const left = candidate.toLowerCase();
  const right = path.toLowerCase();
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export function createWorkspaceFileIndex(files: readonly string[]): WorkspaceFileIndex {
  const paths = [...new Set(files.map(normalizePath).filter((path) => path !== ''))];
  const byPath = new Map(paths.map((path) => [path.toLowerCase(), path]));
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const list = byName.get(name);
    if (list === undefined) {
      byName.set(name, [path]);
    } else {
      list.push(path);
    }
  }

  const pageCache = new Map<string | null, string | null>();
  const resolveCache = new Map<string, string | null>();

  const defaultPage = (): string | null => {
    if (pageCache.has(null)) return pageCache.get(null) ?? null;
    const rootIndex = byPath.get('index.html') ?? byPath.get('index.htm') ?? null;
    const result = rootIndex ?? shortest(paths.filter((path) => HTML_FILE.test(path)));
    pageCache.set(null, result);
    return result;
  };

  const lookup = (candidate: string): string | null => {
    const normalized = normalizePath(candidate).replace(/\/+$/, '');
    if (normalized === '') return null;
    const exact = byPath.get(normalized.toLowerCase());
    if (exact !== undefined) return exact;

    const hasExtension = /\.[a-z0-9]{1,8}$/i.test(normalized);
    if (!hasExtension) {
      const attempts = [
        `${normalized}.html`,
        `${normalized}.htm`,
        `${normalized}/index.html`,
        `${normalized}/index.htm`,
      ];
      for (const attempt of attempts) {
        const found = byPath.get(attempt.toLowerCase());
        if (found !== undefined) return found;
      }
    }

    const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
    const named = byName.get(name) ?? [];
    const suffixMatches = named.filter((path) => tailMatches(normalized, path));
    if (suffixMatches.length > 0) return shortest(suffixMatches);

    return null;
  };

  const resolve = (reference: string | null | undefined): string | null => {
    if (reference === null || reference === undefined) return null;
    const key = reference.trim();
    if (key === '') return null;
    const cached = resolveCache.get(key);
    if (cached !== undefined) return cached;
    const candidate = pathFromReference(key);
    const result = candidate === null ? null : lookup(candidate);
    resolveCache.set(key, result);
    return result;
  };

  const page = (reference: string | null | undefined): string | null => {
    const key = reference?.trim() ?? '';
    const resolved = key === '' ? null : resolve(key);
    if (resolved !== null && HTML_FILE.test(resolved)) return resolved;
    return defaultPage();
  };

  return { resolve, page };
}
