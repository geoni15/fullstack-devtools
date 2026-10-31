import type { Node } from 'web-tree-sitter';
import { decodeStringLiteral, type StaticSqlSite } from './types';

const DIRECT_METHODS = new Set([
  'query',
  'execute',
  'exec',
  'executemany',
  'raw',
  'unsafe',
  'prepare',
  '$queryraw',
  '$executeraw',
]);

const CONDITIONAL_METHODS = new Set([
  'all',
  'get',
  'run',
  'one',
  'many',
  'any',
  'none',
  'scalar',
  'fetchall',
  'fetchone',
  'fetchval',
  'fetchrow',
]);

const DB_OBJECTS = new Set([
  'db',
  'database',
  'pool',
  'client',
  'conn',
  'connection',
  'sql',
  'knex',
  'mysql',
  'mysql2',
  'pg',
  'prisma',
  'sequelize',
  'session',
  'cursor',
  'repository',
  'repo',
]);

interface CalleeInfo {
  objectName: string | null;
  method: string | null;
}

function isWithinRange(node: Node, startLine: number, endLine: number): boolean {
  const line = node.startPosition.row + 1;
  return line >= startLine && line <= endLine;
}

function calleeInfo(callee: Node): CalleeInfo {
  if (callee.type === 'member_expression') {
    const objectNode = callee.childForFieldName('object');
    const propertyNode = callee.childForFieldName('property');
    const objectName = objectNode?.text.split('.').pop() ?? null;
    return {
      objectName,
      method: propertyNode?.text ?? callee.text.split('.').pop() ?? null,
    };
  }
  if (callee.type === 'identifier') {
    return { objectName: null, method: callee.text };
  }
  return { objectName: null, method: null };
}

function isSqlCallee(info: CalleeInfo, tagged: boolean): boolean {
  const method = info.method?.toLowerCase() ?? null;
  if (method === null) {
    return false;
  }
  if (DIRECT_METHODS.has(method)) {
    return true;
  }
  if (tagged && method === 'sql') {
    return true;
  }
  if (CONDITIONAL_METHODS.has(method)) {
    const objectName = info.objectName?.toLowerCase() ?? '';
    return DB_OBJECTS.has(objectName);
  }
  return false;
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createSiteId(filePath: string, line: number, column: number, sql: string | null): string {
  return `${filePath}:${String(line)}:${String(column)}:${hashText(sql ?? 'dynamic')}`;
}

interface ArgumentValue {
  sql: string | null;
  dynamic: boolean;
  note: string | null;
}

function literalArgument(node: Node | null): ArgumentValue {
  if (node === null) {
    return { sql: null, dynamic: true, note: 'Sin argumento SQL visible.' };
  }
  if (node.type === 'string') {
    const decoded = decodeStringLiteral(node.text);
    if (decoded !== null) {
      return { sql: decoded, dynamic: false, note: null };
    }
    return {
      sql: null,
      dynamic: true,
      note: 'SQL dinámico: el texto se construye al ejecutarse y no se captura.',
    };
  }
  if (node.type === 'template_string') {
    const substitutions = node.descendantsOfType('template_substitution');
    const decoded = decodeStringLiteral(node.text);
    if (substitutions.length === 0 && decoded !== null) {
      return { sql: decoded, dynamic: false, note: null };
    }
    return {
      sql: null,
      dynamic: true,
      note: 'SQL dinámico: la plantilla interpola valores y el texto no se captura.',
    };
  }
  return {
    sql: null,
    dynamic: true,
    note: 'SQL dinámico: el texto se construye al ejecutarse y no se captura.',
  };
}

function firstCallArgument(call: Node): Node | null {
  const argumentsNode = call.childForFieldName('arguments');
  if (argumentsNode === null) {
    return null;
  }
  if (argumentsNode.type === 'template_string') {
    return argumentsNode;
  }
  return argumentsNode.namedChildren[0] ?? null;
}

function pythonArgument(node: Node): ArgumentValue {
  if (node.type !== 'string') {
    return {
      sql: null,
      dynamic: true,
      note: 'SQL dinámico: el texto se construye al ejecutarse y no se captura.',
    };
  }
  const prefixMatch = /^([A-Za-z]*)(['"])/.exec(node.text);
  const prefix = (prefixMatch?.[1] ?? '').toLowerCase();
  if (prefix.includes('f')) {
    return {
      sql: null,
      dynamic: true,
      note: 'SQL dinámico: la cadena interpola valores y el texto no se captura.',
    };
  }
  const decoded = decodeStringLiteral(node.text.slice(prefix.length));
  if (decoded !== null) {
    return { sql: decoded, dynamic: false, note: null };
  }
  return {
    sql: null,
    dynamic: true,
    note: 'SQL dinámico: el texto se construye al ejecutarse y no se captura.',
  };
}

export function extractJavaScriptSqlSites(
  root: Node,
  filePath: string,
  startLine: number,
  endLine: number,
): StaticSqlSite[] {
  const sites: StaticSqlSite[] = [];
  const seen = new Set<string>();
  for (const call of root.descendantsOfType('call_expression')) {
    if (!isWithinRange(call, startLine, endLine)) {
      continue;
    }
    const callee = call.childForFieldName('function');
    if (callee === null) {
      continue;
    }
    const info = calleeInfo(callee);
    const tagged = call.childForFieldName('arguments')?.type === 'template_string';
    if (!isSqlCallee(info, tagged)) {
      continue;
    }
    const firstArgument = firstCallArgument(call);
    if (firstArgument === null) {
      continue;
    }
    const argument = literalArgument(firstArgument);
    const line = call.startPosition.row + 1;
    const column = call.startPosition.column + 1;
    const key = `${String(line)}:${String(column)}:${argument.sql ?? 'dynamic'}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sites.push({
      id: createSiteId(filePath, line, column, argument.sql),
      line,
      column,
      method: info.method,
      objectName: info.objectName,
      sql: argument.sql,
      dynamic: argument.dynamic,
      note: argument.note,
    });
  }
  return sites.sort((left, right) => left.line - right.line || left.column - right.column);
}

export function extractPythonSqlSites(
  root: Node,
  filePath: string,
  startLine: number,
  endLine: number,
): StaticSqlSite[] {
  const sites: StaticSqlSite[] = [];
  const seen = new Set<string>();
  for (const call of root.descendantsOfType('call')) {
    if (!isWithinRange(call, startLine, endLine)) {
      continue;
    }
    const callee = call.childForFieldName('function');
    if (callee?.type !== 'attribute') {
      continue;
    }
    const parts = callee.text.split('.');
    const method = parts[parts.length - 1] ?? null;
    const objectName = parts.length > 1 ? (parts[parts.length - 2] ?? null) : null;
    if (!isSqlCallee({ objectName, method }, false)) {
      continue;
    }
    const args = call.namedChildren.find((child) => child.type === 'argument_list') ?? null;
    const first = args?.namedChildren[0] ?? null;
    if (first === null) {
      continue;
    }
    const argument = pythonArgument(first);
    const line = call.startPosition.row + 1;
    const column = call.startPosition.column + 1;
    const key = `${String(line)}:${String(column)}:${argument.sql ?? 'dynamic'}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sites.push({
      id: createSiteId(filePath, line, column, argument.sql),
      line,
      column,
      method,
      objectName,
      sql: argument.sql,
      dynamic: argument.dynamic,
      note: argument.note,
    });
  }
  return sites.sort((left, right) => left.line - right.line || left.column - right.column);
}
