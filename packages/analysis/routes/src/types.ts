export type BackendFramework = 'express' | 'fastify' | 'fastapi' | 'flask';

export interface StaticSqlSite {
  id: string;
  line: number;
  column: number;
  method: string | null;
  objectName: string | null;
  sql: string | null;
  dynamic: boolean;
  note: string | null;
}

export interface StaticRoute {
  method: string;
  path: string;
  handlerName: string | null;
  file: string;
  line: number;
  endLine: number;
  routeLine: number;
  framework: BackendFramework;
  resolved: boolean;
  note: string | null;
  sqlSites: StaticSqlSite[];
}

export interface SourceFile {
  filePath: string;
  source: string;
}

export function normalizeRoutePath(value: string): string {
  let path = value.trim();
  if (path === '') {
    return '/';
  }
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  if (path.length > 1) {
    path = path.replace(/\/+$/, '');
  }
  return path;
}

export function joinRoutePaths(prefix: string, path: string): string {
  const base = normalizeRoutePath(prefix);
  const rest = normalizeRoutePath(path);
  if (base === '/') {
    return rest;
  }
  return normalizeRoutePath(`${base}${rest === '/' ? '' : rest}`);
}

export function decodeStringLiteral(text: string): string | null {
  const quote = text[0];
  if ((quote !== "'" && quote !== '"' && quote !== '`') || text.length < 2) {
    return null;
  }
  const inner = text.slice(1, -1);
  if (quote === '`' && inner.includes('${')) {
    return null;
  }
  if (quote === '"') {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return inner;
    }
  }
  return inner.replace(/\\(['"\\`])/g, '$1');
}

export function isPythonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.py');
}

export function isJavaScriptFile(filePath: string): boolean {
  return /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i.test(filePath);
}
