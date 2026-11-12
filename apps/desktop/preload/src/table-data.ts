import {
  type FlowEdge,
  type FlowNode,
  type FlowSnapshot,
  type InspectionSqlColumn,
  type InspectionSqlResult,
} from '@bdt/protocol';

export const TABLE_HEAD = 48;
export const TABLE_NOTE = 16;
export const TABLE_MIN_W = 360;
export const GRID_GUTTER = 28;
export const GRID_ROW = 20;
export const GRID_NAME_LINE = 16;
export const GRID_TAG_LINE = 12;
export const GRID_HEAD_PAD = 5;
export const GRID_MIN_COL = 96;
export const GRID_MAX_COL = 210;
export const GRID_CELL_PAD = 8;
export const GRID_CHAR = 6.2;
export const GRID_SAMPLE_CHARS = 28;

const READ_USAGES = new Set(['select', 'returning']);
const CONDITION_USAGES = new Set(['where', 'join', 'group', 'order']);
const WRITE_USAGES = new Set(['insert', 'set']);
const USAGE_ORDER = ['select', 'returning', 'insert', 'set', 'where', 'join', 'group', 'order'];
const USAGE_LABEL: Record<string, string> = {
  select: 'SELECT',
  returning: 'RETURNING',
  insert: 'INSERT',
  set: 'SET',
  where: 'WHERE',
  join: 'JOIN',
  group: 'GROUP',
  order: 'ORDER',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  other: 'OTRA',
  resultado: 'RESULTADO',
};

export interface AttachedColumn {
  tableId: string;
  key: string;
  name: string;
  usage: string;
}

export interface TableColumnData {
  key: string;
  name: string;
  tableId: string;
  usages: Set<string>;
  queryIds: Set<string>;
  runtime: boolean;
}

export interface TableQueryData {
  node: FlowNode;
  read: boolean;
  write: boolean;
  runtime: boolean;
  columns: AttachedColumn[];
  functionNode: FlowNode | null;
}

export interface TableSample {
  query: TableQueryData;
  result: InspectionSqlResult;
}

export interface TableGridColumnPlan {
  key: string | null;
  name: string;
  tags: string[];
  width: number;
  x: number;
}

export interface TableGridCellPlan {
  text: string;
  kind: 'value' | 'null' | 'absent';
  tags: string[];
  heat: 'read' | 'write' | 'cond' | null;
}

export interface TableGridRowPlan {
  cells: TableGridCellPlan[];
  query: TableQueryData;
}

export interface TableGridPlan {
  columns: TableGridColumnPlan[];
  rows: TableGridRowPlan[];
  width: number;
  headerHeight: number;
  rowHeight: number;
  height: number;
}

export interface FlowTableData {
  id: string;
  node: FlowNode;
  name: string;
  databaseId: string | null;
  databaseTitle: string | null;
  columns: TableColumnData[];
  selectStar: boolean;
  unknownColumns: boolean;
  queries: TableQueryData[];
  samples: TableSample[];
  read: boolean;
  write: boolean;
  runtime: boolean;
  search: string;
  grid: TableGridPlan;
  notes: string[];
}

export type TableKind = 'all' | 'read' | 'write';

export interface TableIndex {
  byId: Map<string, FlowTableData>;
  of(nodeId: string): FlowTableData | null;
  heightOf(nodeId: string): number | null;
  widthOf(nodeId: string): number | null;
  anchorYOf(tableId: string, queryId: string): number;
  rowQueryOf(tableId: string, rowIndex: number): TableQueryData | null;
}

export function usageText(usage: string): string {
  return USAGE_LABEL[usage] ?? usage.toUpperCase();
}

export function usageTags(column: TableColumnData): string[] {
  const present = [...column.usages];
  return USAGE_ORDER.filter((usage) => present.includes(usage));
}

