import type { Node, Tree } from 'web-tree-sitter';
import { extractPythonSqlSites } from './sql';
import {
  decodeStringLiteral,
  joinRoutePaths,
  type BackendFramework,
  type SourceFile,
  type StaticRoute,
  type StaticSqlSite,
} from './types';

interface ParsedPythonSource extends SourceFile {
  tree: Tree;
}

const SIMPLE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

function stringNodeValue(node: Node | undefined): string | null {
  if (node === undefined) {
    return null;
  }
  if (node.type === 'string') {
    return decodeStringLiteral(node.text);
  }
  return null;
}

function argumentList(call: Node): Node | null {
  return call.namedChildren.find((child) => child.type === 'argument_list') ?? null;
}

function keywordValue(args: Node | null, name: string): Node | null {
  if (args === null) {
    return null;
  }
  for (const child of args.namedChildren) {
    if (child.type !== 'keyword_argument') {
      continue;
    }
    const key = child.childForFieldName('name');
    if (key?.text === name) {
      return child.childForFieldName('value');
    }
  }
  return null;
}

function methodsFromList(value: Node | null): string[] {
  if (value === null || value.type !== 'list') {
    return [];
  }
  const methods: string[] = [];
  for (const item of value.namedChildren) {
    const text = stringNodeValue(item);
    if (text !== null && text.trim() !== '') {
      methods.push(text.trim().toUpperCase());
    }
  }
  return methods;
}

function collectRouterPrefixes(root: Node): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const assignment of root.descendantsOfType('assignment')) {
    const [left, right] = assignment.namedChildren;
    if (left?.type !== 'identifier' || right?.type !== 'call') {
      continue;
    }
    const callee = right.childForFieldName('function');
    if (callee?.text !== 'APIRouter' && callee?.text !== 'Blueprint') {
      continue;
    }
    const prefix = keywordValue(argumentList(right), 'prefix');
    const value = stringNodeValue(prefix ?? undefined);
    if (value !== null) {
      prefixes.set(left.text, value);
    }
  }
  return prefixes;
}

function decoratorCallee(decorator: Node): Node | null {
  const call = decorator.namedChildren[0];
  if (call?.type !== 'call') {
    return null;
  }
  return call;
}

function decoratorRoutePaths(
  call: Node,
): Array<{ method: string; path: string; framework: BackendFramework }> {
  const callee = call.childForFieldName('function');
  if (callee?.type !== 'attribute') {
    return [];
  }
  const attribute = callee.text.split('.').pop() ?? '';
  const args = argumentList(call);
  const path = stringNodeValue(args?.namedChildren[0]);
  if (path === null) {
    return [];
  }
  if (SIMPLE_METHODS.has(attribute)) {
    return [{ method: attribute.toUpperCase(), path, framework: 'fastapi' }];
  }
  if (attribute === 'route' || attribute === 'api_route') {
    const methods = methodsFromList(keywordValue(args, 'methods'));
    const resolvedMethods = methods.length > 0 ? methods : ['GET'];
    return resolvedMethods.map((method) => ({
      method,
      path,
      framework: attribute === 'route' ? 'flask' : 'fastapi',
    }));
  }
  return [];
}

export function extractPythonRoutes(input: ParsedPythonSource): StaticRoute[] {
  const root = input.tree.rootNode;
  const prefixes = collectRouterPrefixes(root);
  const routes: StaticRoute[] = [];
  const seen = new Set<string>();
  const sqlCache = new Map<string, StaticSqlSite[]>();
  const sqlSitesFor = (definition: Node): StaticSqlSite[] => {
    const line = definition.startPosition.row + 1;
    const endLine = definition.endPosition.row + 1;
    const key = `${String(line)}:${String(endLine)}`;
    const cached = sqlCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const sites = extractPythonSqlSites(root, input.filePath, line, endLine);
    sqlCache.set(key, sites);
    return sites;
  };

  for (const decorated of root.descendantsOfType('decorated_definition')) {
    const definition = decorated.namedChildren.find(
      (child) => child.type === 'function_definition',
    );
    if (definition === undefined) {
      continue;
    }
    const functionName = definition.childForFieldName('name')?.text ?? null;
    for (const decorator of decorated.namedChildren) {
      if (decorator.type !== 'decorator') {
        continue;
      }
      const call = decoratorCallee(decorator);
      if (call === null) {
        continue;
      }
      const callee = call.childForFieldName('function');
      const objectName =
        callee?.type === 'attribute'
          ? (callee.childForFieldName('object')?.text ??
            callee.text.split('.').slice(0, -1).join('.'))
          : null;
      const prefix = objectName !== null ? (prefixes.get(objectName) ?? '') : '';
      for (const extracted of decoratorRoutePaths(call)) {
        const routePath = joinRoutePaths(prefix, extracted.path);
        const key = `${extracted.method} ${routePath} ${functionName ?? ''}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        routes.push({
          method: extracted.method,
          path: routePath,
          handlerName: functionName,
          file: input.filePath,
          line: definition.startPosition.row + 1,
          endLine: definition.endPosition.row + 1,
          routeLine: call.startPosition.row + 1,
          framework: extracted.framework,
          resolved: true,
          note: null,
          sqlSites: sqlSitesFor(definition),
        });
      }
    }
  }

  return routes;
}
