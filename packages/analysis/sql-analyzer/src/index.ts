import sqlParser from 'node-sql-parser';

const { Parser } = sqlParser;

export type SqlDialect = 'mysql' | 'postgresql' | 'sqlite';

export type SqlOperation = 'select' | 'insert' | 'update' | 'delete' | 'replace' | 'other';

export type SqlColumnUsage =
  'select' | 'insert' | 'set' | 'where' | 'join' | 'group' | 'order' | 'returning';

export interface SqlColumnRef {
  table: string | null;
  name: string;
  usage: SqlColumnUsage;
}

export interface SqlAnalysis {
  operation: SqlOperation;
  tablesRead: string[];
  tablesWritten: string[];
  columns: SqlColumnRef[];
  parse: 'ast' | 'fallback';
  dialect: SqlDialect | null;
  selectStar: boolean;
  note: string | null;
}

interface DialectOption {
  dialect: SqlDialect;
  option: string;
}

interface TableInfo {
  table: string;
  alias: string | null;
}

interface AnalysisState {
  tablesRead: string[];
  tablesWritten: string[];
  columns: SqlColumnRef[];
  aliases: Map<string, string>;
  defaultTable: string | null;
  selectStar: boolean;
}

const DIALECTS: DialectOption[] = [
  { dialect: 'mysql', option: 'MySQL' },
  { dialect: 'postgresql', option: 'PostgresQL' },
  { dialect: 'sqlite', option: 'SQLite' },
];

