import { readFile } from 'node:fs/promises';
import { Language, Parser } from 'web-tree-sitter';
import { extractJavaScriptRoutes } from './javascript';
import { extractPythonRoutes } from './python';
import { isJavaScriptFile, isPythonFile } from './types';
import type { StaticRoute } from './types';

export type { BackendFramework, SourceFile, StaticRoute, StaticSqlSite } from './types';
export { normalizeRoutePath } from './types';
export { matchRoute, routePatternToRegExp } from './match';
export { extractJavaScriptSqlSites, extractPythonSqlSites } from './sql';

export interface RouteParserOptions {
  runtimeWasm: string;
  javascriptWasm: string;
  pythonWasm: string;
}

export interface RouteSource {
  filePath: string;
  source: string;
}

let parser: Parser | null = null;
let javascriptLanguage: Language | null = null;
let pythonLanguage: Language | null = null;
let initPromise: Promise<void> | null = null;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function initRouteParser(options: RouteParserOptions): Promise<void> {
  if (parser !== null) {
    return;
  }
  if (initPromise === null) {
    const pending = (async (): Promise<void> => {
      const [runtime, javascript, python] = await Promise.all([
        readFile(options.runtimeWasm),
        readFile(options.javascriptWasm),
        readFile(options.pythonWasm),
      ]);
      await Parser.init({ wasmBinary: toArrayBuffer(runtime) });
      javascriptLanguage = await Language.load(new Uint8Array(javascript));
      pythonLanguage = await Language.load(new Uint8Array(python));
      parser = new Parser();
    })();
    initPromise = pending;
    try {
      await pending;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  } else {
    await initPromise;
  }
  if (parser === null || javascriptLanguage === null || pythonLanguage === null) {
    throw new Error('El analizador de rutas no se inicializó correctamente.');
  }
}

export function extractRoutesFromSource(source: RouteSource): StaticRoute[] {
  if (parser === null || javascriptLanguage === null || pythonLanguage === null) {
    throw new Error('El analizador de rutas no está inicializado.');
  }
  const isPython = isPythonFile(source.filePath);
  if (!isPython && !isJavaScriptFile(source.filePath)) {
    return [];
  }
  parser.setLanguage(isPython ? pythonLanguage : javascriptLanguage);
  parser.reset();
  const tree = parser.parse(source.source);
  if (tree === null) {
    return [];
  }
  try {
    return isPython
      ? extractPythonRoutes({ filePath: source.filePath, source: source.source, tree })
      : extractJavaScriptRoutes({ filePath: source.filePath, source: source.source, tree });
  } finally {
    tree.delete();
  }
}