export function gridUsageClass(usage: string): string {
  if (usage === 'resultado') return 'is-result';
  if (usage === 'update' || usage === 'delete' || usage === 'replace') return 'is-write';
  if (READ_USAGES.has(usage)) return 'is-read';
  if (WRITE_USAGES.has(usage)) return 'is-write';
  if (CONDITION_USAGES.has(usage)) return 'is-cond';
  return 'is-muted';
}

export function tableCellKey(tableId: string, columnName: string, rowIndex: number): string {
  return `${tableId}::${columnName.toLowerCase()}::${String(rowIndex)}`;
}

export function tableColumnCellKeys(table: FlowTableData, columnName: string): string[] {
  return table.grid.rows.map((_row, rowIndex) => tableCellKey(table.id, columnName, rowIndex));
}

export function tableAllCellKeys(table: FlowTableData): string[] {
  const keys: string[] = [];
  for (let rowIndex = 0; rowIndex < table.grid.rows.length; rowIndex += 1) {
    for (const column of table.grid.columns) {
      keys.push(tableCellKey(table.id, column.name, rowIndex));
    }
  }
  return keys;
}

export function tableCellAt(
  table: FlowTableData,
  columnName: string,
  rowIndex: number,
): string | null {
  const row = table.grid.rows[rowIndex];
  if (row === undefined) return null;
  const index = table.grid.columns.findIndex(
    (column) => column.name.toLowerCase() === columnName.toLowerCase(),
  );
  if (index < 0) return null;
  return row.cells[index]?.text ?? null;
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

function queryFunction(
  node: FlowNode,
  incoming: Map<string, FlowEdge[]>,
  nodeById: Map<string, FlowNode>,
): FlowNode | null {
  for (const edge of incoming.get(node.id) ?? []) {
    if (edge.type !== 'QUERIES') continue;
    const source = nodeById.get(edge.from);
    if (source !== undefined && source.type === 'function') return source;
  }
  const seen = new Set<string>([node.id]);
  let frontier = [node.id];
  for (let depth = 0; depth < 3; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of incoming.get(id) ?? []) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        const candidate = nodeById.get(edge.from);
        if (candidate === undefined) continue;
        if (candidate.type === 'function') return candidate;
        next.push(candidate.id);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return null;
}

function columnKey(tableId: string, name: string): string {
  return `${tableId}::${name.toLowerCase()}`;
}

function resolveColumnTable(
  column: InspectionSqlColumn,
  queryTables: Array<{ id: string; read: boolean; write: boolean }>,
): string | null {
  const name = column.table?.toLowerCase() ?? null;
  if (name !== null) {
    const match = queryTables.find(
      (table) => table.id.split(':').slice(1).join(':').toLowerCase() === name,
    );
    if (match !== undefined) return match.id;
  }
  if (queryTables.length === 1) return queryTables[0]?.id ?? null;
  return null;
}

function addUsageToColumn(
  columnsByKey: Map<string, TableColumnData>,
  tableId: string,
  name: string,
  usage: string,
  queryId: string,
  runtime: boolean,
): string {
  const key = columnKey(tableId, name);
  let column = columnsByKey.get(key);
  if (column === undefined) {
    column = {
      key,
      name,
      tableId,
      usages: new Set<string>(),
      queryIds: new Set<string>(),
      runtime: false,
    };
    columnsByKey.set(key, column);
  }
  column.usages.add(usage);
  column.queryIds.add(queryId);
  column.runtime = column.runtime || runtime;
  return key;
}

function cellText(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (value === '') return "''";
  return String(value);
}

function sampleTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function queryColumnUsages(query: TableQueryData, key: string): string[] {
  const present = new Set<string>();
  for (const column of query.columns) {
    if (column.key === key) present.add(column.usage);
  }
  return USAGE_ORDER.filter((usage) => present.has(usage));
}

function operationUsage(query: TableQueryData): string | null {
  const operation = query.node.operation;
  if (operation === null || operation === undefined || operation === 'other') return null;
  return operation;
}

function cellHeat(tags: string[]): 'read' | 'write' | 'cond' | null {
  if (
    tags.some(
      (tag) => WRITE_USAGES.has(tag) || tag === 'update' || tag === 'delete' || tag === 'replace',
    )
  ) {
    return 'write';
  }
  if (tags.some((tag) => READ_USAGES.has(tag))) return 'read';
  if (tags.some((tag) => CONDITION_USAGES.has(tag))) return 'cond';
  return null;
}

function buildTableGrid(table: FlowTableData): TableGridPlan {
  const columns = [...table.columns].sort((left, right) => {
    const leftPriority = [...left.usages].some((usage) => READ_USAGES.has(usage)) ? 0 : 1;
    const rightPriority = [...right.usages].some((usage) => READ_USAGES.has(usage)) ? 0 : 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.name.localeCompare(right.name, 'es');
  });
  const plans: TableGridColumnPlan[] = columns.map((column) => ({
    key: column.key,
    name: column.name,
    tags: usageTags(column),
    width: 0,
    x: 0,
  }));
  const byName = new Map<string, number>();
  plans.forEach((plan, index) => byName.set(plan.name.toLowerCase(), index));
  const longest = plans.map((plan) => plan.name.length);

  const rows: TableGridRowPlan[] = [];
  for (const sample of table.samples) {
    const positions = new Map<string, number>();
    sample.result.columns.forEach((name, index) => positions.set(name.toLowerCase(), index));
    for (const name of sample.result.columns) {
      const lower = name.toLowerCase();
      if (byName.has(lower)) continue;
      byName.set(lower, plans.length);
      plans.push({ key: null, name, tags: ['resultado'], width: 0, x: 0 });
      longest.push(name.length);
    }
    const operation = operationUsage(sample.query);
    const tableHasColumns = sample.query.columns.some((column) => column.tableId === table.id);
    for (const row of sample.result.rows) {
      const cells: TableGridCellPlan[] = plans.map((plan, planIndex) => {
        const position = positions.get(plan.name.toLowerCase());
        if (position === undefined) return { text: '·', kind: 'absent', tags: [], heat: null };
        const value = row[position] ?? null;
        const text = cellText(value).replace(/\s+/g, ' ');
        longest[planIndex] = Math.max(
          longest[planIndex] ?? 0,
          Math.min(GRID_SAMPLE_CHARS, text.length),
        );
        const tags =
          plan.key === null || !tableHasColumns
            ? operation === null
              ? []
              : [operation]
            : queryColumnUsages(sample.query, plan.key);
        return {
          text,
          kind: value === null ? 'null' : 'value',
          tags,
          heat: cellHeat(tags),
        };
      });
      rows.push({ cells, query: sample.query });
    }
  }

  plans.forEach((plan, index) => {
    const measured = (longest[index] ?? plan.name.length) * GRID_CHAR + GRID_CELL_PAD * 2;
    plan.width = Math.min(GRID_MAX_COL, Math.max(GRID_MIN_COL, measured));
  });
  let x = GRID_GUTTER;
  for (const plan of plans) {
    plan.x = x;
    x += plan.width;
  }
  const maxTags = plans.reduce((max, plan) => Math.max(max, plan.tags.length), 0);
  const headerHeight = GRID_NAME_LINE + maxTags * GRID_TAG_LINE + GRID_HEAD_PAD;
  const maxCellTags = rows.reduce(
    (max, row) => Math.max(max, ...row.cells.map((cell) => cell.tags.length)),
    0,
  );
  const rowHeight =
    maxCellTags === 0 ? GRID_ROW : GRID_NAME_LINE + maxCellTags * GRID_TAG_LINE + GRID_HEAD_PAD;
  return {
    columns: plans,
    rows,
    width: plans.length === 0 ? 0 : x,
    headerHeight,
    rowHeight,
    height: plans.length === 0 ? 0 : headerHeight + rows.length * rowHeight,
  };
}

function buildNotes(table: FlowTableData): string[] {
  const notes: string[] = [];
  if (table.selectStar) notes.push('SELECT * · columnas no declaradas');
  else if (table.columns.length === 0 && table.unknownColumns)
    notes.push('columnas no identificadas');
  if (table.columns.length === 0 && notes.length === 0) notes.push('sin columnas declaradas');
  const samples = table.samples;
  if (samples.length > 0) {
    const latest = samples[samples.length - 1];
    const rows = table.grid.rows.length;
    const parts = [`Muestra real · ${String(rows)} ${rows === 1 ? 'fila' : 'filas'}`];
    if (samples.length > 1) parts.push(`${String(samples.length)} ejecuciones`);
    if (samples.some((sample) => sample.result.truncated)) parts.push('truncada');
    if (latest !== undefined) {
      parts.push(latest.result.driver, sampleTime(latest.result.observedAt));
    }
    notes.push(parts.join(' · '));
  } else if (table.grid.columns.length > 0) {
    notes.push('Sin celdas observadas · solo columnas estáticas');
  }
  return notes;
}

export function buildTableIndex(snapshot: FlowSnapshot, kind: TableKind = 'all'): TableIndex {
  const nodeById = new Map<string, FlowNode>();
  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();
  const tableNodeByName = new Map<string, FlowNode>();
  for (const node of snapshot.nodes) {
    nodeById.set(node.id, node);
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
    if (node.type === 'table') tableNodeByName.set(node.title.toLowerCase(), node);
  }
  for (const edge of snapshot.edges) {
    pushToMap(incoming, edge.to, edge);
    pushToMap(outgoing, edge.from, edge);
  }

  const columnsByKey = new Map<string, TableColumnData>();
  const byId = new Map<string, FlowTableData>();

  const ensureTable = (node: FlowNode): FlowTableData => {
    let table = byId.get(node.id);
    if (table === undefined) {
      table = {
        id: node.id,
        node,
        name: node.title,
        databaseId: null,
        databaseTitle: null,
        columns: [],
        selectStar: false,
        unknownColumns: false,
        queries: [],
        samples: [],
        read: false,
        write: false,
        runtime: false,
        search: '',
        grid: {
          columns: [],
          rows: [],
          width: 0,
          headerHeight: 0,
          rowHeight: GRID_ROW,
          height: 0,
        },
        notes: [],
      };
      byId.set(node.id, table);
    }
    return table;
  };

  for (const queryNode of snapshot.nodes) {
    if (queryNode.type !== 'query') continue;
    if (kind === 'read' && (queryNode.tablesRead ?? []).length === 0) continue;
    if (kind === 'write' && (queryNode.tablesWritten ?? []).length === 0) continue;
    const tables = new Map<string, { id: string; read: boolean; write: boolean }>();
    for (const name of queryNode.tablesRead ?? []) {
      const node = tableNodeByName.get(name.toLowerCase());
      if (node === undefined) continue;
      const existing = tables.get(node.id);
      if (existing === undefined) {
        tables.set(node.id, { id: node.id, read: true, write: false });
      } else {
        existing.read = true;
      }
    }
    for (const name of queryNode.tablesWritten ?? []) {
      const node = tableNodeByName.get(name.toLowerCase());
      if (node === undefined) continue;
      const existing = tables.get(node.id);
      if (existing === undefined) {
        tables.set(node.id, { id: node.id, read: false, write: true });
      } else {
        existing.write = true;
      }
    }
    if (tables.size === 0) continue;

    const queryTables = [...tables.values()];
    const runtime = queryNode.evidence.includes('RUNTIME');
    const databaseNode = (outgoing.get(queryNode.id) ?? [])
      .filter((edge) => edge.type === 'USES')
      .map((edge) => nodeById.get(edge.to))
      .find(
        (candidate): candidate is FlowNode =>
          candidate !== undefined && candidate.type === 'database',
      );

    const attached: AttachedColumn[] = [];
    for (const column of queryNode.columns ?? []) {
      const tableId = resolveColumnTable(column, queryTables);
      if (tableId === null) continue;
      attached.push({
        tableId,
        key: columnKey(tableId, column.name),
        name: column.name,
        usage: column.usage,
      });
    }

    const queryData: TableQueryData = {
      node: queryNode,
      read: queryTables.some((table) => table.read),
      write: queryTables.some((table) => table.write),
      runtime,
      columns: attached,
      functionNode: queryFunction(queryNode, incoming, nodeById),
    };

    for (const tableEntry of queryTables) {
      const tableNode = nodeById.get(tableEntry.id);
      if (tableNode === undefined) continue;
      const table = ensureTable(tableNode);
      if (!table.queries.some((query) => query.node.id === queryNode.id)) {
        table.queries.push(queryData);
      }
      table.runtime = table.runtime || runtime;
      table.read = table.read || tableEntry.read;
      table.write = table.write || tableEntry.write;
      if (databaseNode !== undefined) {
        table.databaseTitle =
          databaseNode.subtitle === null || databaseNode.subtitle === ''
            ? databaseNode.title
            : `${databaseNode.title} · ${databaseNode.subtitle}`;
        table.databaseId = databaseNode.id;
      }
      for (const column of attached) {
        if (column.tableId !== table.id) continue;
        const key = addUsageToColumn(
          columnsByKey,
          table.id,
          column.name,
          column.usage,
          queryNode.id,
          runtime,
        );
        if (!table.columns.some((entry) => entry.key === key)) {
          table.columns.push(columnsByKey.get(key) as TableColumnData);
        }
      }
      if (queryNode.selectStar === true) table.selectStar = true;
      if (attached.length === 0 && queryNode.selectStar !== true) table.unknownColumns = true;
    }
  }

  for (const table of byId.values()) {
    const seen = new Set<string>();
    const samples: TableSample[] = [];
    for (const query of table.queries) {
      const result = query.node.result;
      if (result === null || result === undefined || seen.has(query.node.id)) continue;
      seen.add(query.node.id);
      samples.push({ query, result });
    }
    samples.sort((left, right) => left.result.observedAt - right.result.observedAt);
    table.samples = samples;
    table.grid = buildTableGrid(table);
    table.notes = buildNotes(table);
    const parts = [
      table.name,
      table.databaseTitle,
      ...table.columns.map((column) => column.name),
      ...table.columns.flatMap((column) =>
        [...column.usages].map((usage) => USAGE_LABEL[usage] ?? usage),
      ),
      ...table.queries.map((query) => query.node.sql ?? ''),
    ];
    table.search = parts
      .filter((part): part is string => part !== null && part !== '')
      .join(' ')
      .toLowerCase();
  }

  const heightOf = (nodeId: string): number | null => {
    const table = byId.get(nodeId);
    if (table === undefined) return null;
    return (
      TABLE_HEAD +
      table.grid.height +
      table.notes.length * TABLE_NOTE +
      (table.grid.columns.length === 0 ? 8 : 0)
    );
  };
  const widthOf = (nodeId: string): number | null => {
    const table = byId.get(nodeId);
    if (table === undefined) return null;
    return Math.max(TABLE_MIN_W, table.grid.width);
  };

  return {
    byId,
    of: (nodeId) => byId.get(nodeId) ?? null,
    heightOf,
    widthOf,
    anchorYOf: (tableId, queryId) => {
      const table = byId.get(tableId);
      if (table === undefined) return TABLE_HEAD;
      const index = table.grid.rows.findIndex((row) => row.query.node.id === queryId);
      if (index < 0) return TABLE_HEAD + Math.max(8, table.grid.headerHeight) / 2;
      return (
        TABLE_HEAD +
        table.grid.headerHeight +
        index * table.grid.rowHeight +
        table.grid.rowHeight / 2
      );
    },
    rowQueryOf: (tableId, rowIndex) => {
      const table = byId.get(tableId);
      if (table === undefined) return null;
      return table.grid.rows[rowIndex]?.query ?? null;
    },
  };
}