const parser = new Parser();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function cleanIdentifier(value: string): string | null {
  let name = value.trim();
  while (name.length >= 2) {
    const first = name[0];
    const last = name[name.length - 1];
    if (
      (first === '`' && last === '`') ||
      (first === '"' && last === '"') ||
      (first === '[' && last === ']')
    ) {
      name = name.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return name === '' ? null : name;
}

function cleanTableName(value: string): string | null {
  const cleaned = cleanIdentifier(value);
  if (cleaned === null) {
    return null;
  }
  const parts = cleaned.split('.');
  const table = parts[parts.length - 1]?.trim() ?? '';
  return table === '' ? null : table;
}

function normalizeColumnName(value: unknown): string | null {
  if (typeof value === 'string') {
    return cleanIdentifier(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.value === 'string') {
    return cleanIdentifier(value.value);
  }
  if (isRecord(value.expr)) {
    return normalizeColumnName(value.expr);
  }
  if (typeof value.column === 'string') {
    return cleanIdentifier(value.column);
  }
  return null;
}

function normalizeTableName(value: unknown): string | null {
  if (typeof value === 'string') {
    return cleanTableName(value);
  }
  if (isRecord(value) && typeof value.table === 'string') {
    return cleanTableName(value.table);
  }
  return null;
}

function dialectOrder(sql: string): DialectOption[] {
  const mysql = DIALECTS[0] as DialectOption;
  const postgresql = DIALECTS[1] as DialectOption;
  const sqlite = DIALECTS[2] as DialectOption;
  if (/\$\d+/.test(sql) || sql.includes('::') || /\bRETURNING\b/i.test(sql)) {
    return [postgresql, mysql, sqlite];
  }
  if (/\bAUTOINCREMENT\b/i.test(sql) || /^\s*PRAGMA\b/i.test(sql)) {
    return [sqlite, mysql, postgresql];
  }
  if (sql.includes('`') || /\bENGINE\s*=/i.test(sql)) {
    return [mysql, postgresql, sqlite];
  }
  return DIALECTS;
}

function detectOperation(sql: string): SqlOperation {
  const match = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(sql);
  switch (match?.[1]?.toUpperCase()) {
    case 'SELECT':
      return 'select';
    case 'INSERT':
      return 'insert';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    case 'REPLACE':
      return 'replace';
    default:
      return 'other';
  }
}

function operationFromType(type: unknown): SqlOperation {
  switch (typeof type === 'string' ? type.toLowerCase() : '') {
    case 'select':
      return 'select';
    case 'insert':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    case 'replace':
      return 'replace';
    default:
      return 'other';
  }
}

function fallbackAnalysis(sql: string): SqlAnalysis {
  const operation = detectOperation(sql);
  const tables = new Set<string>();
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([`"[\w.\]]+)/gi;
  let match: RegExpExecArray | null = pattern.exec(sql);
  while (match !== null) {
    const table = cleanTableName(match[1] ?? '');
    if (table !== null) {
      tables.add(table);
    }
    match = pattern.exec(sql);
  }
  const tableList = [...tables];
  return {
    operation,
    tablesRead: operation === 'select' || operation === 'update' ? tableList : [],
    tablesWritten: operation === 'select' || operation === 'other' ? [] : tableList,
    columns: [],
    parse: 'fallback',
    dialect: null,
    selectStar: /\bSELECT\s+\*/i.test(sql),
    note: 'Análisis aproximado: no se pudo verificar el dialecto; las columnas pueden faltar.',
  };
}

function addUnique(list: string[], value: string): void {
  const lower = value.toLowerCase();
  if (!list.some((item) => item.toLowerCase() === lower)) {
    list.push(value);
  }
}

function addColumn(
  state: AnalysisState,
  table: string | null,
  name: string,
  usage: SqlColumnUsage,
): void {
  if (name === '*') {
    state.selectStar = true;
    return;
  }
  const resolved = table ?? state.defaultTable;
  const normalized = name.toLowerCase();
  const exists = state.columns.some(
    (column) =>
      column.name.toLowerCase() === normalized &&
      (column.table ?? '').toLowerCase() === (resolved ?? '').toLowerCase() &&
      column.usage === usage,
  );
  if (!exists) {
    state.columns.push({ table: resolved, name, usage });
  }
}

function resolveColumnTable(state: AnalysisState, value: unknown): string | null {
  const table = normalizeTableName(value);
  if (table === null) {
    return null;
  }
  return state.aliases.get(table.toLowerCase()) ?? table;
}

function collectColumnRefs(node: unknown, state: AnalysisState, usage: SqlColumnUsage): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectColumnRefs(item, state, usage);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if (node.type === 'column_ref') {
    const name = normalizeColumnName(node.column);
    if (name !== null) {
      addColumn(state, resolveColumnTable(state, node.table), name, usage);
    }
    return;
  }
  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) {
      collectColumnRefs(value, state, usage);
    }
  }
}

function registerTable(
  state: AnalysisState,
  value: unknown,
  usage: 'read' | 'write',
): TableInfo | null {
  const table = normalizeTableName(value);
  if (table === null) {
    return null;
  }
  if (usage === 'read') {
    addUnique(state.tablesRead, table);
  } else {
    addUnique(state.tablesWritten, table);
  }
  const alias = isRecord(value) && typeof value.as === 'string' ? cleanIdentifier(value.as) : null;
  state.aliases.set(table.toLowerCase(), table);
  if (alias !== null) {
    state.aliases.set(alias.toLowerCase(), table);
  }
  return { table, alias };
}

function registerTables(
  state: AnalysisState,
  value: unknown,
  usage: 'read' | 'write',
): TableInfo[] {
  const list = Array.isArray(value) ? value : [value];
  const tables: TableInfo[] = [];
  for (const item of list) {
    if (isRecord(item) && isRecord(item.expr)) {
      continue;
    }
    const registered = registerTable(state, item, usage);
    if (registered !== null) {
      tables.push(registered);
    }
  }
  return tables;
}

function analyzeSelect(ast: Record<string, unknown>, state: AnalysisState): void {
  const tables: TableInfo[] = [];
  for (const from of isRecordArray(ast.from)) {
    const table = registerTable(state, from, 'read');
    if (table !== null) {
      tables.push(table);
    }
  }
  state.defaultTable = tables.length === 1 ? (tables[0]?.table ?? null) : null;
  for (const from of isRecordArray(ast.from)) {
    if (isRecord(from) && typeof from.join === 'string' && from.on !== undefined) {
      collectColumnRefs(from.on, state, 'join');
    }
  }
  for (const column of isRecordArray(ast.columns)) {
    collectColumnRefs(column.expr, state, 'select');
  }
  collectColumnRefs(ast.where, state, 'where');
  collectColumnRefs(ast.having, state, 'where');
  collectColumnRefs(ast.groupby, state, 'group');
  collectColumnRefs(ast.orderby, state, 'order');
}

function analyzeInsert(ast: Record<string, unknown>, state: AnalysisState): void {
  const tables = registerTables(state, ast.table, 'write');
  const table = tables[0]?.table ?? null;
  state.defaultTable = tables.length === 1 ? table : null;
  if (Array.isArray(ast.columns)) {
    for (const column of ast.columns) {
      const name = normalizeColumnName(column);
      if (name !== null) {
        addColumn(state, table, name, 'insert');
      }
    }
  }
  collectColumnRefs(ast.returning, state, 'returning');
}

function analyzeUpdate(ast: Record<string, unknown>, state: AnalysisState): void {
  const tables = registerTables(state, ast.table, 'write');
  for (const table of tables) {
    addUnique(state.tablesRead, table.table);
  }
  state.defaultTable = tables.length === 1 ? (tables[0]?.table ?? null) : null;
  for (const item of isRecordArray(ast.set)) {
    const name = normalizeColumnName(item.column);
    if (name !== null) {
      addColumn(state, resolveColumnTable(state, item.table), name, 'set');
    }
  }
  for (const from of isRecordArray(ast.from)) {
    registerTable(state, from, 'read');
  }
  collectColumnRefs(ast.where, state, 'where');
  collectColumnRefs(ast.orderby, state, 'order');
  collectColumnRefs(ast.returning, state, 'returning');
}

function analyzeDelete(ast: Record<string, unknown>, state: AnalysisState): void {
  const tables = registerTables(state, ast.table ?? ast.from, 'write');
  state.defaultTable = tables.length === 1 ? (tables[0]?.table ?? null) : null;
  collectColumnRefs(ast.where, state, 'where');
  collectColumnRefs(ast.orderby, state, 'order');
}

function analyzeAst(ast: unknown, dialect: SqlDialect): SqlAnalysis {
  const state: AnalysisState = {
    tablesRead: [],
    tablesWritten: [],
    columns: [],
    aliases: new Map(),
    defaultTable: null,
    selectStar: false,
  };
  const record = isRecord(ast) ? ast : {};
  const operation = operationFromType(record.type);
  switch (operation) {
    case 'select':
      analyzeSelect(record, state);
      break;
    case 'insert':
    case 'replace':
      analyzeInsert(record, state);
      break;
    case 'update':
      analyzeUpdate(record, state);
      break;
    case 'delete':
      analyzeDelete(record, state);
      break;
    default:
      break;
  }
  let note: string | null = null;
  if (state.selectStar) {
    note = 'SELECT * requiere el esquema de la base de datos para expandir las columnas.';
  } else if (operation === 'other') {
    note = 'La sentencia no es una operación de datos reconocida (SELECT/INSERT/UPDATE/DELETE).';
  }
  return {
    operation,
    tablesRead: state.tablesRead,
    tablesWritten: state.tablesWritten,
    columns: state.columns,
    parse: 'ast',
    dialect,
    selectStar: state.selectStar,
    note,
  };
}

export function analyzeSql(sql: string): SqlAnalysis[] {
  const text = sql.trim();
  if (text === '') {
    return [];
  }
  let asts: unknown = null;
  let dialect: SqlDialect | null = null;
  for (const candidate of dialectOrder(text)) {
    try {
      asts = parser.astify(text, { database: candidate.option });
      dialect = candidate.dialect;
      break;
    } catch {
      // Se prueba el siguiente dialecto; el fallback cubre el resto.
    }
  }
  if (asts === null || dialect === null) {
    return [fallbackAnalysis(text)];
  }
  const statements = Array.isArray(asts) ? asts : [asts];
  if (statements.length === 0) {
    return [fallbackAnalysis(text)];
  }
  return statements.map((statement) => analyzeAst(statement, dialect));
}
