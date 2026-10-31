import type { Node, Tree } from 'web-tree-sitter';
import { extractJavaScriptSqlSites } from './sql';
import {
  decodeStringLiteral,
  joinRoutePaths,
  type BackendFramework,
  type SourceFile,
  type StaticRoute,
  type StaticSqlSite,
} from './types';

interface ParsedSource extends SourceFile {
  tree: Tree;
}

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'del',
  'options',
  'head',
  'all',
]);

interface FunctionLocation {
  line: number;
  endLine: number;
}

interface HandlerLocation {
  name: string | null;
  line: number;
  endLine: number;
  resolved: boolean;
  note: string | null;
}

function pathValue(node: Node | null): string | null {
  if (node === null) {
    return null;
  }
  if (node.type === 'string' || node.type === 'template_string') {
    return decodeStringLiteral(node.text);
  }
  return null;
}

function collectFunctions(root: Node): Map<string, FunctionLocation> {
  const functions = new Map<string, FunctionLocation>();
  for (const declaration of root.descendantsOfType('function_declaration')) {
    const name = declaration.childForFieldName('name');
    if (name !== null) {
      functions.set(name.text, {
        line: declaration.startPosition.row + 1,
        endLine: declaration.endPosition.row + 1,
      });
    }
  }
  for (const declaration of root.descendantsOfType('variable_declarator')) {
    const name = declaration.childForFieldName('name');
    const value = declaration.childForFieldName('value');
    if (name?.type !== 'identifier' || value === null) {
      continue;
    }
    if (
      value.type === 'arrow_function' ||
      value.type === 'function_expression' ||
      value.type === 'function'
    ) {
      functions.set(name.text, {
        line: declaration.startPosition.row + 1,
        endLine: value.endPosition.row + 1,
      });
    }
  }
  return functions;
}

function resolveHandler(argument: Node, functions: Map<string, FunctionLocation>): HandlerLocation {
  if (argument.type === 'identifier') {
    const found = functions.get(argument.text);
    if (found !== undefined) {
      return {
        name: argument.text,
        line: found.line,
        endLine: found.endLine,
        resolved: true,
        note: null,
      };
    }
    return {
      name: argument.text,
      line: argument.startPosition.row + 1,
      endLine: argument.endPosition.row + 1,
      resolved: false,
      note: 'El manejador se importa o se define fuera de este archivo; la resolución entre archivos llega con F3.',
    };
  }
  if (
    argument.type === 'arrow_function' ||
    argument.type === 'function_expression' ||
    argument.type === 'function'
  ) {
    return {
      name: null,
      line: argument.startPosition.row + 1,
      endLine: argument.endPosition.row + 1,
      resolved: true,
      note: 'Manejador anónimo definido en la misma línea de la ruta.',
    };
  }
  if (argument.type === 'member_expression') {
    const parts = argument.text.split('.');
    const name = parts[parts.length - 1] ?? null;
    return {
      name,
      line: argument.startPosition.row + 1,
      endLine: argument.endPosition.row + 1,
      resolved: false,
      note: 'El manejador es un método de objeto; su definición no se resolvió.',
    };
  }
  return {
    name: null,
    line: argument.startPosition.row + 1,
    endLine: argument.endPosition.row + 1,
    resolved: false,
    note: `Manejador no reconocido (${argument.type}).`,
  };
}

function lastHandlerArgument(argumentsNode: Node): Node | null {
  const candidates = argumentsNode.namedChildren.filter(
    (child) => child.type !== 'string' && child.type !== 'template_string',
  );
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    if (
      candidate.type === 'identifier' ||
      candidate.type === 'arrow_function' ||
      candidate.type === 'function_expression' ||
      candidate.type === 'member_expression'
    ) {
      return candidate;
    }
  }
  return null;
}

function calleeParts(callee: Node): { objectName: string | null; method: string | null } {
  if (callee.type !== 'member_expression') {
    return { objectName: null, method: null };
  }
  const objectNode = callee.childForFieldName('object');
  const propertyNode = callee.childForFieldName('property');
  const objectName = objectNode?.type === 'identifier' ? objectNode.text : null;
  const method =
    propertyNode?.type === 'property_identifier'
      ? propertyNode.text
      : (callee.text.split('.').pop() ?? null);
  return { objectName, method };
}

export function extractJavaScriptRoutes(input: ParsedSource): StaticRoute[] {
  const tree = input.tree;
  const root = tree.rootNode;
  const framework: BackendFramework = input.source.toLowerCase().includes('fastify')
    ? 'fastify'
    : 'express';
  const functions = collectFunctions(root);
  const prefixes = new Map<string, string>();

  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    if (callee === null) {
      continue;
    }
    const { objectName, method } = calleeParts(callee);
    if (objectName === null || method === null || method !== 'use') {
      continue;
    }
    const argumentsNode = call.childForFieldName('arguments');
    if (argumentsNode === null) {
      continue;
    }
    const values = argumentsNode.namedChildren;
    const prefix = pathValue(values[0] ?? null);
    const router = values[values.length - 1];
    if (prefix !== null && router?.type === 'identifier' && router.text !== objectName) {
      prefixes.set(router.text, prefix);
    }
  }

  const routes: StaticRoute[] = [];
  const seen = new Set<string>();
  const sqlCache = new Map<string, StaticSqlSite[]>();
  const sqlSitesFor = (handler: HandlerLocation): StaticSqlSite[] => {
    if (!handler.resolved) {
      return [];
    }
    const key = `${String(handler.line)}:${String(handler.endLine)}`;
    const cached = sqlCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const sites = extractJavaScriptSqlSites(root, input.filePath, handler.line, handler.endLine);
    sqlCache.set(key, sites);
    return sites;
  };

  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    if (callee === null) {
      continue;
    }
    const { objectName, method } = calleeParts(callee);
    if (method === null || !HTTP_METHODS.has(method)) {
      continue;
    }
    const argumentsNode = call.childForFieldName('arguments');
    if (argumentsNode === null) {
      continue;
    }
    const rawPath = pathValue(argumentsNode.namedChildren[0] ?? null);
    if (rawPath === null || rawPath === '') {
      continue;
    }
    const handlerArgument = lastHandlerArgument(argumentsNode);
    if (handlerArgument === null) {
      continue;
    }
    const prefix = objectName !== null ? (prefixes.get(objectName) ?? '') : '';
    const routePath = joinRoutePaths(prefix, rawPath);
    const handler = resolveHandler(handlerArgument, functions);
    const key = `${method.toUpperCase()} ${routePath} ${handler.name ?? ''} ${handler.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    routes.push({
      method: method === 'del' ? 'DELETE' : method.toUpperCase(),
      path: routePath,
      handlerName: handler.name,
      file: input.filePath,
      line: handler.line,
      endLine: handler.endLine,
      routeLine: call.startPosition.row + 1,
      framework,
      resolved: handler.resolved,
      note: handler.note,
      sqlSites: sqlSitesFor(handler),
    });
  }

  return routes;
}
