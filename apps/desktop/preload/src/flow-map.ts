import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  FLOW_INTERACTION_EVENTS,
  handlerLabel,
  handlerProfileTags,
  normalizeSearchText,
  requestStatusView,
  type FlowEdge,
  type FlowElementKind,
  type FlowInteractionEvent,
  type FlowJsonCaptureState,
  type FlowJsonMovement,
  type FlowJsonState,
  type FlowMapState,
  type FlowNode,
  type FlowNodeType,
  type FlowSnapshot,
  type RequestStatusView,
} from '@bdt/protocol';
import {
  FLOW_NODE_COMPACT_HEIGHT,
  FLOW_NODE_HEIGHT,
  layoutFlow,
  type FlowLayout,
  type FlowLayoutMode,
  type FlowPlacedNode,
} from './flow-layout';
import {
  GRID_CELL_PAD,
  GRID_CHAR,
  GRID_GUTTER,
  GRID_NAME_LINE,
  GRID_TAG_LINE,
  TABLE_HEAD,
  TABLE_NOTE,
  buildTableIndex,
  gridUsageClass,
  tableCellAt,
  tableCellKey,
  usageTags,
  usageText,
  type FlowTableData,
  type TableGridColumnPlan,
  type TableIndex,
  type TableQueryData,
} from './table-data';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2.5;
const TEXT_MIN_ZOOM = 0.4;
const PAGE_SIZE = 20;
const CULL_MARGIN = 280;
const BUNDLE_JUNCTION_GAP = 44;
const ORIGIN_SPINE_GAP = 24;
const CORRIDOR_OFFSET: Record<EdgeFlowClass, number> = {
  send: 0,
  gateway: 7,
  server: 14,
  receive: 21,
  neutral: 28,
};
const JSON_RAIL_PREVIEW_CHARS = 480;
const JSON_DETAIL_PREVIEW_CHARS = 1200;
const CARD_WIDTH_MIN = 52;
const CARD_WIDTH_MAX = 440;
const COLUMN_WIDTH_MIN = 44;
const COLUMN_WIDTH_MAX = 720;
const COLUMN_GRIP_WIDTH = 9;
const CARD_TEXT_LEFT = 10;
const CARD_TEXT_RIGHT = 8;
const TITLE_FONT = '600 11px system-ui, "Segoe UI", sans-serif';
const TYPE_FONT = '600 8px system-ui, "Segoe UI", sans-serif';
const SUB_FONT = '10px system-ui, "Segoe UI", sans-serif';
const BADGE_FONT = '600 8px system-ui, "Segoe UI", sans-serif';
const TIME_FONT = '9px "Cascadia Mono", Consolas, monospace';
const TYPE_LETTER_SPACING = 0.8;
const AXIS_FONT = '600 9px system-ui, "Segoe UI", sans-serif';
const AXIS_LETTER_SPACING = 0.9;
const FLASH_MS = 2600;

type TrafficMode = 'all' | 'interacted';
type FocusDirection = 'forward' | 'both';
type EdgeFlowClass = 'send' | 'receive' | 'gateway' | 'server' | 'neutral';

const FLOW_CLASS_LABEL: Record<EdgeFlowClass, string> = {
  send: 'Envío',
  receive: 'Recibo',
  gateway: 'Gateway HTTP',
  server: 'Servidor',
  neutral: 'Estructura',
};

const SEARCH_TYPE_ORDER: Record<FlowNodeType, number> = {
  file: 0,
  structure: 1,
  asset: 2,
  element: 3,
  handler: 4,
  request: 5,
  route: 6,
  function: 7,
  query: 8,
  table: 9,
  database: 10,
};

const TYPE_LABEL: Record<FlowNodeType, string> = {
  file: 'ARCHIVO',
  structure: 'ESTRUCTURA',
  asset: 'RECURSO',
  element: 'ELEMENTO',
  handler: 'HANDLER',
  request: 'PETICIÓN',
  route: 'RUTA',
  function: 'FUNCIÓN',
  query: 'SQL',
  table: 'TABLA',
  database: 'BASE DE DATOS',
};

const KIND_LABEL: Record<FlowElementKind, string> = {
  structure: 'ESTRUCTURA',
  asset: 'RECURSO',
  button: 'BOTÓN',
  link: 'ENLACE',
  input: 'CAMPO',
  select: 'SELECTOR',
  textarea: 'ÁREA DE TEXTO',
  form: 'FORMULARIO',
  details: 'DESPLEGABLE',
  summary: 'RESUMEN',
  contenteditable: 'EDITABLE',
  interactive: 'CONTROL',
  page: 'PÁGINA',
};

const EVENT_LABEL: Record<FlowInteractionEvent, string> = {
  click: 'Clic',
  dblclick: 'Doble clic',
  contextmenu: 'Menú contextual',
  submit: 'Envío',
  input: 'Entrada',
  change: 'Cambio',
  focus: 'Foco',
  blur: 'Pérdida de foco',
  keydown: 'Tecla',
  hover: 'Hover',
  scroll: 'Desplazamiento',
};

const ORIGIN_LABEL: Record<string, string> = {
  backend: 'backend',
  frontend: 'frontend',
  external: 'externa',
};

const OPERATION_LABEL: Record<string, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  other: 'SQL',
};

const PARSE_LABEL: Record<string, string> = {
  ast: 'análisis AST',
  fallback: 'respaldo',
};

const JSON_KIND_LABEL: Record<FlowJsonMovement['kind'], string> = {
  request: 'ENVIADO',
  response: 'DEVUELTO',
  parse: 'LEÍDO',
  stringify: 'SERIALIZADO',
};

interface GraphModel {
  snapshot: FlowSnapshot;
  layout: FlowLayout;
  viewNodes: FlowNode[];
  viewEdges: FlowEdge[];
  nodesById: Map<string, FlowNode>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  neighbors: Map<string, Set<string>>;
  traceElements: FlowNode[];
  runtimeReachable: Set<string>;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  viewX: number;
  viewY: number;
  moved: boolean;
}

interface EdgePlan {
  id: string;
  kind: 'edge' | 'branch' | 'trunk';
  sources: string[];
  to: string;
  edgeIds: string[];
  tooltip: string;
  d: string;
  marker: string;
  startMarker: string;
  className: string;
  flowClass: EdgeFlowClass;
  roundTrip: boolean;
  glyph: '↑' | '↓' | '';
  glyphX: number;
  glyphY: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

interface EdgeView {
  plan: EdgePlan;
  path: SVGPathElement;
  group: SVGGElement;
  glyph: SVGTextElement | null;
}

interface CorridorGroup {
  flowClass: EdgeFlowClass;
  originLayer: number;
  destLayer: number;
  byOrigin: Map<string, Map<string, FlowEdge[]>>;
}

interface SingleEdgeItem {
  edge: FlowEdge;
  source: FlowPlacedNode;
  target: FlowPlacedNode;
  targetNode: FlowNode;
  flowClass: EdgeFlowClass;
}

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface TableCellSelection {
  tableId: string;
  column: string;
  rowIndex: number | null;
}

let initialized = false;
let state: FlowMapState = { open: false, building: false, error: null, snapshot: null };
let model: GraphModel | null = null;
let tableIndex: TableIndex | null = null;
let tableIndexKind: 'all' | 'read' | 'write' = 'all';
let pickedCell: TableCellSelection | null = null;
let flashCells: Set<string> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let kindMode: 'all' | 'read' | 'write' = 'all';
let selectedId: string | null = null;
let selectionHighlight = false;
let highlightScope: Set<string> | null = null;
let currentCardRequests = new Set<string>();
let searchTerm = '';
let trafficMode: TrafficMode = 'interacted';
let layoutMode: FlowLayoutMode = 'chronological';
let compactMode = false;
const columnWidths = new Map<FlowNodeType, number>();
let eventFilter: FlowInteractionEvent | null = null;
let eventOnly = false;
let focusScope: Set<string> | null = null;
let focusOriginId: string | null = null;
let focusDirection: FocusDirection = 'both';
let searchOpen = false;
let searchResults: FlowNode[] = [];
let searchShown = 0;
let traceNodes: FlowNode[] = [];
let traceShown = 0;
let view = { x: 40, y: 40, k: 1 };
let viewReady = false;
let pan: PanState | null = null;
let viewport: SVGGElement | null = null;
let branchLayer: SVGGElement | null = null;
let trunkLayer: SVGGElement | null = null;
let nodeLayer: SVGGElement | null = null;
let cellRouteLayer: SVGGElement | null = null;
let axisEntries: Array<{ el: HTMLElement; x: number | null; width: number | null }> = [];
let axisGrips: Array<{ el: HTMLElement; x: number }> = [];
let columnResize: { type: FlowNodeType; startClientX: number; startWidth: number } | null = null;
let columnFrame = 0;
const AXIS_HEIGHT = 22;
let edgePlans: EdgePlan[] = [];
let planById = new Map<string, EdgePlan>();
let respondedScope = new Set<string>();
let nodeViews = new Map<string, { node: FlowNode; group: SVGGElement }>();
let edgeViews = new Map<string, EdgeView>();
let filterVisibility = new Map<string, boolean>();
let viewportFrame = 0;
let strokeZoom = 0;
let textsHidden = false;
const GRID_CELL = 512;
let planGrid = new Map<string, EdgePlan[]>();
let nodeGrid = new Map<string, FlowPlacedNode[]>();
let resizeObserver: ResizeObserver | null = null;
let traceButtons = new Map<string, HTMLButtonElement>();
let tooltipsPinned = false;
let shiftHeld = false;
let tipKey: string | null = null;
let hoverKey: string | null = null;
let hoverText = '';
let tipPointerX = 0;
let tipPointerY = 0;
let menuNodeId: string | null = null;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Falta el elemento ${id} en el mapa de flujo.`);
  }
  return found as T;
}

function svgById(id: string): SVGSVGElement {
  const found = document.getElementById(id);
  if (!(found instanceof SVGSVGElement)) {
    throw new Error(`Falta el SVG ${id} en el mapa de flujo.`);
  }
  return found;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

function svgText(
  className: string,
  x: number,
  y: number,
  value: string,
  anchor = '',
): SVGTextElement {
  const node = svgElement('text', {
    class: className,
    x: String(x),
    y: String(y),
  });
  if (anchor !== '') node.setAttribute('text-anchor', anchor);
  node.textContent = value;
  return node;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

let measureCanvas: CanvasRenderingContext2D | null = null;

function textWidth(text: string, font: string, letterSpacing = 0): number {
  if (text === '') return 0;
  if (measureCanvas === null) {
    measureCanvas = document.createElement('canvas').getContext('2d');
  }
  if (measureCanvas === null) return text.length * (6 + letterSpacing);
  measureCanvas.font = font;
  const spacing = Math.max(0, text.length - 1) * letterSpacing;
  return measureCanvas.measureText(text).width + spacing;
}

function truncateToWidth(value: string, maxWidth: number, font: string, letterSpacing = 0): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean === '' || maxWidth <= 0) return '';
  if (textWidth(clean, font, letterSpacing) <= maxWidth) return clean;
  let low = 0;
  let high = clean.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(`${clean.slice(0, mid)}…`, font, letterSpacing) <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low <= 0 ? '…' : `${clean.slice(0, low)}…`;
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function revealLocation(
  file: string | null | undefined,
  line: number | null | undefined,
  endLine: number | null | undefined,
): void {
  if (file === null || file === undefined || line === null || line === undefined || line <= 0) {
    return;
  }
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.revealLocation, {
    path: file,
    line,
    endLine: endLine ?? null,
  });
}

function codeLink(
  label: string,
  file: string | null | undefined,
  line: number | null | undefined,
  endLine: number | null | undefined,
): HTMLElement {
  const plain = document.createElement('span');
  plain.textContent = label;
  if (file === null || file === undefined || line === null || line === undefined || line <= 0) {
    return plain;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-link';
  button.textContent = label;
  button.title = 'Abrir en el editor y marcar la función';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealLocation(file, line, endLine);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  return button;
}

function evidenceClass(evidence: readonly string[]): string {
  const runtime = evidence.includes('RUNTIME');
  const staticEvidence = evidence.includes('STATIC');
  if (runtime && staticEvidence) return 'is-both';
  return runtime ? 'is-runtime' : '';
}

function flowClassMarker(flowClass: EdgeFlowClass): string {
  return `url(#flow-arrow-${flowClass})`;
}

function requestResponded(node: FlowNode | undefined): boolean {
  if (node === undefined || node.type !== 'request') return false;
  if (node.outcome === 'finished' || node.outcome === 'failed') return true;
  return node.statusCode !== null && node.statusCode !== undefined;
}

function directionLabel(flowClass: EdgeFlowClass, roundTrip: boolean): string {
  const base = FLOW_CLASS_LABEL[flowClass];
  if (flowClass === 'gateway') {
    return roundTrip
      ? `${base} · solicitud y respuesta observadas`
      : `${base} · solo solicitud observada`;
  }
  if (flowClass === 'server') {
    return roundTrip
      ? `${base} · llamada y respuesta observadas`
      : `${base} · llamada sin respuesta observada`;
  }
  if (flowClass === 'receive') return `${base} · dato que vuelve`;
  if (flowClass === 'send') return `${base} · solicitud o evento`;
  return `${base} · jerarquía o inferencia`;
}

function flowClassFor(edge: FlowEdge, source: FlowNode, target: FlowNode): EdgeFlowClass {
  if (edge.type === 'PROVENANCE' || edge.type === 'RENDERS') return 'receive';
  if (edge.type === 'CONTAINS') return 'neutral';
  if (source.type === 'element' && target.type === 'element') return 'neutral';
  if (target.type === 'request') return 'gateway';
  if (edge.type === 'TRIGGERS' || edge.type === 'NAVIGATES') return 'send';
  if (edge.type === 'SUBMITS') {
    return target.type === 'route' ? 'send' : 'gateway';
  }
  if (edge.type === 'SENDS') return 'gateway';
  return 'server';
}

function edgeRoundTrip(edge: FlowEdge, target: FlowNode, flowClass: EdgeFlowClass): boolean {
  if (flowClass === 'gateway') return requestResponded(target);
  if (flowClass !== 'server') return false;
  if (!edge.evidence.includes('RUNTIME')) return false;
  return respondedScope.has(edge.from);
}

function computeRespondedScope(): Set<string> {
  const reached = new Set<string>();
  if (model === null) return reached;
  const queue: string[] = [];
  for (const node of model.snapshot.nodes) {
    if (node.type !== 'request' || !requestResponded(node)) continue;
    reached.add(node.id);
    queue.push(node.id);
  }
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    for (const next of model.outgoing.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

function nodeTypeLabel(node: FlowNode): string {
  if (node.type === 'element' && node.kind !== null && node.kind !== undefined) {
    return KIND_LABEL[node.kind] ?? TYPE_LABEL.element;
  }
  return TYPE_LABEL[node.type];
}

function eventLabel(event: string): string {
  return (EVENT_LABEL as Record<string, string>)[event] ?? event;
}

function asEvent(value: string): FlowInteractionEvent | null {
  return (FLOW_INTERACTION_EVENTS as readonly string[]).includes(value)
    ? (value as FlowInteractionEvent)
    : null;
}

function eventTotal(node: FlowNode): number {
  let total = 0;
  for (const event of node.events ?? []) total += event.count;
  return total;
}

function nodeCount(node: FlowNode): number {
  if (node.type === 'request') return 0;
  if (node.type === 'element') return Math.max(node.occurrences, eventTotal(node));
  return node.occurrences;
}

function requestStatus(node: FlowNode): RequestStatusView | null {
  if (node.type !== 'request') return null;
  return requestStatusView({
    statusCode: node.statusCode ?? null,
    outcome: node.outcome ?? 'pending',
    backendObserved: node.backendObserved ?? null,
  });
}

function eventSummary(node: FlowNode): string | null {
  const events = node.events ?? [];
  if (events.length === 0) return null;
  return [...events]
    .sort((left, right) => right.count - left.count)
    .map((event) => `${eventLabel(event.event)} ×${String(event.count)}`)
    .join(' · ');
}

function nodeTooltip(node: FlowNode): string {
  const parts = [nodeTypeLabel(node), node.title];
  if (node.subtitle !== null && node.subtitle !== '') parts.push(node.subtitle);
  const table = tableDataOf(node);
  if (table !== null) {
    const ways = [table.read ? 'lecturas' : '', table.write ? 'escrituras' : '']
      .filter((part) => part !== '')
      .join(' y ');
    parts.push(
      `${String(table.columns.length)} columnas · ${String(table.queries.length)} SQL${
        ways === '' ? '' : ` · ${ways}`
      }`,
    );
    if (table.grid.rows.length > 0) {
      parts.push(
        `${String(table.grid.rows.length)} filas observadas · clic en una celda para seguir su recorrido`,
      );
    }
  }
  if (node.file !== null) {
    const line = node.line === null ? '' : `:${String(node.line)}`;
    parts.push(`${node.file}${line}`);
  }
  const status = requestStatus(node);
  if (status !== null) {
    parts.push(`Estado: ${status.phase}`);
    if (status.detail !== status.phase) parts.push(status.detail);
  }
  if (node.countLabel !== null && node.countLabel !== undefined && node.occurrences > 0) {
    parts.push(`${node.countLabel}: ${String(node.occurrences)}`);
  }
  const events = eventSummary(node);
  if (events !== null) parts.push(`Eventos: ${events}`);
  if (node.firstSeen > 0) {
    parts.push(
      node.firstSeen === node.lastSeen
        ? `Visto: ${clock(node.firstSeen)}`
        : `Visto: ${clock(node.firstSeen)} → ${clock(node.lastSeen)}`,
    );
  }
  if (node.note !== null && node.note !== '') parts.push(node.note);
  return parts.join('\n');
}

function edgeTooltip(edge: FlowEdge, flowClass: EdgeFlowClass, roundTrip: boolean): string {
  const parts = [
    directionLabel(flowClass, roundTrip),
    `${edge.type} · ${edge.evidence.join(' + ')} · ${
      edge.correlation === 'direct' ? 'directa' : 'heurística'
    }`,
  ];
  if (edge.occurrences > 1) parts.push(`${String(edge.occurrences)} apariciones`);
  if (edge.lastSeen > 0) parts.push(`Visto: ${clock(edge.lastSeen)}`);
  if (edge.note !== null && edge.note !== '') parts.push(edge.note);
  return parts.join('\n');
}

function isInteractedElement(node: FlowNode): boolean {
  return (
    node.type === 'element' &&
    (eventTotal(node) > 0 || node.traceIds.length > 0 || node.occurrences > 0)
  );
}

function computeRuntimeReachable(snapshot: FlowSnapshot): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const list = outgoing.get(edge.from);
    if (list === undefined) {
      outgoing.set(edge.from, [edge.to]);
    } else {
      list.push(edge.to);
    }
  }
  const reachable = new Set<string>();
  const queue: string[] = [];
  const interactedElements = new Set<string>();
  const fileNodes = new Set(
    snapshot.nodes.filter((node) => node.type === 'file').map((node) => node.id),
  );
  for (const node of snapshot.nodes) {
    if (!node.evidence.includes('RUNTIME')) continue;
    if (node.type === 'element') {
      if (!isInteractedElement(node)) continue;
      interactedElements.add(node.id);
    } else if (node.type === 'handler' && node.traceIds.length === 0) {
      continue;
    }
    reachable.add(node.id);
    queue.push(node.id);
  }
  for (const edge of snapshot.edges) {
    if (edge.type !== 'RENDERS' || !interactedElements.has(edge.to)) continue;
    if (reachable.has(edge.from)) continue;
    reachable.add(edge.from);
    queue.push(edge.from);
  }
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || fileNodes.has(current)) continue;
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return reachable;
}

function nodeHeight(): number {
  return compactMode ? FLOW_NODE_COMPACT_HEIGHT : FLOW_NODE_HEIGHT;
}

function nodeHeightOf(node: FlowNode): number {
  if (node.type === 'table' && tableIndex !== null) {
    const height = tableIndex.heightOf(node.id);
    if (height !== null) return compactMode ? TABLE_HEAD : height;
  }
  return nodeHeight();
}

function tableDataOf(node: FlowNode): FlowTableData | null {
  if (node.type !== 'table' || tableIndex === null) return null;
  return tableIndex.of(node.id);
}

function badgeText(node: FlowNode): string {
  const total = nodeCount(node);
  return total > 0 ? `${String(total)}×` : '';
}

function naturalNodeWidth(node: FlowNode): number {
  if (node.type === 'table' && tableIndex !== null) {
    const width = tableIndex.widthOf(node.id);
    if (width !== null) return Math.round(width);
  }
  const badge = badgeText(node);
  const badgeWidth = badge === '' ? 0 : 8 + textWidth(badge, BADGE_FONT);
  let required: number;
  if (compactMode) {
    required = CARD_TEXT_LEFT + textWidth(node.title, TITLE_FONT) + badgeWidth + CARD_TEXT_RIGHT;
  } else {
    const typeWidth = textWidth(nodeTypeLabel(node), TYPE_FONT, TYPE_LETTER_SPACING);
    const seen = node.firstSeen > 0 ? clock(node.firstSeen) : '';
    const timeWidth = seen === '' ? 0 : 8 + textWidth(seen, TIME_FONT);
    const subtitle = node.subtitle ?? '';
    const subWidth = subtitle === '' ? 0 : textWidth(subtitle, SUB_FONT) + timeWidth;
    required = Math.max(
      CARD_TEXT_LEFT + typeWidth + badgeWidth + CARD_TEXT_RIGHT,
      CARD_TEXT_LEFT + textWidth(node.title, TITLE_FONT) + CARD_TEXT_RIGHT,
      CARD_TEXT_LEFT + subWidth + CARD_TEXT_RIGHT,
    );
  }
  return Math.round(clamp(required, CARD_WIDTH_MIN, CARD_WIDTH_MAX));
}

function nodeWidthOf(node: FlowNode): number {
  if (node.type === 'table') return naturalNodeWidth(node);
  if (layoutMode !== 'hierarchical') {
    const manual = columnWidths.get(node.type);
    if (manual !== undefined) return manual;
  }
  return naturalNodeWidth(node);
}

function layoutOptions(): {
  compact: boolean;
  widthOf: (node: FlowNode) => number;
  heightOf: (node: FlowNode) => number;
} {
  return { compact: compactMode, widthOf: nodeWidthOf, heightOf: nodeHeightOf };
}

function prepare(snapshot: FlowSnapshot): void {
  tableIndex = buildTableIndex(snapshot, kindMode);
  tableIndexKind = kindMode;
  indexJsonOwners(snapshot);
  const layout = layoutFlow(snapshot, layoutMode, layoutOptions());
  const nodesById = new Map<string, FlowNode>();
  for (const node of snapshot.nodes) {
    nodesById.set(node.id, node);
  }
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const neighbors = new Map<string, Set<string>>();
  for (const node of snapshot.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    neighbors.set(node.id, new Set());
  }
  for (const edge of snapshot.edges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }
  const traceElements = snapshot.nodes.filter(isInteractedElement).sort((left, right) => {
    const leftTime = left.firstSeen > 0 ? left.firstSeen : left.lastSeen;
    const rightTime = right.firstSeen > 0 ? right.firstSeen : right.lastSeen;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.title.localeCompare(right.title, 'es') || left.id.localeCompare(right.id);
  });
  model = {
    snapshot,
    layout,
    viewNodes: snapshot.nodes,
    viewEdges: snapshot.edges,
    nodesById,
    outgoing,
    incoming,
    neighbors,
    traceElements,
    runtimeReachable: computeRuntimeReachable(snapshot),
  };
}

function setFlowCardRequests(ids: readonly string[]): void {
  currentCardRequests = new Set(ids);
}

function worldBounds(): WorldBounds | null {
  if (model === null) return null;
  const svg = svgById('map-svg');
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const margin = CULL_MARGIN / Math.max(view.k, 0.0001);
  return {
    minX: -view.x / view.k - margin,
    minY: -view.y / view.k - margin,
    maxX: (rect.width - view.x) / view.k + margin,
    maxY: (rect.height - view.y) / view.k + margin,
  };
}

function nodeInBounds(placed: FlowPlacedNode, bounds: WorldBounds): boolean {
  return (
    placed.x + placed.width >= bounds.minX &&
    placed.x <= bounds.maxX &&
    placed.y + placed.height >= bounds.minY &&
    placed.y <= bounds.maxY
  );
}

function planInBounds(plan: EdgePlan, bounds: WorldBounds): boolean {
  return (
    plan.bbox.maxX >= bounds.minX &&
    plan.bbox.minX <= bounds.maxX &&
    plan.bbox.maxY >= bounds.minY &&
    plan.bbox.minY <= bounds.maxY
  );
}

function scheduleViewportUpdate(): void {
  if (viewportFrame !== 0) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    updateVisibleViews();
  });
}

function gridKey(cx: number, cy: number): string {
  return `${String(cx)}:${String(cy)}`;
}

function buildSpatialGrids(): void {
  planGrid = new Map();
  nodeGrid = new Map();
  if (model === null) return;
  for (const plan of edgePlans) {
    const x0 = Math.floor(plan.bbox.minX / GRID_CELL);
    const x1 = Math.floor(plan.bbox.maxX / GRID_CELL);
    const y0 = Math.floor(plan.bbox.minY / GRID_CELL);
    const y1 = Math.floor(plan.bbox.maxY / GRID_CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = gridKey(cx, cy);
        const list = planGrid.get(key);
        if (list === undefined) planGrid.set(key, [plan]);
        else list.push(plan);
      }
    }
  }
  for (const placed of model.layout.nodes) {
    const x0 = Math.floor(placed.x / GRID_CELL);
    const x1 = Math.floor((placed.x + placed.width) / GRID_CELL);
    const y0 = Math.floor(placed.y / GRID_CELL);
    const y1 = Math.floor((placed.y + placed.height) / GRID_CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = gridKey(cx, cy);
        const list = nodeGrid.get(key);
        if (list === undefined) nodeGrid.set(key, [placed]);
        else list.push(placed);
      }
    }
  }
}

function gridCandidates<T>(grid: Map<string, T[]>, bounds: WorldBounds): T[] {
  const out: T[] = [];
  const x0 = Math.floor(bounds.minX / GRID_CELL);
  const x1 = Math.floor(bounds.maxX / GRID_CELL);
  const y0 = Math.floor(bounds.minY / GRID_CELL);
  const y1 = Math.floor(bounds.maxY / GRID_CELL);
  for (let cx = x0; cx <= x1; cx += 1) {
    for (let cy = y0; cy <= y1; cy += 1) {
      const list = grid.get(gridKey(cx, cy));
      if (list !== undefined) {
        for (const item of list) out.push(item);
      }
    }
  }
  return out;
}

function updateVisibleViews(): void {
  if (model === null || viewport === null) return;
  const bounds = worldBounds();
  if (bounds === null) return;

  for (const placed of gridCandidates(nodeGrid, bounds)) {
    if (!nodeInBounds(placed, bounds)) continue;
    if (!nodeViews.has(placed.node.id)) mountNode(placed);
  }
  for (const [id, nodeView] of nodeViews) {
    const placed = model.layout.positions.get(id);
    if (placed === undefined || !nodeInBounds(placed, bounds)) {
      nodeView.group.remove();
      nodeViews.delete(id);
    }
  }

  for (const plan of gridCandidates(planGrid, bounds)) {
    if (!planInBounds(plan, bounds)) continue;
    if (!edgeViews.has(plan.id)) mountPlan(plan);
  }
  for (const [id, edgeView] of edgeViews) {
    if (!planInBounds(edgeView.plan, bounds)) {
      edgeView.group.remove();
      edgeViews.delete(id);
      if (hoverKey === `plan:${id}`) {
        hoverKey = null;
        hoverText = '';
        hideTip();
      }
    }
  }
}

function applyStrokeWidths(): void {
  if (viewport === null || view.k === strokeZoom) return;
  strokeZoom = view.k;
  const inv = 1 / Math.max(view.k, 0.0001);
  const style = viewport.style;
  style.setProperty('--flow-edge-w', (1.6 * inv).toFixed(3));
  style.setProperty('--flow-edge-lit-w', (2.4 * inv).toFixed(3));
  style.setProperty('--flow-edge-bundle-w', (1.8 * inv).toFixed(3));
  style.setProperty('--flow-route-w', (2 * inv).toFixed(3));
  style.setProperty('--flow-hit-w', (12 * inv).toFixed(3));
  style.setProperty('--flow-dash', `${(5 * inv).toFixed(3)} ${(3 * inv).toFixed(3)}`);
}

function applyView(): void {
  if (viewport === null) return;
  viewport.style.transform = `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(
    view.k,
  )})`;
  applyStrokeWidths();
  syncTextVisibility();
  positionAxis();
  scheduleViewportUpdate();
}

function syncTextVisibility(): void {
  const hidden = view.k < TEXT_MIN_ZOOM;
  if (hidden === textsHidden) return;
  textsHidden = hidden;
  const svg = document.getElementById('map-svg');
  if (svg !== null) svg.classList.toggle('is-zoom-out', hidden);
}

function fitView(): void {
  const svg = svgById('map-svg');
  const rect = svg.getBoundingClientRect();
  if (model === null || rect.width === 0 || rect.height === 0) {
    view = { x: 40, y: 40, k: 1 };
    viewReady = true;
    applyView();
    return;
  }
  const padding = 36;
  const width = Math.max(1, model.layout.width);
  const height = Math.max(1, model.layout.height);
  const usableHeight = Math.max(1, rect.height - AXIS_HEIGHT);
  const k = clamp(
    Math.min((rect.width - padding * 2) / width, (usableHeight - padding * 2) / height),
    MIN_ZOOM,
    1.15,
  );
  view = {
    k,
    x: (rect.width - width * k) / 2,
    y: AXIS_HEIGHT + (usableHeight - height * k) / 2,
  };
  viewReady = true;
  applyView();
}

function fitToNodes(ids: readonly string[]): void {
  if (model === null) return;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const placed = model.layout.positions.get(id);
    if (placed === undefined) continue;
    minX = Math.min(minX, placed.x);
    minY = Math.min(minY, placed.y);
    maxX = Math.max(maxX, placed.x + placed.width);
    maxY = Math.max(maxY, placed.y + placed.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    fitView();
    return;
  }
  const svg = svgById('map-svg');
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const padding = 56;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const usableHeight = Math.max(1, rect.height - AXIS_HEIGHT);
  const k = clamp(
    Math.min((rect.width - padding * 2) / width, (usableHeight - padding * 2) / height),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  view = {
    k,
    x: rect.width / 2 - (minX + width / 2) * k,
    y: AXIS_HEIGHT + usableHeight / 2 - (minY + height / 2) * k,
  };
  viewReady = true;
  applyView();
}

function zoomAt(px: number, py: number, factor: number): void {
  const k = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
  const worldX = (px - view.x) / view.k;
  const worldY = (py - view.y) / view.k;
  view = { k, x: px - worldX * k, y: py - worldY * k };
  viewReady = true;
  applyView();
}

function layerTech(snapshot: FlowSnapshot, type: FlowNodeType): string | null {
  const stack = snapshot.stack;
  switch (type) {
    case 'file':
      return 'workspace';
    case 'structure':
      return 'DOM';
    case 'asset':
      return 'CSS / JS';
    case 'element':
      return 'HTML';
    case 'handler':
      return stack.frontend?.label ?? 'frontend';
    case 'request':
      return 'HTTP';
    case 'route':
    case 'function':
      return stack.backend?.label ?? 'backend';
    case 'query':
    case 'database':
      return stack.database?.label ?? 'base de datos';
    case 'table':
      return null;
  }
}

function positionAxis(): void {
  if (model === null || model.layout.mode === 'hierarchical') return;
  for (const entry of axisEntries) {
    if (entry.x === null) continue;
    const left = view.x + entry.x * view.k;
    entry.el.style.transform = `translateX(${String(left)}px)`;
    entry.el.style.maxWidth =
      entry.width === null ? '' : `${String(Math.max(24, entry.width * view.k - 10))}px`;
  }
  for (const grip of axisGrips) {
    const left = view.x + grip.x * view.k;
    grip.el.style.transform = `translateX(${String(left - COLUMN_GRIP_WIDTH / 2)}px)`;
  }
}

function renderAxis(): void {
  const bar = document.getElementById('map-axis');
  if (bar === null) return;
  bar.replaceChildren();
  axisEntries = [];
  axisGrips = [];
  if (model === null || model.layout.layers.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const hierarchical = model.layout.mode === 'hierarchical';
  let flatLeft = 8;
  for (const layer of model.layout.layers) {
    const tech = layerTech(model.snapshot, layer.type);
    const layerLabel =
      layer.label ?? (layer.type === 'element' ? 'CONTROLES' : TYPE_LABEL[layer.type]);
    const fullCaption = `${layerLabel} · ${String(layer.count)}${tech === null ? '' : ` · ${tech}`}`;
    const countCaption = `${layerLabel} · ${String(layer.count)}`;
    let caption = fullCaption;
    if (!hierarchical && layer.width !== undefined) {
      const available = Math.max(24, layer.width - 6);
      if (textWidth(caption, AXIS_FONT, AXIS_LETTER_SPACING) > available) {
        caption =
          textWidth(countCaption, AXIS_FONT, AXIS_LETTER_SPACING) <= available
            ? countCaption
            : layerLabel;
      }
    }
    const label = document.createElement('span');
    label.className = 'axis-label';
    label.textContent = caption;
    label.title = fullCaption;
    bar.append(label);
    if (hierarchical) {
      label.style.left = `${String(flatLeft)}px`;
      flatLeft += label.offsetWidth + 16;
      axisEntries.push({ el: label, x: null, width: null });
      continue;
    }
    axisEntries.push({ el: label, x: layer.x, width: layer.width ?? null });
    if (layer.type === 'table') continue;
    const grip = document.createElement('span');
    grip.className = 'axis-grip';
    grip.title = `${layerLabel}: arrastra para cambiar el ancho de la columna; doble clic para ajustarlo al contenido`;
    if (columnResize !== null && columnResize.type === layer.type) {
      grip.classList.add('is-active');
    }
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      beginColumnResize(layer.type, event.clientX);
    });
    grip.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetColumnWidth(layer.type);
    });
    bar.append(grip);
    axisGrips.push({ el: grip, x: layer.x + (layer.width ?? 0) });
  }
  positionAxis();
}

function mergeEvidence(edges: readonly FlowEdge[]): string[] {
  const result: string[] = [];
  for (const edge of edges) {
    for (const kind of edge.evidence) {
      if (!result.includes(kind)) result.push(kind);
    }
  }
  return result;
}

function lastSeenOf(edges: readonly FlowEdge[]): number {
  let latest = 0;
  for (const edge of edges) latest = Math.max(latest, edge.lastSeen);
  return latest;
}

function mergedEdgeTooltip(
  target: FlowNode,
  edges: readonly FlowEdge[],
  flowClass: EdgeFlowClass,
  roundTrip: boolean,
): string {
  const kinds = edges.map(
    (edge) =>
      `${edge.type}${edge.occurrences > 1 ? ` ×${String(edge.occurrences)}` : ''}${
        edge.correlation === 'heuristic' ? ' (heurística)' : ''
      }`,
  );
  const parts = [
    directionLabel(flowClass, roundTrip),
    `${String(edges.length)} conexiones hacia ${TYPE_LABEL[target.type]} ${target.title}`,
    kinds.join(' · '),
  ];
  const latest = lastSeenOf(edges);
  if (latest > 0) parts.push(`Visto: ${clock(latest)}`);
  const notes = [
    ...new Set(
      edges.map((edge) => edge.note).filter((note): note is string => note !== null && note !== ''),
    ),
  ];
  if (notes.length > 0) parts.push(notes.join(' · '));
  return parts.join('\n');
}

function edgeClassName(
  evidence: readonly string[],
  heuristic: boolean,
  bundle: boolean,
  flowClass: EdgeFlowClass,
  roundTrip: boolean,
): string {
  let name = `flow-edge is-${flowClass}`;
  if (heuristic) name += ' is-heuristic';
  if (bundle) name += ' is-bundle';
  if (!evidence.includes('RUNTIME')) name += ' is-static-only';
  if (roundTrip) name += ' is-roundtrip';
  return name;
}

function planBBox(x1: number, y1: number, x2: number, y2: number): EdgePlan['bbox'] {
  return {
    minX: Math.min(x1, x2) - 16,
    minY: Math.min(y1, y2) - 16,
    maxX: Math.max(x1, x2) + 16,
    maxY: Math.max(y1, y2) + 16,
  };
}

function makePlan(input: {
  id: string;
  kind: EdgePlan['kind'];
  sources: string[];
  to: string;
  edgeIds: string[];
  tooltip: string;
  d: string;
  marker: string;
  startMarker?: string;
  className: string;
  flowClass: EdgeFlowClass;
  roundTrip: boolean;
  glyph?: '↑' | '↓' | '';
  glyphX?: number;
  glyphY?: number;
  bbox: EdgePlan['bbox'];
}): EdgePlan {
  return {
    id: input.id,
    kind: input.kind,
    sources: input.sources,
    to: input.to,
    edgeIds: input.edgeIds,
    tooltip: input.tooltip,
    d: input.d,
    marker: input.marker,
    startMarker: input.startMarker ?? '',
    className: input.className,
    flowClass: input.flowClass,
    roundTrip: input.roundTrip,
    glyph: input.glyph ?? '',
    glyphX: input.glyphX ?? 0,
    glyphY: input.glyphY ?? 0,
    bbox: input.bbox,
  };
}

function edgePath(sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const bend = Math.max(36, Math.abs(targetX - sourceX) / 2);
  return `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX + bend)} ${String(
    sourceY,
  )}, ${String(targetX - bend)} ${String(targetY)}, ${String(targetX)} ${String(targetY)}`;
}

function receiveEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  const bend = Math.max(36, Math.abs(targetX - sourceX) / 2);
  return `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX - bend)} ${String(
    sourceY,
  )}, ${String(targetX + bend)} ${String(targetY)}, ${String(targetX)} ${String(targetY)}`;
}

function verticalEdgePath(source: FlowPlacedNode, target: FlowPlacedNode): string {
  const downward = target.y >= source.y;
  const sourceX = source.x + source.width / 2;
  const sourceY = downward ? source.y + source.height : source.y;
  const targetX = target.x + target.width / 2;
  const targetY = downward ? target.y : target.y + target.height;
  const bend = Math.max(18, Math.abs(targetY - sourceY) / 2);
  const direction = downward ? 1 : -1;
  return `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX)} ${String(
    sourceY + direction * bend,
  )}, ${String(targetX)} ${String(targetY - direction * bend)}, ${String(targetX)} ${String(
    targetY,
  )}`;
}

function tableAnchorY(edge: FlowEdge, sourceNode: FlowNode, targetNode: FlowNode): number | null {
  if (targetNode.type !== 'table') return null;
  if (edge.type !== 'READS' && edge.type !== 'WRITES') return null;
  if (sourceNode.type !== 'query' || tableIndex === null) return null;
  if (compactMode) return TABLE_HEAD / 2;
  return tableIndex.anchorYOf(targetNode.id, sourceNode.id);
}

function buildSinglePlan(item: SingleEdgeItem): EdgePlan {
  const { edge, flowClass } = item;
  const roundTrip = edgeRoundTrip(edge, item.targetNode, flowClass);
  let from = item.source;
  let to = item.target;
  let anchorY: number | null = null;
  if (flowClass === 'receive' && to.x > from.x) {
    from = item.target;
    to = item.source;
  } else {
    anchorY = tableAnchorY(edge, item.source.node, item.targetNode);
  }
  if (anchorY !== null) anchorY += item.target.y;

  let d: string;
  let glyph: '↑' | '↓' | '' = '';
  let glyphX = 0;
  let glyphY = 0;
  if (from.x === to.x) {
    d = verticalEdgePath(from, to);
    if (flowClass === 'receive') {
      glyph = '↓';
      glyphX = from.x - 9;
      glyphY = from.y + from.height / 2;
    }
  } else if (from.x > to.x) {
    const sourceX = from.x;
    const sourceY = from.y + from.height / 2;
    const targetX = to.x + to.width;
    const targetY = to.y + to.height / 2;
    d = receiveEdgePath(sourceX, sourceY, targetX, targetY);
    if (flowClass === 'receive') {
      glyph = '↓';
      glyphX = sourceX - 9;
      glyphY = sourceY - 6;
    }
  } else {
    const sourceX = from.x + from.width;
    const sourceY = from.y + from.height / 2;
    const targetX = to.x;
    const targetY = anchorY ?? to.y + to.height / 2;
    d = edgePath(sourceX, sourceY, targetX, targetY);
    if (flowClass === 'send' || flowClass === 'gateway' || flowClass === 'server') {
      glyph = '↑';
      glyphX = sourceX + 9;
      glyphY = sourceY - 6;
    }
  }

  const marker = flowClass === 'neutral' ? '' : flowClassMarker(flowClass);
  return makePlan({
    id: `edge:${edge.id}`,
    kind: 'edge',
    sources: [edge.from],
    to: edge.to,
    edgeIds: [edge.id],
    tooltip: edgeTooltip(edge, flowClass, roundTrip),
    d,
    marker,
    startMarker: roundTrip ? marker : '',
    className: edgeClassName(
      edge.evidence,
      edge.correlation === 'heuristic',
      false,
      flowClass,
      roundTrip,
    ),
    flowClass,
    roundTrip,
    glyph: roundTrip ? '' : glyph,
    glyphX,
    glyphY,
    bbox: planBBox(from.x, from.y, to.x + to.width, to.y + to.height),
  });
}

function hierarchyEdgePath(
  source: FlowPlacedNode,
  target: FlowPlacedNode,
  anchorY: number | null,
): string {
  if (Math.abs(source.y - target.y) < 1 && source.x !== target.x) {
    const sourceY = source.y + source.height / 2;
    const targetY = anchorY === null ? target.y + target.height / 2 : target.y + anchorY;
    if (target.x > source.x) {
      return edgePath(source.x + source.width, sourceY, target.x, targetY);
    }
    return receiveEdgePath(source.x, sourceY, target.x + target.width, targetY);
  }
  if (anchorY !== null) {
    const downward = target.y >= source.y;
    const sourceX = source.x + source.width / 2;
    const sourceY = downward ? source.y + source.height : source.y;
    const targetX = target.x + target.width / 2;
    const targetY = target.y + anchorY;
    const bend = Math.max(18, Math.abs(targetY - sourceY) / 2);
    const direction = downward ? 1 : -1;
    return `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX)} ${String(
      sourceY + direction * bend,
    )}, ${String(targetX)} ${String(targetY - direction * bend)}, ${String(targetX)} ${String(
      targetY,
    )}`;
  }
  return verticalEdgePath(source, target);
}

function buildHierarchyPlan(item: SingleEdgeItem): EdgePlan {
  const { edge, flowClass } = item;
  const roundTrip = edgeRoundTrip(edge, item.targetNode, flowClass);
  const marker = flowClass === 'neutral' ? '' : flowClassMarker(flowClass);
  const anchorY = tableAnchorY(edge, item.source.node, item.targetNode);
  return makePlan({
    id: `edge:${edge.id}`,
    kind: 'edge',
    sources: [edge.from],
    to: edge.to,
    edgeIds: [edge.id],
    tooltip: edgeTooltip(edge, flowClass, roundTrip),
    d: hierarchyEdgePath(item.source, item.target, anchorY),
    marker,
    startMarker: roundTrip ? marker : '',
    className: edgeClassName(
      edge.evidence,
      edge.correlation === 'heuristic',
      false,
      flowClass,
      roundTrip,
    ),
    flowClass,
    roundTrip,
    bbox: planBBox(
      item.source.x,
      item.source.y,
      item.target.x + item.target.width,
      item.target.y + item.target.height,
    ),
  });
}

function buildCorridorPlans(group: CorridorGroup): EdgePlan[] {
  const current = model;
  if (current === null) return [];
  const right = group.destLayer > group.originLayer;
  const dir = right ? 1 : -1;
  const neutral = group.flowClass === 'neutral';
  const offset = CORRIDOR_OFFSET[group.flowClass];
  const marker = neutral ? '' : flowClassMarker(group.flowClass);

  interface OriginAgg {
    originId: string;
    originNode: FlowNode;
    edgeX: number;
    y: number;
  }

  interface DestAgg {
    destId: string;
    dest: FlowPlacedNode;
    destNode: FlowNode;
    originIds: Set<string>;
    ySum: number;
    yCount: number;
    edges: FlowEdge[];
    roundTrip: boolean;
  }

  const originAgg = new Map<string, OriginAgg>();
  const destAgg = new Map<string, DestAgg>();

  for (const [originId, dests] of group.byOrigin) {
    const origin = current.layout.positions.get(originId);
    const originNode = current.nodesById.get(originId);
    if (origin === undefined || originNode === undefined) continue;
    let originInfo = originAgg.get(originId);
    if (originInfo === undefined) {
      originInfo = {
        originId,
        originNode,
        edgeX: right ? origin.x + origin.width : origin.x,
        y: origin.y + origin.height / 2,
      };
      originAgg.set(originId, originInfo);
    }
    for (const [destId, edges] of dests) {
      const dest = current.layout.positions.get(destId);
      const destNode = current.nodesById.get(destId);
      const first = edges[0];
      if (dest === undefined || destNode === undefined || first === undefined) continue;
      const anchorY =
        tableAnchorY(
          first,
          current.nodesById.get(first.from) ?? originNode,
          current.nodesById.get(first.to) ?? destNode,
        ) ?? (destNode.type === 'table' ? TABLE_HEAD / 2 : dest.height / 2);
      let destInfo = destAgg.get(destId);
      if (destInfo === undefined) {
        destInfo = {
          destId,
          dest,
          destNode,
          originIds: new Set(),
          ySum: 0,
          yCount: 0,
          edges: [],
          roundTrip: false,
        };
        destAgg.set(destId, destInfo);
      }
      destInfo.originIds.add(originId);
      destInfo.ySum += dest.y + anchorY;
      destInfo.yCount += 1;
      destInfo.edges.push(...edges);
      if (!neutral && edges.some((edge) => edgeRoundTrip(edge, destNode, group.flowClass))) {
        destInfo.roundTrip = true;
      }
    }
  }

  const origins = [...originAgg.values()];
  const dests = [...destAgg.values()];
  const firstOrigin = origins[0];
  const firstDest = dests[0];
  if (firstOrigin === undefined || firstDest === undefined) return [];
  if (origins.length === 1 && dests.length === 1) return [];

  const originEdgeX = right
    ? Math.max(...origins.map((origin) => origin.edgeX))
    : Math.min(...origins.map((origin) => origin.edgeX));
  const spineX = originEdgeX + dir * (ORIGIN_SPINE_GAP + offset);
  const targetConnX = right
    ? Math.min(...dests.map((dest) => dest.dest.x))
    : Math.max(...dests.map((dest) => dest.dest.x + dest.dest.width));
  const junctionX = targetConnX - dir * (BUNDLE_JUNCTION_GAP + offset);

  const originYs = origins.map((origin) => origin.y);
  const branchYs = dests.map((dest) => dest.ySum / dest.yCount);
  const bridgeY =
    (Math.min(...originYs) +
      Math.max(...originYs) +
      Math.min(...branchYs) +
      Math.max(...branchYs)) /
    4;
  const spineMin = Math.min(...originYs, bridgeY);
  const spineMax = Math.max(...originYs, bridgeY);
  const busMin = Math.min(...branchYs, bridgeY);
  const busMax = Math.max(...branchYs, bridgeY);

  const allEdges = dests.flatMap((dest) => dest.edges);
  const trunkEvidence = mergeEvidence(allEdges);
  const trunkHeuristic = allEdges.some((edge) => edge.correlation === 'heuristic');
  const anyRoundTrip = dests.some((dest) => dest.roundTrip);
  const originIds = origins.map((origin) => origin.originId);
  const destIds = dests.map((dest) => dest.destId);
  const allIds = [...originIds, ...destIds];
  const latest = lastSeenOf(allEdges);
  const destLabel = TYPE_LABEL[firstDest.destNode.type];
  const originLabel = TYPE_LABEL[firstOrigin.originNode.type];
  const className = edgeClassName(
    trunkEvidence,
    trunkHeuristic,
    true,
    group.flowClass,
    anyRoundTrip,
  );
  const summaryParts = neutral
    ? [
        'Contención agrupada en un solo eje',
        `${String(origins.length)} orígenes · ${String(dests.length)} destinos · ${String(allEdges.length)} conexiones`,
      ]
    : [
        directionLabel(group.flowClass, anyRoundTrip),
        `Corredor hacia ${destLabel}`,
        `${String(origins.length)} orígenes · ${String(dests.length)} destinos · ${String(allEdges.length)} conexiones en un solo eje`,
      ];
  if (latest > 0) summaryParts.push(`Visto: ${clock(latest)}`);
  const summary = summaryParts.join('\n');
  const railParts = [
    `${String(origins.length)} ${origins.length === 1 ? 'origen' : 'orígenes'} · ${String(allEdges.length)} conexiones`,
    `Desde ${originLabel}`,
  ];
  if (latest > 0) railParts.push(`Visto: ${clock(latest)}`);
  const railTooltip = railParts.join('\n');

  const plans: EdgePlan[] = [];
  const stubs = origins.map(
    (origin) =>
      `M ${String(origin.edgeX)} ${String(origin.y)} L ${String(spineX)} ${String(origin.y)}`,
  );
  plans.push(
    makePlan({
      id: `corr-rail:${String(group.originLayer)}:${String(group.destLayer)}:${group.flowClass}`,
      kind: 'trunk',
      sources: originIds,
      to: '',
      edgeIds: allEdges.map((edge) => edge.id),
      tooltip: railTooltip,
      d: [
        `M ${String(spineX)} ${String(spineMin)} L ${String(spineX)} ${String(spineMax)}`,
        ...stubs,
      ].join(' '),
      marker: '',
      className,
      flowClass: group.flowClass,
      roundTrip: anyRoundTrip,
      bbox: planBBox(
        Math.min(spineX, originEdgeX),
        spineMin,
        Math.max(spineX, originEdgeX),
        spineMax,
      ),
    }),
  );
  plans.push(
    makePlan({
      id: `corr-bridge:${String(group.originLayer)}:${String(group.destLayer)}:${group.flowClass}`,
      kind: 'trunk',
      sources: allIds,
      to: '',
      edgeIds: allEdges.map((edge) => edge.id),
      tooltip: summary,
      d: `M ${String(spineX)} ${String(bridgeY)} L ${String(junctionX)} ${String(bridgeY)}`,
      marker,
      startMarker: anyRoundTrip ? marker : '',
      className,
      flowClass: group.flowClass,
      roundTrip: anyRoundTrip,
      bbox: planBBox(spineX, bridgeY, junctionX, bridgeY),
    }),
  );
  if (busMax - busMin > 1) {
    plans.push(
      makePlan({
        id: `corr-bus:${String(group.originLayer)}:${String(group.destLayer)}:${group.flowClass}`,
        kind: 'trunk',
        sources: allIds,
        to: '',
        edgeIds: allEdges.map((edge) => edge.id),
        tooltip: summary,
        d: `M ${String(junctionX)} ${String(busMin)} L ${String(junctionX)} ${String(busMax)}`,
        marker: '',
        className,
        flowClass: group.flowClass,
        roundTrip: anyRoundTrip,
        bbox: planBBox(junctionX, busMin, junctionX, busMax),
      }),
    );
  }
  for (const dest of dests) {
    const first = dest.edges[0];
    if (first === undefined) continue;
    const y = dest.ySum / dest.yCount;
    plans.push(
      makePlan({
        id: `corr-branch:${String(group.originLayer)}:${String(group.destLayer)}:${dest.destId}:${group.flowClass}`,
        kind: 'trunk',
        sources: [...dest.originIds],
        to: dest.destId,
        edgeIds: dest.edges.map((edge) => edge.id),
        tooltip:
          dest.edges.length === 1
            ? edgeTooltip(first, group.flowClass, dest.roundTrip)
            : mergedEdgeTooltip(dest.destNode, dest.edges, group.flowClass, dest.roundTrip),
        d: `M ${String(junctionX)} ${String(y)} L ${String(targetConnX)} ${String(y)}`,
        marker,
        startMarker: dest.roundTrip ? marker : '',
        className: edgeClassName(
          mergeEvidence(dest.edges),
          dest.edges.some((edge) => edge.correlation === 'heuristic'),
          true,
          group.flowClass,
          dest.roundTrip,
        ),
        flowClass: group.flowClass,
        roundTrip: dest.roundTrip,
        bbox: planBBox(junctionX, y, targetConnX, y),
      }),
    );
  }
  return plans;
}

function buildEdgePlans(): EdgePlan[] {
  if (model === null) {
    respondedScope = new Set();
    return [];
  }
  respondedScope = computeRespondedScope();
  const positions = model.layout.positions;
  const hierarchical = model.layout.mode === 'hierarchical';
  const corridors = new Map<string, CorridorGroup>();
  const singles: SingleEdgeItem[] = [];

  const addCorridor = (
    edge: FlowEdge,
    originId: string,
    destId: string,
    originLayer: number,
    destLayer: number,
    flowClass: EdgeFlowClass,
  ): void => {
    const key = `${String(originLayer)}\u0000${String(destLayer)}\u0000${flowClass}`;
    let group = corridors.get(key);
    if (group === undefined) {
      group = { flowClass, originLayer, destLayer, byOrigin: new Map() };
      corridors.set(key, group);
    }
    let dests = group.byOrigin.get(originId);
    if (dests === undefined) {
      dests = new Map();
      group.byOrigin.set(originId, dests);
    }
    const list = dests.get(destId);
    if (list === undefined) {
      dests.set(destId, [edge]);
    } else {
      list.push(edge);
    }
  };

  for (const edge of model.viewEdges) {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    const sourceNode = model.nodesById.get(edge.from);
    const targetNode = model.nodesById.get(edge.to);
    if (
      source === undefined ||
      target === undefined ||
      sourceNode === undefined ||
      targetNode === undefined
    ) {
      continue;
    }
    const flowClass = flowClassFor(edge, sourceNode, targetNode);
    if (hierarchical) {
      singles.push({ edge, source, target, targetNode, flowClass });
      continue;
    }
    const receiveFlip =
      flowClass === 'receive' && sourceNode.type === 'element' && targetNode.type !== 'element';
    const originId = receiveFlip ? edge.to : edge.from;
    const destId = receiveFlip ? edge.from : edge.to;
    const origin = receiveFlip ? target : source;
    const dest = receiveFlip ? source : target;
    if (dest.layer === origin.layer) {
      singles.push({ edge, source, target, targetNode, flowClass });
      continue;
    }
    addCorridor(edge, originId, destId, origin.layer, dest.layer, flowClass);
  }

  const corridorPlans: CorridorGroup[] = [];
  for (const group of corridors.values()) {
    let pairs = 0;
    for (const dests of group.byOrigin.values()) pairs += dests.size;
    if (pairs >= 2) {
      corridorPlans.push(group);
      continue;
    }
    for (const dests of group.byOrigin.values()) {
      for (const edges of dests.values()) {
        for (const edge of edges) {
          const source = positions.get(edge.from);
          const target = positions.get(edge.to);
          const targetNode = model.nodesById.get(edge.to);
          if (source === undefined || target === undefined || targetNode === undefined) continue;
          singles.push({ edge, source, target, targetNode, flowClass: group.flowClass });
        }
      }
    }
  }

  const plans = singles.map((item) =>
    hierarchical ? buildHierarchyPlan(item) : buildSinglePlan(item),
  );
  for (const group of corridorPlans) {
    plans.push(...buildCorridorPlans(group));
  }
  return plans;
}

function mountPlan(plan: EdgePlan): void {
  const group = svgElement('g');
  const attributes: Record<string, string> = {
    class: plan.className,
    d: plan.d,
    'data-plan-id': plan.id,
  };
  if (plan.marker !== '') attributes['marker-end'] = plan.marker;
  if (plan.startMarker !== '') attributes['marker-start'] = plan.startMarker;
  group.append(svgElement('path', { class: 'flow-edge-hit', d: plan.d, 'data-plan-id': plan.id }));
  const path = svgElement('path', attributes);
  group.append(path);
  let glyph: SVGTextElement | null = null;
  if (plan.glyph !== '') {
    glyph = svgText(`flow-dir is-${plan.flowClass}`, plan.glyphX, plan.glyphY, plan.glyph);
    group.append(glyph);
  }
  const layer = plan.kind === 'trunk' ? trunkLayer : branchLayer;
  if (layer !== null) layer.append(group);
  const view: EdgeView = { plan, path, group, glyph };
  edgeViews.set(plan.id, view);
  applyPlanViewState(view);
}

function mountNode(placed: FlowPlacedNode): void {
  if (nodeLayer === null) return;
  const group = createNodeGroup(placed);
  nodeLayer.append(group);
  const view = { node: placed.node, group };
  nodeViews.set(placed.node.id, view);
  applyNodeViewState(view);
}

function renderGraph(): void {
  const svg = svgById('map-svg');
  svg.replaceChildren();
  nodeViews = new Map();
  edgeViews = new Map();
  edgePlans = [];
  planById = new Map();
  respondedScope = new Set();
  planGrid = new Map();
  nodeGrid = new Map();
  strokeZoom = 0;
  viewport = null;
  branchLayer = null;
  trunkLayer = null;
  nodeLayer = null;
  cellRouteLayer = null;
  hoverKey = null;
  hoverText = '';
  hideTip();
  closeNodeMenu();
  renderAxis();
  if (model === null) return;

  const defs = svgElement('defs');
  const markers: Array<[string, string]> = [
    ['flow-arrow-send', '#58a6ff'],
    ['flow-arrow-receive', '#3fb950'],
    ['flow-arrow-gateway', '#d29922'],
    ['flow-arrow-server', '#bc8cff'],
    ['flow-arrow-neutral', '#6e7f8f'],
    ['flow-arrow-cell', '#58a6ff'],
    ['flow-arrow-cell-write', '#e3b341'],
  ];
  for (const [id, color] of markers) {
    const marker = svgElement('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    });
    marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    defs.append(marker);
  }
  svg.append(defs);

  const group = svgElement('g');
  viewport = group;
  group.style.transformOrigin = '0 0';
  group.style.willChange = 'transform';
  svg.append(group);

  const branches = svgElement('g');
  const trunks = svgElement('g');
  const nodes = svgElement('g');
  const routes = svgElement('g');
  branchLayer = branches;
  trunkLayer = trunks;
  nodeLayer = nodes;
  cellRouteLayer = routes;
  group.append(branches, trunks, nodes, routes);

  edgePlans = buildEdgePlans();
  planById = new Map(edgePlans.map((plan) => [plan.id, plan]));
  buildSpatialGrids();
  applyFiltersAndSelection();
  if (!viewReady) {
    fitView();
  } else {
    applyView();
  }
  mountCellRoutes();
  updateVisibleViews();
}

function createNodeGroup(placed: FlowPlacedNode): SVGGElement {
  const node = placed.node;
  const group = svgElement('g', {
    class: `flow-node${evidenceClass(node.evidence) === '' ? '' : ` ${evidenceClass(node.evidence)}`}`,
    transform: `translate(${String(placed.x)} ${String(placed.y)})`,
    'data-node-id': node.id,
  });
  if (node.type === 'element') {
    group.classList.toggle('is-hidden', node.visible === false);
    group.classList.toggle('is-disabled', node.disabled === true);
  }
  group.classList.toggle('is-compact', compactMode);
  const width = placed.width;
  const height = placed.height;
  if (node.type === 'table') {
    const table = tableDataOf(node);
    if (table !== null) {
      group.classList.add('is-table');
      createTableNodeGroup(group, placed, table);
      group.addEventListener('click', (event) => {
        event.stopPropagation();
        selectNode(node.id);
      });
      group.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openNodeMenu(node.id, event.clientX, event.clientY);
      });
      return group;
    }
  }
  group.append(
    svgElement('rect', {
      class: 'box',
      x: '0',
      y: '0',
      width: String(width),
      height: String(height),
    }),
  );
  group.append(
    svgElement('rect', {
      class: 'bar',
      x: '0',
      y: '0',
      width: '3',
      height: String(height),
    }),
  );
  const badge = badgeText(node);
  const badgeWidth = badge === '' ? 0 : 8 + textWidth(badge, BADGE_FONT);
  if (compactMode) {
    const middle = height / 2 + 4;
    const titleMax = width - CARD_TEXT_LEFT - CARD_TEXT_RIGHT - badgeWidth;
    group.append(
      svgText('title', CARD_TEXT_LEFT, middle, truncateToWidth(node.title, titleMax, TITLE_FONT)),
    );
    if (badge !== '') {
      group.append(svgText('badge', width - CARD_TEXT_RIGHT, middle, badge));
    }
  } else {
    const typeMax = width - CARD_TEXT_LEFT - CARD_TEXT_RIGHT - badgeWidth;
    group.append(
      svgText(
        'type',
        CARD_TEXT_LEFT,
        14,
        truncateToWidth(nodeTypeLabel(node), typeMax, TYPE_FONT, TYPE_LETTER_SPACING),
      ),
    );
    if (badge !== '') {
      group.append(svgText('badge', width - CARD_TEXT_RIGHT, 14, badge));
    }
    const seen = node.firstSeen > 0 ? clock(node.firstSeen) : '';
    const timeWidth = seen === '' ? 0 : 8 + textWidth(seen, TIME_FONT);
    group.append(
      svgText(
        'title',
        CARD_TEXT_LEFT,
        28,
        truncateToWidth(node.title, width - CARD_TEXT_LEFT - CARD_TEXT_RIGHT, TITLE_FONT),
      ),
    );
    if (node.subtitle !== null && node.subtitle !== '') {
      group.append(
        svgText(
          'sub',
          CARD_TEXT_LEFT,
          41,
          truncateToWidth(
            node.subtitle,
            width - CARD_TEXT_LEFT - CARD_TEXT_RIGHT - timeWidth,
            SUB_FONT,
          ),
        ),
      );
    }
    if (seen !== '') {
      group.append(svgText('time', width - CARD_TEXT_RIGHT, 41, seen));
    }
  }
  group.addEventListener('click', (event) => {
    event.stopPropagation();
    selectNode(node.id);
  });
  group.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openNodeMenu(node.id, event.clientX, event.clientY);
  });
  return group;
}

function svgTitleElement(node: SVGElement, value: string): void {
  const title = svgElement('title');
  title.textContent = value;
  node.append(title);
}

function gridMaxChars(plan: TableGridColumnPlan): number {
  return Math.max(4, Math.floor((plan.width - GRID_CELL_PAD * 2) / GRID_CHAR));
}

function columnUsageSummary(table: FlowTableData, columnName: string): string {
  const column = table.columns.find(
    (entry) => entry.name.toLowerCase() === columnName.toLowerCase(),
  );
  return column === undefined ? '' : usageTags(column).map(usageText).join(' · ');
}

function cellTooltip(table: FlowTableData, plan: TableGridColumnPlan, rowIndex: number): string {
  const value = tableCellAt(table, plan.name, rowIndex) ?? '·';
  const row = table.grid.rows[rowIndex];
  const query = row?.query.node;
  const tags = row?.cells[table.grid.columns.indexOf(plan)]?.tags ?? [];
  const parts = [`${table.name}.${plan.name} · fila ${String(rowIndex + 1)}`, `Valor: ${value}`];
  if (tags.length > 0) parts.push(tags.map(usageText).join(' · '));
  if (query !== undefined) {
    parts.push(
      `${query.operation === null || query.operation === undefined ? 'SQL' : (OPERATION_LABEL[query.operation] ?? query.operation)} · ${
        row?.query.functionNode?.title ?? 'consulta directa'
      }`,
    );
  }
  return parts.join('\n');
}

interface CellRoutePlan {
  d: string;
  marker: string;
  className: string;
  tooltip: string;
  dotX: number;
  dotY: number;
}

function cellRoutePlans(): CellRoutePlan[] {
  const picked = pickedCell;
  const index = tableIndex;
  if (picked === null || picked.rowIndex === null || index === null || model === null) return [];
  const table = index.of(picked.tableId);
  const tablePlaced = model.layout.positions.get(picked.tableId);
  const row = table?.grid.rows[picked.rowIndex];
  const column = table?.grid.columns.find((entry) => entry.name.toLowerCase() === picked.column);
  if (table === null || tablePlaced === undefined || row === undefined || column === undefined) {
    return [];
  }
  const queryPlaced = model.layout.positions.get(row.query.node.id);
  if (queryPlaced === undefined) return [];
  const cellX = tablePlaced.x + column.x;
  const cellY =
    tablePlaced.y +
    TABLE_HEAD +
    table.grid.headerHeight +
    picked.rowIndex * table.grid.rowHeight +
    table.grid.rowHeight / 2;
  const queryX = queryPlaced.x + queryPlaced.width;
  const queryY = queryPlaced.y + queryPlaced.height / 2;
  const operation = row.query.node.operation;
  const label =
    operation === null || operation === undefined
      ? 'SQL'
      : (OPERATION_LABEL[operation] ?? operation);
  const value = tableCellAt(table, column.name, picked.rowIndex) ?? '·';
  const head = [
    `Celda ${table.name}.${column.name} · fila ${String(picked.rowIndex + 1)}`,
    `Valor: ${truncate(value, 140)}`,
    `${label} · ${row.query.functionNode?.title ?? 'consulta directa'} · ${
      row.query.runtime ? 'RUNTIME' : 'STATIC'
    }`,
  ].join('\n');
  const plans: CellRoutePlan[] = [];
  if (row.query.read) {
    plans.push({
      d: receiveEdgePath(cellX, cellY, queryX, queryY),
      marker: 'url(#flow-arrow-cell)',
      className: 'is-read',
      tooltip: `${head}\nLectura: el dato sale de la celda hacia el backend`,
      dotX: cellX,
      dotY: cellY,
    });
  }
  if (row.query.write) {
    plans.push({
      d: edgePath(queryX, queryY, cellX, cellY),
      marker: 'url(#flow-arrow-cell-write)',
      className: 'is-write',
      tooltip: `${head}\nEscritura: el backend escribe en esta celda`,
      dotX: cellX,
      dotY: cellY,
    });
  }
  return plans;
}

function mountCellRoutes(): void {
  if (cellRouteLayer === null) return;
  cellRouteLayer.replaceChildren();
  for (const plan of cellRoutePlans()) {
    const path = svgElement('path', {
      class: `flow-cell-route ${plan.className}`,
      d: plan.d,
      'marker-end': plan.marker,
    });
    svgTitleElement(path, plan.tooltip);
    cellRouteLayer.append(path);
    cellRouteLayer.append(
      svgElement('circle', {
        class: 'flow-cell-dot',
        cx: String(plan.dotX),
        cy: String(plan.dotY),
        r: '3',
      }),
    );
  }
}

function clearCellFlash(): void {
  if (flashTimer !== null) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  flashCells = null;
}

function startCellFlash(
  table: FlowTableData,
  columnName: string | null,
  rowIndex: number | null,
): void {
  clearCellFlash();
  const keys = new Set<string>();
  if (rowIndex !== null && columnName !== null) {
    keys.add(tableCellKey(table.id, columnName, rowIndex));
  } else {
    const columnIndex =
      columnName === null
        ? -1
        : table.grid.columns.findIndex(
            (entry) => entry.name.toLowerCase() === columnName.toLowerCase(),
          );
    if (columnName !== null && columnIndex < 0) return;
    table.grid.rows.forEach((row, rowIndexEntry) => {
      row.cells.forEach((cell, cellIndex) => {
        if (cell.heat === null) return;
        if (columnIndex >= 0 && cellIndex !== columnIndex) return;
        const column = table.grid.columns[cellIndex];
        if (column === undefined) return;
        keys.add(tableCellKey(table.id, column.name, rowIndexEntry));
      });
    });
  }
  if (keys.size === 0) return;
  flashCells = keys;
  flashTimer = setTimeout(() => {
    flashTimer = null;
    flashCells = null;
    if (state.open) renderGraph();
  }, FLASH_MS);
}

function pageTargetsFromQueries(
  queryIds: Iterable<string>,
): Array<{ key: string | null; selector: string }> {
  if (model === null) return [];
  const targets: Array<{ key: string | null; selector: string }> = [];
  const seenSelectors = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const queryId of queryIds) {
    if (visited.has(queryId)) continue;
    visited.add(queryId);
    queue.push(queryId);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const node = model.nodesById.get(current);
    const selector = node === undefined ? null : pageSelector(node);
    if (selector !== null && !seenSelectors.has(selector)) {
      seenSelectors.add(selector);
      const prefix = `${node?.type ?? ''}:`;
      targets.push({
        key: node !== undefined && node.id.startsWith(prefix) ? node.id.slice(prefix.length) : null,
        selector,
      });
    }
    for (const previous of model.incoming.get(current) ?? []) {
      if (visited.has(previous)) continue;
      visited.add(previous);
      queue.push(previous);
    }
  }
  return targets;
}

function highlightTableQueries(table: FlowTableData, columnName: string | null): boolean {
  const lower = columnName === null ? null : columnName.toLowerCase();
  const queries = table.queries.filter(
    (query) =>
      lower === null ||
      query.columns.some(
        (column) => column.tableId === table.id && column.name.toLowerCase() === lower,
      ),
  );
  const targets = pageTargetsFromQueries(queries.map((query) => query.node.id));
  if (targets.length === 0) return false;
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.highlight, { targets });
  return true;
}

function highlightCell(table: FlowTableData, columnName: string, rowIndex: number | null): void {
  if (rowIndex !== null) {
    const query = table.grid.rows[rowIndex]?.query.node;
    if (query !== undefined) {
      const targets = pageTargetsFromQueries([query.id]);
      if (targets.length > 0) {
        ipcRenderer.send(BROWSER_PANEL_CHANNELS.highlight, { targets });
        return;
      }
    }
  } else if (highlightTableQueries(table, columnName)) {
    return;
  }
  highlightInPage(table.node);
}

function selectTableCell(tableId: string, columnName: string, rowIndex: number | null): void {
  const table = tableIndex?.of(tableId);
  const node = model?.nodesById.get(tableId);
  if (table === null || table === undefined || node === undefined) return;
  pickedCell = { tableId, column: columnName.toLowerCase(), rowIndex };
  selectedId = tableId;
  selectionHighlight = true;
  hideSearchResults();
  hideTip();
  closeNodeMenu();
  startCellFlash(table, columnName, rowIndex);
  renderDetail(node);
  renderGraph();
  renderStatus();
  highlightCell(table, columnName, rowIndex);
}

function createTableNodeGroup(
  group: SVGGElement,
  placed: FlowPlacedNode,
  table: FlowTableData,
): void {
  const width = placed.width;
  const height = placed.height;
  group.append(
    svgElement('rect', {
      class: 'box',
      x: '0',
      y: '0',
      width: String(width),
      height: String(height),
    }),
    svgElement('rect', {
      class: 'head',
      x: '0',
      y: '0',
      width: String(width),
      height: String(TABLE_HEAD),
    }),
    svgElement('rect', { class: 'bar', x: '0', y: '0', width: '3', height: String(height) }),
  );

  if (!compactMode) {
    const marks = new Set<string>();
    for (const query of table.queries) {
      if (tableIndex === null) break;
      const y = tableIndex.anchorYOf(table.id, query.node.id);
      for (const kind of [query.read ? 'read' : null, query.write ? 'write' : null]) {
        if (kind === null) continue;
        const key = `${kind}:${String(Math.round(y))}`;
        if (marks.has(key)) continue;
        marks.add(key);
        group.append(
          svgElement('rect', {
            class: `bar-mark is-${kind}`,
            x: '0',
            y: String(Math.max(0, y - 3)),
            width: '3',
            height: '6',
          }),
        );
      }
    }
  }

  group.append(
    svgText(
      'tag',
      10,
      12,
      `TABLA · ${String(table.columns.length)} ${
        table.columns.length === 1 ? 'COLUMNA' : 'COLUMNAS'
      }`,
    ),
  );
  group.append(svgText('count', width - 8, 12, `${String(table.queries.length)} SQL`, 'end'));
  const databaseLabel = table.databaseTitle ?? '';
  const countWidth = 8 + textWidth(`${String(table.queries.length)} SQL`, BADGE_FONT);
  group.append(
    svgText(
      'title',
      10,
      29,
      truncateToWidth(table.name, width - 18 - (databaseLabel === '' ? countWidth : 0), TITLE_FONT),
    ),
  );
  if (databaseLabel !== '') {
    group.append(
      svgText(
        'sub',
        width - 8,
        42,
        truncateToWidth(databaseLabel, Math.max(24, width - 20), SUB_FONT),
        'end',
      ),
    );
  }
  if (compactMode) return;

  const grid = table.grid;
  const gridTop = TABLE_HEAD;
  if (grid.columns.length > 0) {
    const gridLayer = svgElement('g', { class: 'data-grid' });
    gridLayer.append(
      svgElement('rect', {
        class: 'grid-gutter-head',
        x: '0',
        y: String(gridTop),
        width: String(GRID_GUTTER),
        height: String(grid.headerHeight),
      }),
      svgElement('rect', {
        class: 'grid-head',
        x: String(GRID_GUTTER),
        y: String(gridTop),
        width: String(width - GRID_GUTTER),
        height: String(grid.headerHeight),
      }),
    );
    gridLayer.append(svgText('grid-num', GRID_GUTTER - 8, gridTop + 13, '#', 'end'));
    grid.rows.forEach((_row, rowIndex) => {
      const rowY = gridTop + grid.headerHeight + rowIndex * grid.rowHeight;
      gridLayer.append(
        svgElement('rect', {
          class: rowIndex % 2 === 1 ? 'grid-row is-alt' : 'grid-row',
          x: '0',
          y: String(rowY),
          width: String(width),
          height: String(grid.rowHeight),
        }),
      );
      gridLayer.append(
        svgText('grid-num', GRID_GUTTER - 8, rowY + 13, String(rowIndex + 1), 'end'),
      );
    });
    for (const plan of grid.columns) {
      gridLayer.append(
        svgElement('rect', {
          class: 'grid-sep',
          x: String(plan.x - 1),
          y: String(gridTop),
          width: '1',
          height: String(Math.max(1, grid.height)),
        }),
      );
    }
    gridLayer.append(
      svgElement('rect', {
        class: 'grid-head-line',
        x: '0',
        y: String(gridTop + grid.headerHeight - 1),
        width: String(width),
        height: '1',
      }),
    );

    grid.columns.forEach((plan, columnIndex) => {
      const columnName = plan.name.toLowerCase();
      const columnPicked =
        pickedCell !== null &&
        pickedCell.tableId === table.id &&
        pickedCell.column === columnName &&
        pickedCell.rowIndex === null;
      const columnGroup = svgElement('g', {
        class: `data-grid-col${columnPicked ? ' is-selected' : ''}`,
      });
      columnGroup.append(
        svgElement('rect', {
          class: 'grid-col-bg',
          x: String(plan.x),
          y: String(gridTop),
          width: String(plan.width),
          height: String(Math.max(1, grid.height)),
        }),
        svgElement('rect', {
          class: 'grid-head-cell',
          x: String(plan.x),
          y: String(gridTop),
          width: String(plan.width),
          height: String(grid.headerHeight),
        }),
      );
      const headerHit = svgElement('rect', {
        class: 'grid-hit',
        x: String(plan.x),
        y: String(gridTop),
        width: String(plan.width),
        height: String(grid.headerHeight),
      });
      const usage = columnUsageSummary(table, plan.name);
      svgTitleElement(headerHit, `${table.name}.${plan.name}${usage === '' ? '' : ` · ${usage}`}`);
      headerHit.addEventListener('click', (event) => {
        event.stopPropagation();
        selectTableCell(table.id, plan.name, null);
      });
      headerHit.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openNodeMenu(table.node.id, event.clientX, event.clientY);
      });
      columnGroup.append(headerHit);
      const nameText = svgText(
        'grid-name',
        plan.x + GRID_CELL_PAD,
        gridTop + 13,
        truncate(plan.name, gridMaxChars(plan)),
      );
      if (plan.name.length > gridMaxChars(plan)) svgTitleElement(nameText, plan.name);
      columnGroup.append(nameText);
      plan.tags.forEach((tag, tagIndex) => {
        columnGroup.append(
          svgText(
            `use ${gridUsageClass(tag)}`,
            plan.x + GRID_CELL_PAD,
            gridTop + GRID_NAME_LINE + 7 + tagIndex * GRID_TAG_LINE,
            usageText(tag),
          ),
        );
      });

      grid.rows.forEach((row, rowIndex) => {
        const cell = row.cells[columnIndex] ?? {
          text: '·',
          kind: 'absent' as const,
          tags: [] as string[],
          heat: null,
        };
        const cellY = gridTop + grid.headerHeight + rowIndex * grid.rowHeight;
        const picked =
          pickedCell !== null &&
          pickedCell.tableId === table.id &&
          pickedCell.column === columnName &&
          pickedCell.rowIndex === rowIndex;
        if (picked) {
          columnGroup.append(
            svgElement('rect', {
              class: 'grid-cell-picked',
              x: String(plan.x),
              y: String(cellY),
              width: String(plan.width),
              height: String(grid.rowHeight),
            }),
          );
        }
        if (flashCells !== null && flashCells.has(tableCellKey(table.id, plan.name, rowIndex))) {
          columnGroup.append(
            svgElement('rect', {
              class: 'grid-cell-flash',
              x: String(plan.x),
              y: String(cellY),
              width: String(plan.width),
              height: String(grid.rowHeight),
            }),
          );
        }
        const shown = truncate(cell.text, gridMaxChars(plan));
        const cellNode = svgText(
          `grid-cell${cell.kind === 'null' ? ' is-null' : ''}${
            cell.kind === 'absent' ? ' is-absent' : ''
          }`,
          plan.x + GRID_CELL_PAD,
          cellY + 13,
          shown,
        );
        if (shown !== cell.text) svgTitleElement(cellNode, `${plan.name}: ${cell.text}`);
        columnGroup.append(cellNode);
        cell.tags.forEach((tag, tagIndex) => {
          columnGroup.append(
            svgText(
              `use ${gridUsageClass(tag)}`,
              plan.x + GRID_CELL_PAD,
              cellY + GRID_NAME_LINE + 7 + tagIndex * GRID_TAG_LINE,
              usageText(tag),
            ),
          );
        });
        const select = (event: MouseEvent): void => {
          event.stopPropagation();
          selectTableCell(table.id, plan.name, rowIndex);
        };
        const openMenu = (event: MouseEvent): void => {
          event.preventDefault();
          event.stopPropagation();
          openNodeMenu(table.node.id, event.clientX, event.clientY);
        };
        cellNode.addEventListener('click', select);
        cellNode.addEventListener('contextmenu', openMenu);
        const cellHit = svgElement('rect', {
          class: 'grid-hit',
          x: String(plan.x),
          y: String(cellY),
          width: String(plan.width),
          height: String(grid.rowHeight),
        });
        cellHit.setAttribute('data-cell-tip', cellTooltip(table, plan, rowIndex));
        cellHit.addEventListener('click', select);
        cellHit.addEventListener('contextmenu', openMenu);
        columnGroup.append(cellHit);
      });
      gridLayer.append(columnGroup);
    });
    group.append(gridLayer);
  }

  const notesTop = TABLE_HEAD + grid.height + (grid.columns.length === 0 ? 8 : 0);
  table.notes.forEach((note, index) => {
    group.append(
      svgText(
        'note',
        10,
        notesTop + index * TABLE_NOTE + 11,
        truncate(note, Math.max(12, Math.floor((width - 20) / 5.4))),
      ),
    );
  });
}

function matchesSearch(node: FlowNode): boolean {
  if (searchTerm === '') return true;
  const parts: Array<string | null | undefined> = [
    node.title,
    node.subtitle,
    node.file,
    node.path,
    node.url,
    node.method,
    node.sql,
    node.note,
    node.engine,
    node.database,
    node.selector,
    node.href,
    node.formAction,
    nodeTypeLabel(node),
  ];
  for (const table of node.tablesRead ?? []) parts.push(table);
  for (const table of node.tablesWritten ?? []) parts.push(table);
  for (const hint of node.handlers ?? []) {
    parts.push(
      hint.name,
      hint.source,
      hint.event,
      hint.profile?.signature ?? null,
      ...handlerProfileTags(hint.profile ?? null),
    );
  }
  const status = requestStatus(node);
  if (status !== null) parts.push(status.search);
  const table = tableDataOf(node);
  if (table !== null) parts.push(table.search);
  return parts.some(
    (part) => part !== null && part !== undefined && normalizeSearchText(part).includes(searchTerm),
  );
}

function eventSubgraph(event: FlowInteractionEvent): Set<string> {
  const seen = new Set<string>();
  if (model === null) return seen;
  const seeds = new Set<string>();
  for (const node of model.snapshot.nodes) {
    if (node.type !== 'element') continue;
    if ((node.events ?? []).some((item) => item.event === event && item.count > 0)) {
      seeds.add(node.id);
    }
  }
  // Un salto hacia atrás mantiene visible el botón que envía un formulario filtrado por «Envío».
  for (const edge of model.snapshot.edges) {
    if (!seeds.has(edge.to)) continue;
    const source = model.nodesById.get(edge.from);
    if (source !== undefined && source.type === 'element') seeds.add(edge.from);
  }
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of model.outgoing.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function inTrafficMode(nodeId: string): boolean {
  if (trafficMode === 'all') return true;
  return model?.runtimeReachable.has(nodeId) ?? false;
}

function trafficScope(): Set<string> | null {
  if (trafficMode === 'all' || model === null) return null;
  return model.runtimeReachable;
}

function scopeForView(): Set<string> | null {
  const base = focusScope ?? trafficScope();
  if (!eventOnly || eventFilter === null) return base;
  const events = eventSubgraph(eventFilter);
  if (base === null) return events;
  const scope = new Set<string>();
  for (const id of events) {
    if (base.has(id)) scope.add(id);
  }
  return scope;
}

function syncEventOnly(): void {
  const box = document.getElementById('map-event-only') as HTMLInputElement | null;
  if (box === null) return;
  box.checked = eventOnly;
}

let busyCount = 0;
let scopeApplyTimer: number | null = null;

function syncBusy(): void {
  const busy = document.getElementById('map-busy');
  if (busy === null) return;
  const active = state.building || busyCount > 0;
  busy.hidden = !active;
  const label = busy.querySelector('.busy-label');
  if (label !== null) {
    label.textContent = busyCount > 0 ? 'Aplicando filtro…' : 'Actualizando mapa…';
  }
}

function scheduleScopeApply(): void {
  if (scopeApplyTimer !== null) {
    clearTimeout(scopeApplyTimer);
    busyCount = Math.max(0, busyCount - 1);
  }
  busyCount += 1;
  syncBusy();
  scopeApplyTimer = window.setTimeout(() => {
    scopeApplyTimer = null;
    try {
      applyScopeView();
    } finally {
      busyCount = Math.max(0, busyCount - 1);
      syncBusy();
    }
  }, 32);
}

function applyScopeView(): void {
  if (model === null) return;
  const scope = scopeForView();
  if (selectedId !== null && scope !== null && !scope.has(selectedId)) {
    selectedId = null;
    selectionHighlight = false;
    highlightScope = null;
    const detail = element('map-detail');
    detail.hidden = true;
    detail.replaceChildren();
  }
  applyDisplayScope(scope);
  renderGraph();
  if (scope === null) {
    fitView();
  } else {
    fitToNodes([...scope]);
  }
  renderStatus();
}

function syncTrafficButtons(): void {
  const all = element<HTMLButtonElement>('map-scope-all');
  const interacted = element<HTMLButtonElement>('map-scope-interacted');
  all.classList.toggle('is-on', trafficMode === 'all');
  interacted.classList.toggle('is-on', trafficMode === 'interacted');
  all.setAttribute('aria-pressed', trafficMode === 'all' ? 'true' : 'false');
  interacted.setAttribute('aria-pressed', trafficMode === 'interacted' ? 'true' : 'false');
}

function syncKindButtons(): void {
  const modes: Array<['all' | 'read' | 'write', string]> = [
    ['all', 'map-kind-all'],
    ['read', 'map-kind-read'],
    ['write', 'map-kind-write'],
  ];
  for (const [mode, id] of modes) {
    const button = document.getElementById(id);
    if (button === null) continue;
    button.classList.toggle('is-on', kindMode === mode);
    button.setAttribute('aria-pressed', kindMode === mode ? 'true' : 'false');
  }
}

function setKindMode(mode: 'all' | 'read' | 'write'): void {
  if (kindMode === mode) return;
  kindMode = mode;
  syncKindButtons();
  if (pickedCell !== null) {
    pickedCell = null;
    clearCellFlash();
  }
  if (!state.open || model === null) {
    renderStatus();
    return;
  }
  const scope = scopeForView();
  applyDisplayScope(scope);
  if (selectedId !== null && !model.viewNodes.some((node) => node.id === selectedId)) {
    selectedId = null;
    selectionHighlight = false;
    highlightScope = null;
    const detail = element('map-detail');
    detail.hidden = true;
    detail.replaceChildren();
  }
  renderGraph();
  if (scope === null) {
    fitView();
  } else {
    fitToNodes([...scope]);
  }
  renderStatus();
}

function syncOrderButtons(): void {
  const chrono = document.getElementById('map-order-chrono');
  const structural = document.getElementById('map-order-structural');
  const hierarchy = document.getElementById('map-order-hierarchy');
  chrono?.classList.toggle('is-on', layoutMode === 'chronological');
  chrono?.setAttribute('aria-pressed', layoutMode === 'chronological' ? 'true' : 'false');
  structural?.classList.toggle('is-on', layoutMode === 'structural');
  structural?.setAttribute('aria-pressed', layoutMode === 'structural' ? 'true' : 'false');
  hierarchy?.classList.toggle('is-on', layoutMode === 'hierarchical');
  hierarchy?.setAttribute('aria-pressed', layoutMode === 'hierarchical' ? 'true' : 'false');
}

function setLayoutMode(mode: FlowLayoutMode): void {
  if (layoutMode === mode) return;
  layoutMode = mode;
  syncOrderButtons();
  if (!state.open || model === null) {
    renderStatus();
    return;
  }
  const scope = scopeForView();
  applyDisplayScope(scope);
  renderGraph();
  if (scope === null) {
    fitView();
  } else {
    fitToNodes([...scope]);
  }
  renderStatus();
}

function syncCompact(): void {
  const box = document.getElementById('map-compact') as HTMLInputElement | null;
  if (box !== null) box.checked = compactMode;
}

function setCompactMode(next: boolean): void {
  if (compactMode === next) return;
  compactMode = next;
  if (next) {
    pickedCell = null;
    clearCellFlash();
  }
  syncCompact();
  if (!state.open || model === null) {
    renderStatus();
    return;
  }
  const scope = scopeForView();
  applyDisplayScope(scope);
  renderGraph();
  if (scope === null) {
    fitView();
  } else {
    fitToNodes([...scope]);
  }
  renderStatus();
}

function scheduleColumnRelayout(): void {
  if (columnFrame !== 0) return;
  columnFrame = requestAnimationFrame(() => {
    columnFrame = 0;
    if (!state.open || model === null) return;
    applyDisplayScope(scopeForView());
    renderGraph();
  });
}

function setColumnWidth(type: FlowNodeType, width: number): void {
  const next = Math.round(clamp(width, COLUMN_WIDTH_MIN, COLUMN_WIDTH_MAX));
  if (columnWidths.get(type) === next) return;
  columnWidths.set(type, next);
  scheduleColumnRelayout();
}

function resetColumnWidth(type: FlowNodeType): void {
  if (!columnWidths.delete(type)) return;
  scheduleColumnRelayout();
}

function beginColumnResize(type: FlowNodeType, startClientX: number): void {
  if (model === null) return;
  if (columnResize !== null) endColumnResize();
  const layer = model.layout.layers.find((entry) => entry.type === type);
  columnResize = { type, startClientX, startWidth: layer?.width ?? CARD_WIDTH_MIN };
  document.body.classList.add('is-column-resizing');
  window.addEventListener('pointermove', moveColumnResize);
  window.addEventListener('pointerup', endColumnResize);
  window.addEventListener('pointercancel', endColumnResize);
  window.addEventListener('blur', endColumnResize);
}

function moveColumnResize(event: PointerEvent): void {
  if (columnResize === null) return;
  event.preventDefault();
  const delta = (event.clientX - columnResize.startClientX) / Math.max(view.k, 0.01);
  setColumnWidth(columnResize.type, columnResize.startWidth + delta);
}

function endColumnResize(): void {
  columnResize = null;
  document.body.classList.remove('is-column-resizing');
  window.removeEventListener('pointermove', moveColumnResize);
  window.removeEventListener('pointerup', endColumnResize);
  window.removeEventListener('pointercancel', endColumnResize);
  window.removeEventListener('blur', endColumnResize);
}

function setTrafficMode(mode: TrafficMode): void {
  trafficMode = mode;
  syncTrafficButtons();
  if (!state.open) return;
  focusScope = null;
  focusOriginId = null;
  focusDirection = 'both';
  hideSearchResults();
  const scope = scopeForView();
  if (selectedId !== null && scope !== null && !scope.has(selectedId)) {
    selectedId = null;
    const detail = element('map-detail');
    detail.hidden = true;
    detail.replaceChildren();
  }
  if (model !== null) {
    applyDisplayScope(scope);
    renderGraph();
    fitView();
  }
  renderStatus();
}

function applyNodeViewState(view: { node: FlowNode; group: SVGGElement }): void {
  const isSelected = selectedId === view.node.id;
  const inChain =
    selectionHighlight &&
    selectedId !== null &&
    !isSelected &&
    (highlightScope?.has(view.node.id) ?? false);
  const visibleNode = filterVisibility.get(view.node.id) ?? true;
  const selectionDim = selectionHighlight && selectedId !== null && !isSelected && !inChain;
  view.group.classList.toggle('is-selected', isSelected);
  view.group.classList.toggle('is-chain', inChain);
  view.group.classList.toggle('is-dimmed', !visibleNode || selectionDim);
}

function applyPlanViewState(view: EdgeView): void {
  const plan = view.plan;
  const targetVisible = plan.to === '' ? true : (filterVisibility.get(plan.to) ?? true);
  const sourceVisible =
    plan.kind === 'trunk'
      ? plan.sources.some((id) => filterVisibility.get(id) ?? true)
      : plan.sources.every((id) => filterVisibility.get(id) ?? true);
  const inChain =
    selectionHighlight &&
    selectedId !== null &&
    highlightScope !== null &&
    (plan.to === '' || (highlightScope.has(plan.to) ?? false)) &&
    (plan.kind === 'trunk'
      ? plan.sources.some((id) => highlightScope?.has(id) ?? false)
      : plan.sources.length > 0 && plan.sources.every((id) => highlightScope?.has(id) ?? false));
  const lit =
    selectedId !== null &&
    (selectionHighlight ? inChain : plan.to === selectedId || plan.sources.includes(selectedId));
  const selectionDim = selectionHighlight && selectedId !== null && !lit;
  const dimmed = !targetVisible || !sourceVisible || selectionDim;
  view.path.classList.toggle('is-lit', lit);
  view.path.classList.toggle('is-dimmed', dimmed);
  view.glyph?.classList.toggle('is-dimmed', dimmed);
}

function applyFiltersAndSelection(): void {
  if (model === null) return;
  highlightScope =
    selectionHighlight && selectedId !== null ? involvedScope(selectedId, 'both') : null;
  const eventScope = eventFilter === null ? null : eventSubgraph(eventFilter);
  filterVisibility = new Map<string, boolean>();
  for (const node of model.snapshot.nodes) {
    const searchOk = focusScope !== null || matchesSearch(node);
    const modeOk = focusScope !== null || inTrafficMode(node.id);
    const focusOk = focusScope === null || focusScope.has(node.id);
    const eventOk = eventScope === null || eventScope.has(node.id);
    filterVisibility.set(node.id, searchOk && modeOk && focusOk && eventOk);
  }

  for (const view of nodeViews.values()) {
    applyNodeViewState(view);
  }

  for (const view of edgeViews.values()) {
    applyPlanViewState(view);
  }

  for (const [id, button] of traceButtons) {
    button.classList.toggle('is-selected', selectedId === id);
  }
}

function addRow(container: HTMLElement, label: string, value: string | HTMLElement | null): void {
  if (value === null || value === '') return;
  const row = document.createElement('div');
  row.className = 'row';
  const key = document.createElement('div');
  key.className = 'label';
  key.textContent = label;
  const text = document.createElement('div');
  text.className = 'value';
  if (typeof value === 'string') {
    text.textContent = value;
  } else {
    text.append(value);
  }
  row.append(key, text);
  container.append(row);
}

function locationText(node: FlowNode): string | null {
  if (node.file === null) return null;
  if (node.line === null) return node.file;
  if (node.endLine === null || node.endLine === node.line) {
    return `${node.file}:${String(node.line)}`;
  }
  return `${node.file}:${String(node.line)}–${String(node.endLine)}`;
}

function requestSummary(node: FlowNode): string | null {
  const parts: string[] = [];
  const status = requestStatus(node);
  if (status !== null) parts.push(status.label);
  if (node.durationMs !== null && node.durationMs !== undefined) {
    parts.push(`${String(Math.round(node.durationMs))} ms`);
  }
  if (node.origin !== null && node.origin !== undefined) {
    parts.push(ORIGIN_LABEL[node.origin] ?? node.origin);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function querySummary(node: FlowNode): string | null {
  const parts: string[] = [];
  if (node.operation !== null && node.operation !== undefined) {
    parts.push(OPERATION_LABEL[node.operation] ?? node.operation);
  }
  if (node.dialect !== null && node.dialect !== undefined) parts.push(node.dialect);
  if (node.parse !== null && node.parse !== undefined) {
    parts.push(PARSE_LABEL[node.parse] ?? node.parse);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function jsonMovementHead(movement: FlowJsonMovement): string {
  const where =
    movement.method !== null && movement.path !== null
      ? ` · ${movement.method} ${movement.path}`
      : '';
  const status = movement.status === null ? '' : ` · ${String(movement.status)}`;
  const count = movement.count > 1 ? ` · ${String(movement.count)}×` : '';
  const cut = movement.truncated ? ' · recortado' : '';
  return `${clock(movement.at)} · ${JSON_KIND_LABEL[movement.kind]}${where}${status}${count}${cut}`;
}

const jsonExpandedBodies = new Set<string>();

function jsonMovementItem(movement: FlowJsonMovement): HTMLElement {
  const item = document.createElement('div');
  item.className = 'json-item';
  const head = document.createElement('div');
  head.className = 'json-head';
  head.textContent = jsonMovementHead(movement);
  item.append(head);
  if (movement.body !== null) {
    const expanded = jsonExpandedBodies.has(movement.id);
    const body = document.createElement('div');
    body.className = 'json-body';
    body.textContent = expanded
      ? movement.body
      : jsonPreviewBody(movement.body, JSON_DETAIL_PREVIEW_CHARS);
    item.append(body);
    if (!expanded && movement.body.length > JSON_DETAIL_PREVIEW_CHARS) {
      const more = document.createElement('div');
      more.className = 'json-more';
      more.textContent = 'Ver cuerpo completo';
      more.addEventListener('click', () => {
        jsonExpandedBodies.add(movement.id);
        body.textContent = movement.body ?? '';
        more.remove();
      });
      item.append(more);
    }
  }
  if (movement.file !== null) {
    const where = movement.line > 0 ? `${movement.file}:${String(movement.line)}` : movement.file;
    const location = document.createElement('div');
    location.className = 'json-where';
    location.append(codeLink(where, movement.file, movement.line, null));
    item.append(location);
  }
  return item;
}

let jsonMovementsLive: readonly FlowJsonMovement[] = [];
let jsonCaptureLive: FlowJsonCaptureState | null = null;
let jsonCaptureLiveSet = false;
let jsonRailSignature = '';
const jsonMovementBodies = new Map<string, string>();

let jsonOwnerCache = new Map<string, string | null>();
let jsonMovementOwnerIndex = new Map<string, string>();
let jsonFunctionsByFile = new Map<string, FlowNode[]>();
let jsonRequests: FlowNode[] = [];
let jsonRoutes: FlowNode[] = [];

interface JsonRailEntry {
  el: HTMLDivElement;
  head: HTMLDivElement;
  body: HTMLDivElement | null;
  bodySource: string | null;
  movement: FlowJsonMovement;
}

const jsonRailEntries = new Map<string, JsonRailEntry>();

function stripQuery(value: string): string {
  const index = value.indexOf('?');
  return index === -1 ? value : value.slice(0, index);
}

function jsonPathMatches(pattern: string, path: string): boolean {
  const left = stripQuery(pattern);
  const right = stripQuery(path);
  if (left === right) return true;
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  if (leftParts.length !== rightParts.length) return false;
  for (let index = 0; index < leftParts.length; index += 1) {
    const part = leftParts[index] ?? '';
    if (part === (rightParts[index] ?? '')) continue;
    if (part.startsWith(':') || part === '*') continue;
    return false;
  }
  return true;
}

function indexJsonOwners(snapshot: FlowSnapshot): void {
  jsonOwnerCache = new Map();
  jsonMovementOwnerIndex = new Map();
  jsonFunctionsByFile = new Map();
  jsonRequests = [];
  jsonRoutes = [];
  for (const node of snapshot.nodes) {
    if (node.type === 'function' && node.file !== null) {
      const list = jsonFunctionsByFile.get(node.file) ?? [];
      list.push(node);
      jsonFunctionsByFile.set(node.file, list);
    } else if (node.type === 'request') {
      jsonRequests.push(node);
    } else if (node.type === 'route') {
      jsonRoutes.push(node);
    }
    for (const movement of node.jsonMovements ?? []) {
      jsonMovementOwnerIndex.set(movement.id, node.id);
    }
  }
}

function resolveJsonOwner(movement: FlowJsonMovement): string | null {
  const indexed = jsonMovementOwnerIndex.get(movement.id);
  if (indexed !== undefined) return indexed;
  if (movement.file !== null && movement.line > 0) {
    let best: FlowNode | null = null;
    for (const node of jsonFunctionsByFile.get(movement.file) ?? []) {
      if (node.line === null || node.endLine === null) continue;
      if (movement.line < node.line || movement.line > node.endLine) continue;
      if (best === null || node.endLine - node.line < (best.endLine ?? 0) - (best.line ?? 0)) {
        best = node;
      }
    }
    if (best !== null) return best.id;
  }
  if (movement.method === null || movement.path === null) return null;
  const method = movement.method.toUpperCase();
  const match = (nodes: readonly FlowNode[]): string | null => {
    for (const node of nodes) {
      if (node.method === null || node.path === null) continue;
      if (node.method.toUpperCase() !== method) continue;
      if (!jsonPathMatches(node.path, movement.path ?? '')) continue;
      return node.id;
    }
    return null;
  };
  return match(jsonRoutes) ?? match(jsonRequests);
}

function jsonOwnerNode(movement: FlowJsonMovement): FlowNode | null {
  if (model === null) return null;
  let id = jsonOwnerCache.get(movement.id);
  if (id === undefined) {
    id = resolveJsonOwner(movement);
    jsonOwnerCache.set(movement.id, id);
  }
  return id === null ? null : (model.nodesById.get(id) ?? null);
}

function jsonMovementsForNode(node: FlowNode): FlowJsonMovement[] {
  const source = jsonMovementsLive.length === 0 ? (node.jsonMovements ?? []) : jsonMovementsLive;
  const indexed = new Set((node.jsonMovements ?? []).map((movement) => movement.id));
  const list = source.filter(
    (movement) => indexed.has(movement.id) || jsonOwnerNode(movement)?.id === node.id,
  );
  return [...list].sort((left, right) => right.at - left.at);
}

function jsonPreviewBody(body: string, limit = JSON_RAIL_PREVIEW_CHARS): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}…`;
}

function syncJsonRail(): void {
  const capture = jsonCaptureLiveSet ? jsonCaptureLive : (state.jsonCapture ?? null);
  const captureKey = capture === null ? '' : `${String(capture.ok)}|${capture.error ?? ''}`;
  const sorted = [...jsonMovementsLive].sort((left, right) => right.at - left.at);
  const signature = `${signatureOf(sorted)}#${captureKey}`;
  if (signature === jsonRailSignature) return;
  jsonRailSignature = signature;
  renderJsonRail(sorted, capture);
}

function signatureOf(movements: readonly FlowJsonMovement[]): string {
  const parts: string[] = [];
  for (const movement of movements) {
    parts.push(
      `${movement.id}:${String(movement.at)}:${String(movement.count)}:${
        movement.truncated ? '1' : '0'
      }:${movement.body === null ? '0' : String(movement.body.length)}`,
    );
  }
  return parts.join('|');
}

function renderJsonRail(
  movements: readonly FlowJsonMovement[],
  capture: FlowJsonCaptureState | null,
): void {
  const title = element('map-json-title');
  const list = element('map-json-list');
  title.textContent = `Movimientos JSON · ${String(movements.length)}`;
  if (movements.length === 0) {
    jsonRailEntries.clear();
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      capture !== null
        ? capture.ok
          ? 'La captura está activa; aún no hay cuerpos JSON en el backend.'
          : (capture.error ?? 'La captura JSON no está disponible.')
        : 'Conecta el backend con Node Inspector para capturar JSON.';
    list.append(empty);
    return;
  }
  const empty = list.firstElementChild;
  if (empty !== null && empty.classList.contains('empty')) empty.remove();

  const seen = new Set<string>();
  let cursor: Element | null = list.firstElementChild;
  for (const movement of movements) {
    seen.add(movement.id);
    let entry = jsonRailEntries.get(movement.id);
    if (entry === undefined) {
      entry = createJsonRailEntry(movement);
      jsonRailEntries.set(movement.id, entry);
    } else {
      updateJsonRailEntry(entry, movement);
    }
    if (cursor !== entry.el) list.insertBefore(entry.el, cursor);
    cursor = entry.el.nextElementSibling;
  }
  for (const [id, entry] of jsonRailEntries) {
    if (seen.has(id)) continue;
    entry.el.remove();
    jsonRailEntries.delete(id);
  }
}

function createJsonRailEntry(movement: FlowJsonMovement): JsonRailEntry {
  const item = document.createElement('div');
  item.className = 'json-item is-preview';
  const head = document.createElement('div');
  head.className = 'json-head is-link';
  head.setAttribute('title', 'Clic para enfocar el nodo asociado');
  head.textContent = jsonMovementHead(movement);
  item.append(head);
  const entry: JsonRailEntry = {
    el: item,
    head,
    body: null,
    bodySource: null,
    movement,
  };
  if (movement.body !== null) {
    const body = document.createElement('div');
    body.className = 'json-body is-preview';
    body.textContent = jsonPreviewBody(movement.body);
    entry.body = body;
    entry.bodySource = movement.body;
    item.append(body);
  }
  head.addEventListener('click', () => {
    const owner = jsonOwnerNode(entry.movement);
    if (owner === null) return;
    selectNode(owner.id);
    fitToNodes([owner.id]);
  });
  return entry;
}

function updateJsonRailEntry(entry: JsonRailEntry, movement: FlowJsonMovement): void {
  entry.movement = movement;
  const head = jsonMovementHead(movement);
  if (entry.head.textContent !== head) entry.head.textContent = head;
  if (movement.body === entry.bodySource) return;
  entry.bodySource = movement.body;
  if (movement.body === null) {
    entry.body?.remove();
    entry.body = null;
    return;
  }
  if (entry.body === null) {
    const body = document.createElement('div');
    body.className = 'json-body is-preview';
    entry.body = body;
    entry.el.append(body);
  }
  entry.body.textContent = jsonPreviewBody(movement.body);
}

function applyFlowJsonState(next: FlowJsonState): void {
  jsonCaptureLive = next.capture;
  jsonCaptureLiveSet = true;
  const movements: FlowJsonMovement[] = [];
  const alive = new Set<string>();
  for (const movement of next.movements) {
    alive.add(movement.id);
    let body = movement.body;
    if (movement.bodyOmitted === true) {
      body = jsonMovementBodies.get(movement.id) ?? null;
    } else if (body !== null) {
      jsonMovementBodies.set(movement.id, body);
    }
    movements.push(body === movement.body ? movement : { ...movement, body, bodyOmitted: false });
  }
  for (const id of jsonMovementBodies.keys()) {
    if (!alive.has(id)) jsonMovementBodies.delete(id);
  }
  jsonMovementsLive = movements;
  renderStatus();
  if (state.open) syncJsonRail();
}

function connectionSummary(node: FlowNode): string | null {
  if (model === null) return null;
  let direct = 0;
  let heuristic = 0;
  for (const edge of model.snapshot.edges) {
    if (edge.from !== node.id && edge.to !== node.id) continue;
    if (edge.correlation === 'direct') {
      direct += 1;
    } else {
      heuristic += 1;
    }
  }
  if (direct === 0 && heuristic === 0) return null;
  return `${String(direct)} directas · ${String(heuristic)} heurísticas`;
}

const EDGE_VERB: Record<string, string> = {
  TRIGGERS: 'dispara',
  SENDS: 'envía a',
  SUBMITS: 'envía a',
  NAVIGATES: 'navega a',
  MATCHES: 'coincide con',
  HANDLES: 'atiende',
  QUERIES: 'consulta',
  READS: 'lee',
  WRITES: 'escribe',
  USES: 'usa',
  PROVENANCE: 'proviene de',
  RENDERS: 'renderiza',
  CONTAINS: 'contiene',
};

const EDGE_VERB_IN: Record<string, string> = {
  PROVENANCE: 'aporta datos a',
  RENDERS: 'renderizado por',
  CONTAINS: 'contenido en',
};

function connectionItems(node: FlowNode, direction: 'in' | 'out'): string[] {
  if (model === null) return [];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const edge of model.snapshot.edges) {
    if (direction === 'out' ? edge.from !== node.id : edge.to !== node.id) continue;
    const otherId = direction === 'out' ? edge.to : edge.from;
    const other = model.nodesById.get(otherId);
    if (other === undefined) continue;
    const verb =
      (direction === 'in' ? EDGE_VERB_IN[edge.type] : undefined) ??
      EDGE_VERB[edge.type] ??
      edge.type;
    const text = `${verb} ${nodeTypeLabel(other)} ${other.title}${
      edge.correlation === 'heuristic' ? ' (heurística)' : ''
    }`;
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts;
}

function reachableNodeList(id: string): FlowNode[] {
  if (model === null) return [];
  const nodes: FlowNode[] = [];
  for (const nodeId of forwardReachable(id)) {
    if (nodeId === id) continue;
    const node = model.nodesById.get(nodeId);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

function routeLine(node: FlowNode): HTMLElement {
  const method = node.method ?? 'GET';
  const path = node.path ?? node.title;
  const time = node.firstSeen > 0 ? `${clock(node.firstSeen)} · ` : '';
  const evidence = node.evidence.includes('RUNTIME') ? 'RUNTIME' : 'STATIC';
  const row = document.createElement('span');
  if (node.file === null) {
    row.textContent = `${time}${method} ${path} · ${evidence}`;
    return row;
  }
  const label = node.line === null ? node.file : `${node.file}:${String(node.line)}`;
  row.append(
    document.createTextNode(`${time}${method} ${path} · `),
    codeLink(label, node.file, node.line, node.endLine),
    document.createTextNode(` · ${evidence}`),
  );
  return row;
}

function requestLine(node: FlowNode): string {
  const base = `${node.method ?? ''} ${node.path ?? node.title}`.trim();
  const summary = requestSummary(node);
  const time = node.firstSeen > 0 ? `${clock(node.firstSeen)} · ` : '';
  return `${time}${summary === null ? base : `${base} · ${summary}`}`;
}

function chronologicalNodes(left: FlowNode, right: FlowNode): number {
  const leftTime = left.firstSeen > 0 ? left.firstSeen : Number.POSITIVE_INFINITY;
  const rightTime = right.firstSeen > 0 ? right.firstSeen : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return `${left.title}`.localeCompare(`${right.title}`, 'es') || left.id.localeCompare(right.id);
}

function reachableRoutes(node: FlowNode): HTMLElement[] {
  return reachableNodeList(node.id)
    .filter((item) => item.type === 'route')
    .sort(chronologicalNodes)
    .map(routeLine);
}

function reachableRequests(node: FlowNode): string[] {
  return reachableNodeList(node.id)
    .filter((item) => item.type === 'request')
    .sort(chronologicalNodes)
    .map(requestLine);
}

type ListEntry = string | HTMLElement;

function pagedList(items: readonly ListEntry[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'list';
  let shown = 0;
  let foot: HTMLDivElement | null = null;
  const append = (): void => {
    if (shown >= items.length) return;
    if (foot !== null) {
      foot.remove();
      foot = null;
    }
    const end = Math.min(items.length, shown + PAGE_SIZE);
    for (let index = shown; index < end; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      const row = document.createElement('div');
      row.className = 'list-item';
      if (typeof item === 'string') {
        row.textContent = item;
      } else {
        row.append(item);
      }
      wrap.append(row);
    }
    shown = end;
    if (shown < items.length) {
      foot = document.createElement('div');
      foot.className = 'list-foot';
      foot.textContent = `${String(shown)} de ${String(items.length)} · desplázate para cargar más`;
      wrap.append(foot);
    }
  };
  wrap.addEventListener('scroll', () => {
    if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 24) append();
  });
  append();
  return wrap;
}

function addListRow(
  container: HTMLElement,
  label: string,
  items: readonly ListEntry[],
  emptyText: string | null,
): void {
  if (items.length === 0 && emptyText === null) return;
  const row = document.createElement('div');
  row.className = 'row';
  const key = document.createElement('div');
  key.className = 'label';
  key.textContent = label;
  row.append(key);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = emptyText ?? '';
    row.append(empty);
  } else {
    row.append(pagedList(items));
  }
  container.append(row);
}

function tableQueryLine(query: TableQueryData): string {
  const operation = query.node.operation;
  const label =
    operation === null || operation === undefined
      ? 'SQL'
      : (OPERATION_LABEL[operation] ?? operation);
  return `${label} · ${query.functionNode?.title ?? 'consulta directa'} · ${
    query.runtime ? 'RUNTIME' : 'STATIC'
  }`;
}

function renderTableDetail(detail: HTMLElement, table: FlowTableData): void {
  const picked = pickedCell !== null && pickedCell.tableId === table.id ? pickedCell : null;
  if (picked !== null) {
    const row = picked.rowIndex === null ? null : (table.grid.rows[picked.rowIndex] ?? null);
    const column = table.grid.columns.find((entry) => entry.name.toLowerCase() === picked.column);
    const value =
      picked.rowIndex === null ? null : tableCellAt(table, picked.column, picked.rowIndex);
    addRow(
      detail,
      'Celda',
      `${table.name}.${picked.column}${
        picked.rowIndex === null ? ' · columna completa' : ` · fila ${String(picked.rowIndex + 1)}`
      }`,
    );
    if (value !== null) addRow(detail, 'Valor', value);
    if (column !== undefined) {
      addRow(
        detail,
        'Uso',
        column.tags.length === 0 ? null : column.tags.map(usageText).join(' · '),
      );
    }
    if (row !== null) {
      const query = row.query;
      addRow(detail, 'Consulta', tableQueryLine(query));
      if (query.functionNode !== null) {
        const fn = query.functionNode;
        addRow(detail, 'Función', codeLink(fn.title, fn.file, fn.line, fn.endLine));
      }
      const result = query.node.result;
      if (result !== null && result !== undefined) {
        addRow(
          detail,
          'Ejecución',
          `${result.driver} · ${clock(result.observedAt)} · ${String(
            result.rows.length,
          )} ${result.rows.length === 1 ? 'fila' : 'filas'}${result.truncated ? ' · truncada' : ''}`,
        );
      }
      if (query.node.sql !== null && query.node.sql !== undefined && query.node.sql !== '') {
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = 'SQL de la celda';
        const sql = document.createElement('div');
        sql.className = 'sql';
        sql.textContent = query.node.sql;
        const rowNode = document.createElement('div');
        rowNode.className = 'row';
        rowNode.append(label, sql);
        detail.append(rowNode);
      }
    } else {
      const queries = table.queries.filter((query) =>
        query.columns.some(
          (column) => column.tableId === table.id && column.name.toLowerCase() === picked.column,
        ),
      );
      addListRow(
        detail,
        'Consultas que la usan',
        queries.map(tableQueryLine),
        'Sin consultas registradas para esta columna.',
      );
    }
  }

  addRow(detail, 'Base de datos', table.databaseTitle);
  const ways = [table.read ? 'lecturas' : '', table.write ? 'escrituras' : '']
    .filter((part) => part !== '')
    .join(' y ');
  addRow(
    detail,
    'Resumen',
    `${String(table.columns.length)} columnas · ${String(table.queries.length)} SQL${
      ways === '' ? '' : ` · ${ways}`
    }${table.grid.rows.length === 0 ? '' : ` · ${String(table.grid.rows.length)} filas observadas`}`,
  );
  addListRow(
    detail,
    'Columnas',
    table.columns.map((column) => {
      const tags = usageTags(column).map(usageText).join(' · ');
      return `${column.name}${tags === '' ? '' : ` · ${tags}`}${column.runtime ? ' · RUNTIME' : ''}`;
    }),
    'Sin columnas declaradas.',
  );
  addListRow(
    detail,
    'Consultas',
    table.queries.map((query) => {
      const sql =
        query.node.sql === null || query.node.sql === undefined
          ? ''
          : ` · ${truncate(query.node.sql.replace(/\s+/g, ' '), 90)}`;
      return `${tableQueryLine(query)}${sql}`;
    }),
    'Sin SQL asociado.',
  );
  table.notes.forEach((note) => {
    const text = document.createElement('div');
    text.className = 'note';
    text.textContent = note;
    detail.append(text);
  });
}

function renderDetail(node: FlowNode): void {
  const detail = element('map-detail');
  detail.replaceChildren();
  const type = document.createElement('div');
  type.className = 'type';
  type.textContent = nodeTypeLabel(node);
  const title = document.createElement('h2');
  title.textContent = node.title;
  detail.append(type, title);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const item of node.evidence) {
    const chip = document.createElement('span');
    chip.className = `chip ${item.toLowerCase()}`;
    chip.textContent = item === 'RUNTIME' ? 'RUNTIME' : 'STATIC';
    chips.append(chip);
  }
  detail.append(chips);

  if (node.type === 'table') {
    const table = tableDataOf(node);
    if (table !== null) renderTableDetail(detail, table);
  }

  if (node.type === 'structure' || node.type === 'asset') {
    addRow(detail, 'Selector', node.selector ?? null);
    if (node.type === 'asset') addRow(detail, 'Archivo', node.href ?? null);
  }

  if (node.type === 'element') {
    addRow(detail, 'Selector', node.selector ?? null);
    addRow(detail, 'Destino del enlace', node.href ?? null);
    if (node.formAction !== null && node.formAction !== undefined) {
      addRow(detail, 'Formulario', `${node.formMethod ?? 'GET'} ${node.formAction}`);
    } else if (node.formKey !== null && node.formKey !== undefined) {
      addRow(detail, 'Formulario', 'sin action declarada');
    }
    if (node.disabled === true) addRow(detail, 'Estado', 'deshabilitado');
    if (node.visible === false) addRow(detail, 'Estado', 'oculto en el DOM');
    const handlers = (node.handlers ?? []).map((hint) => {
      const tags = handlerProfileTags(hint.profile ?? null);
      const suffix = tags.length === 0 ? '' : ` · ${tags.join(' · ')}`;
      return `${eventLabel(hint.event)} → ${handlerLabel(hint.name, hint.profile ?? null)}${suffix} (${hint.source})`;
    });
    addListRow(detail, 'Manejadores', handlers, null);
    addRow(detail, 'Eventos', eventSummary(node));
    addListRow(
      detail,
      'Rutas alcanzables',
      reachableRoutes(node),
      'Sin rutas alcanzables: no hay petición observada ni destino declarado que coincida con el índice.',
    );
    addListRow(detail, 'Peticiones alcanzables', reachableRequests(node), null);
  }

  addRow(detail, 'Detalle', node.subtitle);
  if (node.file !== null) {
    const label = locationText(node);
    addRow(
      detail,
      'Ubicación',
      label === null ? null : codeLink(label, node.file, node.line, node.endLine),
    );
  }
  if (node.method !== null && node.path !== null) {
    addRow(detail, 'Camino', `${node.method} ${node.path}`);
  }
  addRow(detail, 'URL', node.url);
  addRow(detail, 'Petición', requestSummary(node));
  const status = requestStatus(node);
  if (status !== null) {
    addRow(detail, 'Estado', status.label);
    addRow(detail, 'Ciclo', status.phase);
    if (node.backendObserved === true) {
      addRow(detail, 'Backend', 'ejecución capturada con Node Inspector');
    } else if (node.backendObserved === false) {
      addRow(detail, 'Backend', 'sin evidencia de ejecución');
    }
  }
  addRow(detail, 'Iniciador', node.initiatorFunction ?? null);
  addRow(detail, 'SQL', querySummary(node));
  addRow(detail, 'Conexiones', connectionSummary(node));
  addListRow(detail, 'Sale hacia', connectionItems(node, 'out'), null);
  addListRow(detail, 'Llega desde', connectionItems(node, 'in'), null);

  if (node.sql !== null && node.sql !== undefined && node.sql !== '') {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Consulta';
    const sql = document.createElement('div');
    sql.className = 'sql';
    sql.textContent = node.sql;
    row.append(label, sql);
    detail.append(row);
  }

  const jsonMovements = jsonMovementsForNode(node);
  if (jsonMovements.length > 0) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `Movimientos JSON · ${String(jsonMovements.length)}`;
    const list = document.createElement('div');
    list.className = 'json-list';
    for (const movement of jsonMovements) {
      list.append(jsonMovementItem(movement));
    }
    row.append(label, list);
    detail.append(row);
  }

  if ((node.tablesRead ?? []).length > 0) {
    addListRow(detail, 'Lee', node.tablesRead ?? [], null);
  }
  if ((node.tablesWritten ?? []).length > 0) {
    addListRow(detail, 'Escribe', node.tablesWritten ?? [], null);
  }
  if (node.engine !== null && node.engine !== undefined) {
    addRow(detail, 'Motor', node.engine);
  }
  if (node.database !== null && node.database !== undefined) {
    addRow(detail, 'Base de datos', node.database);
  }

  if (node.type === 'element') {
    addRow(detail, 'Interacciones', String(Math.max(node.occurrences, eventTotal(node))));
  } else if (node.countLabel !== null && node.countLabel !== undefined && node.occurrences > 0) {
    addRow(detail, node.countLabel, String(node.occurrences));
  } else if (node.occurrences > 1) {
    addRow(detail, 'Repeticiones', String(node.occurrences));
  }
  if (node.requestIds.length > 0) {
    addRow(detail, 'Peticiones', String(node.requestIds.length));
  }
  if (node.traceIds.length > 0) {
    addRow(detail, 'Trazas', String(node.traceIds.length));
  }
  if (node.firstSeen > 0) {
    addRow(
      detail,
      'Visto',
      node.firstSeen === node.lastSeen
        ? clock(node.firstSeen)
        : `${clock(node.firstSeen)} → ${clock(node.lastSeen)}`,
    );
  }
  if (node.note !== null && node.note !== '') {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = node.note;
    detail.append(note);
  }

  if (node.type === 'request') {
    const requestId = node.requestIds.find((id) => currentCardRequests.has(id));
    if (requestId !== undefined) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Ver petición';
      button.addEventListener('click', () => {
        ipcRenderer.send(BROWSER_PANEL_CHANNELS.selectRequest, requestId);
      });
      detail.append(button);
    } else {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent =
        'Esta petición no está en la tarjeta actual; vuelve a hacer clic en la página para abrirla.';
      detail.append(note);
    }
  }

  detail.hidden = false;
}

function pageSelector(node: FlowNode | undefined): string | null {
  if (
    node === undefined ||
    (node.type !== 'element' && node.type !== 'structure' && node.type !== 'asset')
  ) {
    return null;
  }
  const selector = node.selector;
  return typeof selector === 'string' && selector !== '' ? selector : null;
}

function pageElementFor(node: FlowNode): FlowNode | null {
  if (model === null) return null;
  if (pageSelector(node) !== null) return node;
  const queue: string[] = [node.id];
  const seen = new Set<string>([node.id]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const previous of model.incoming.get(current) ?? []) {
      if (seen.has(previous)) continue;
      seen.add(previous);
      const candidate = model.nodesById.get(previous);
      if (pageSelector(candidate) !== null) {
        return candidate ?? null;
      }
      queue.push(previous);
    }
  }
  return null;
}

function highlightInPage(node: FlowNode): void {
  if (node.type === 'table') {
    const table = tableDataOf(node);
    if (table !== null && highlightTableQueries(table, null)) return;
  }
  const target = pageElementFor(node);
  if (target === null) return;
  const selector = pageSelector(target);
  if (selector === null) return;
  const prefix = `${target.type}:`;
  const key = target.id.startsWith(prefix) ? target.id.slice(prefix.length) : null;
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.highlight, { key, selector });
}

function selectNode(id: string): void {
  const node = model?.nodesById.get(id);
  if (node === undefined) return;
  pickedCell = null;
  clearCellFlash();
  const table = node.type === 'table' ? tableDataOf(node) : null;
  if (table !== null) startCellFlash(table, null, null);
  selectedId = id;
  selectionHighlight = true;
  renderDetail(node);
  if (table !== null) {
    renderGraph();
  } else {
    applyFiltersAndSelection();
    mountCellRoutes();
  }
  hideSearchResults();
  renderStatus();
  highlightInPage(node);
  hideTip();
}

function clearSelection(): void {
  if (selectedId === null && focusScope === null && pickedCell === null) return;
  const hadFocus = focusScope !== null;
  selectedId = null;
  selectionHighlight = false;
  highlightScope = null;
  if (pickedCell !== null) {
    pickedCell = null;
    clearCellFlash();
  }
  const detail = element('map-detail');
  detail.hidden = true;
  detail.replaceChildren();
  if (hadFocus) {
    focusScope = null;
    focusOriginId = null;
    focusDirection = 'both';
    applyScopeView();
    return;
  }
  applyFiltersAndSelection();
  mountCellRoutes();
  renderStatus();
}

function hideTip(): void {
  tipKey = null;
  const tip = document.getElementById('map-tip');
  if (tip === null) return;
  tip.hidden = true;
  tip.textContent = '';
}

function tooltipEnabled(): boolean {
  return tooltipsPinned || shiftHeld;
}

function syncTipToggle(): void {
  const button = document.getElementById('map-tip-toggle');
  if (button === null) return;
  button.classList.toggle('is-on', tooltipsPinned);
  button.classList.toggle('is-held', shiftHeld);
  button.setAttribute('aria-pressed', tooltipsPinned ? 'true' : 'false');
}

function setMapShiftHeld(held: boolean): void {
  if (shiftHeld === held) return;
  shiftHeld = held;
  syncTipToggle();
  showTipAtPointer();
}

function placeTip(clientX: number, clientY: number): void {
  const tip = document.getElementById('map-tip');
  if (tip === null || tip.hidden) return;
  const canvas = element('map-canvas');
  const rect = canvas.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let left = clientX - rect.left + 14;
  let top = clientY - rect.top + 16;
  if (left + width > canvas.clientWidth - 8) {
    left = Math.max(8, clientX - rect.left - width - 14);
  }
  if (top + height > canvas.clientHeight - 8) {
    top = Math.max(8, clientY - rect.top - height - 12);
  }
  tip.style.left = `${String(Math.round(left))}px`;
  tip.style.top = `${String(Math.round(top))}px`;
}

function showTipAtPointer(): void {
  const tip = document.getElementById('map-tip');
  if (tip === null) return;
  if (!tooltipEnabled() || hoverKey === null) {
    hideTip();
    return;
  }
  if (tipKey !== hoverKey) {
    tip.textContent = hoverText;
    tipKey = hoverKey;
  }
  tip.hidden = false;
  placeTip(tipPointerX, tipPointerY);
}

function tooltipForTarget(target: EventTarget | null): { key: string; text: string } | null {
  if (!(target instanceof Element)) return null;
  const cellElement = target.closest('[data-cell-tip]');
  if (cellElement !== null) {
    const text = cellElement.getAttribute('data-cell-tip');
    if (text !== null && text !== '') {
      const owner = cellElement.closest('[data-node-id]');
      const nodeId = owner?.getAttribute('data-node-id') ?? '';
      return { key: `cell:${nodeId}:${text}`, text };
    }
  }
  const edgeElement = target.closest('[data-plan-id]');
  if (edgeElement !== null) {
    const id = edgeElement.getAttribute('data-plan-id');
    const plan = id === null ? undefined : planById.get(id);
    if (plan !== undefined && plan.tooltip !== '') {
      return { key: `plan:${plan.id}`, text: plan.tooltip };
    }
  }
  const nodeElement = target.closest('[data-node-id]');
  if (nodeElement !== null) {
    const id = nodeElement.getAttribute('data-node-id');
    const node = id === null ? undefined : model?.nodesById.get(id);
    if (node !== undefined) return { key: `node:${node.id}`, text: nodeTooltip(node) };
  }
  return null;
}

function trackHover(event: PointerEvent): void {
  tipPointerX = event.clientX;
  tipPointerY = event.clientY;
  const target = tooltipForTarget(event.target);
  if (target === null) {
    hoverKey = null;
    hoverText = '';
    hideTip();
    return;
  }
  if (hoverKey !== target.key) {
    hoverKey = target.key;
    hoverText = target.text;
    tipKey = null;
  }
  showTipAtPointer();
}

function closeNodeMenu(): void {
  menuNodeId = null;
  const menu = document.getElementById('map-menu');
  if (menu === null) return;
  menu.hidden = true;
  menu.replaceChildren();
}

function openNodeMenu(nodeId: string, clientX: number, clientY: number): void {
  const node = model?.nodesById.get(nodeId);
  if (node === undefined) return;
  closeNodeMenu();
  hideTip();
  const menu = element('map-menu');
  const addItem = (label: string, run: () => void): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      closeNodeMenu();
      run();
    });
    menu.append(button);
  };
  addItem('Ver interacciones', () => {
    focusFromNode(nodeId, 'both');
  });
  const table = tableDataOf(node);
  if (pageElementFor(node) !== null || table !== null) {
    addItem('Resaltar en la página', () => {
      if (table !== null) {
        const picked = pickedCell !== null && pickedCell.tableId === table.id ? pickedCell : null;
        if (picked !== null) {
          startCellFlash(table, picked.column, picked.rowIndex);
          highlightCell(table, picked.column, picked.rowIndex);
          renderGraph();
          return;
        }
      }
      highlightInPage(node);
    });
  }
  if (selectedId === nodeId || focusScope !== null) {
    addItem(focusScope !== null ? 'Quitar enfoque' : 'Quitar selección', () => {
      clearSelection();
    });
  }
  const canvas = element('map-canvas');
  const rect = canvas.getBoundingClientRect();
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.hidden = false;
  menuNodeId = nodeId;
  let left = clientX - rect.left;
  let top = clientY - rect.top;
  if (left + menu.offsetWidth > canvas.clientWidth - 6) {
    left = Math.max(6, left - menu.offsetWidth);
  }
  if (top + menu.offsetHeight > canvas.clientHeight - 6) {
    top = Math.max(6, top - menu.offsetHeight);
  }
  menu.style.left = `${String(Math.round(left))}px`;
  menu.style.top = `${String(Math.round(top))}px`;
}

function forwardReachable(id: string): Set<string> {
  const seen = new Set<string>([id]);
  if (model === null) return seen;
  const queue: string[] = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    for (const next of model.outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function backwardReachable(id: string): Set<string> {
  const seen = new Set<string>([id]);
  if (model === null) return seen;
  const queue: string[] = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    for (const next of model.incoming.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function involvedScope(id: string, direction: FocusDirection): Set<string> {
  const scope = forwardReachable(id);
  if (direction === 'both') {
    for (const other of backwardReachable(id)) scope.add(other);
  }
  return scope;
}

function matchesKind(node: FlowNode): boolean {
  if (kindMode === 'all' || model === null) return true;
  if (node.type === 'query') {
    return kindMode === 'read'
      ? (node.tablesRead ?? []).length > 0
      : (node.tablesWritten ?? []).length > 0;
  }
  if (node.type === 'table') return tableIndex !== null && tableIndex.of(node.id) !== null;
  if (node.type === 'database') {
    if (tableIndex === null) return true;
    for (const table of tableIndex.byId.values()) {
      if (table.databaseId === node.id) return true;
    }
    return false;
  }
  return true;
}

function edgeMatchesKind(edge: FlowEdge): boolean {
  if (kindMode === 'read') return edge.type !== 'WRITES';
  if (kindMode === 'write') return edge.type !== 'READS';
  return true;
}

function applyDisplayScope(scope: Set<string> | null): void {
  if (model === null) return;
  if (tableIndexKind !== kindMode) {
    tableIndex = buildTableIndex(model.snapshot, kindMode);
    tableIndexKind = kindMode;
  }
  const nodes = (
    scope === null
      ? model.snapshot.nodes
      : model.snapshot.nodes.filter((node) => scope.has(node.id))
  ).filter(matchesKind);
  const visible = new Set(nodes.map((node) => node.id));
  const edges = (
    scope === null
      ? model.snapshot.edges
      : model.snapshot.edges.filter((edge) => scope.has(edge.from) && scope.has(edge.to))
  ).filter((edge) => visible.has(edge.from) && visible.has(edge.to) && edgeMatchesKind(edge));
  model.viewNodes = nodes;
  model.viewEdges = edges;
  model.layout = layoutFlow({ ...model.snapshot, nodes, edges }, layoutMode, layoutOptions());
}

function hideSearchResults(): void {
  searchOpen = false;
  const box = element('map-results');
  box.hidden = true;
  box.replaceChildren();
  searchResults = [];
  searchShown = 0;
}

function focusFromNode(id: string, direction: FocusDirection = 'both'): void {
  const node = model?.nodesById.get(id);
  if (node === undefined) return;
  focusDirection = direction;
  focusScope = involvedScope(id, direction);
  focusOriginId = id;
  selectedId = id;
  selectionHighlight = false;
  eventFilter = null;
  eventOnly = false;
  syncEventOnly();
  element<HTMLSelectElement>('map-event').value = '';
  renderDetail(node);
  applyDisplayScope(focusScope);
  renderGraph();
  fitToNodes([...focusScope]);
  hideSearchResults();
  renderStatus();
  highlightInPage(node);
}

function compareSearchNodes(left: FlowNode, right: FlowNode): number {
  const typeDiff = SEARCH_TYPE_ORDER[left.type] - SEARCH_TYPE_ORDER[right.type];
  if (typeDiff !== 0) return typeDiff;
  return left.title.localeCompare(right.title, 'es');
}

function computeSearchResults(): FlowNode[] {
  const current = model;
  if (current === null || searchTerm === '') return [];
  return current.snapshot.nodes
    .filter(
      (node) =>
        matchesSearch(node) && (trafficMode === 'all' || current.runtimeReachable.has(node.id)),
    )
    .sort(compareSearchNodes);
}

function searchResultButton(node: FlowNode): HTMLDivElement {
  const button = document.createElement('div');
  button.className = 'map-result';
  button.setAttribute('role', 'button');
  button.tabIndex = 0;
  button.classList.toggle('is-selected', selectedId === node.id);
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.append(document.createTextNode(nodeTypeLabel(node)));
  if (node.file !== null) {
    const location = ` · ${truncate(node.file, 34)}${node.line === null ? '' : `:${String(node.line)}`}`;
    tag.append(codeLink(location, node.file, node.line, node.endLine));
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = truncate(node.title, 64);
  const meta = document.createElement('span');
  meta.className = 'meta';
  const bits: string[] = [];
  if (node.subtitle !== null && node.subtitle !== '') bits.push(truncate(node.subtitle, 48));
  if (node.selector !== null && node.selector !== undefined) {
    bits.push(truncate(node.selector, 40));
  }
  const events = eventSummary(node);
  if (events !== null) bits.push(events);
  meta.textContent = bits.join(' · ');
  button.append(tag, name, meta);
  button.addEventListener('click', () => {
    focusFromNode(node.id, 'forward');
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    focusFromNode(node.id, 'forward');
  });
  return button;
}

function appendSearchPage(): void {
  if (searchShown >= searchResults.length) return;
  const box = element('map-results');
  box.querySelector('.map-paged-foot')?.remove();
  const end = Math.min(searchResults.length, searchShown + PAGE_SIZE);
  for (let index = searchShown; index < end; index += 1) {
    const node = searchResults[index];
    if (node === undefined) continue;
    box.append(searchResultButton(node));
  }
  searchShown = end;
  if (searchShown < searchResults.length) {
    const foot = document.createElement('div');
    foot.className = 'map-paged-foot';
    foot.textContent = `${String(searchShown)} de ${String(searchResults.length)} · desplázate para ver más`;
    box.append(foot);
  }
}

function renderSearchResults(): void {
  const box = element('map-results');
  box.replaceChildren();
  searchResults = [];
  searchShown = 0;
  if (!searchOpen || model === null || searchTerm === '') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  searchResults = computeSearchResults();
  if (searchResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'map-result-empty';
    empty.textContent = 'Sin coincidencias en el mapa.';
    box.append(empty);
    return;
  }
  appendSearchPage();
}

function traceButton(node: FlowNode): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-trace';
  button.classList.toggle('is-selected', selectedId === node.id);
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `${nodeTypeLabel(node)} · ${truncate(node.title, 24)}`;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = truncate(node.subtitle ?? 'sin detalle', 34);
  const meta = document.createElement('span');
  meta.className = 'meta';
  const summary = eventSummary(node) ?? `${String(node.occurrences)} interacciones`;
  meta.textContent = `${summary}${node.lastSeen > 0 ? ` · ${clock(node.lastSeen)}` : ''}`;
  button.append(tag, name, meta);
  button.addEventListener('click', () => {
    focusFromNode(node.id);
  });
  return button;
}

function appendTracePage(): void {
  if (traceShown >= traceNodes.length) return;
  const list = element('map-trace-list');
  list.querySelector('.paged-foot')?.remove();
  const end = Math.min(traceNodes.length, traceShown + PAGE_SIZE);
  for (let index = traceShown; index < end; index += 1) {
    const node = traceNodes[index];
    if (node === undefined) continue;
    const button = traceButton(node);
    list.append(button);
    traceButtons.set(node.id, button);
  }
  traceShown = end;
  if (traceShown < traceNodes.length) {
    const foot = document.createElement('div');
    foot.className = 'paged-foot';
    foot.textContent = `${String(traceShown)} de ${String(traceNodes.length)} · desplázate para ver más`;
    list.append(foot);
  }
}

function renderTraces(): void {
  const list = element('map-trace-list');
  list.replaceChildren();
  traceButtons = new Map();
  traceNodes = model?.traceElements ?? [];
  traceShown = 0;
  element('map-traces-title').textContent = `Interacciones · ${String(traceNodes.length)}`;
  if (traceNodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Aún no hay interacciones en la página.';
    list.append(empty);
    return;
  }
  appendTracePage();
}

function renderStats(): void {
  syncBusy();
  const stats = element('map-stats');
  const snapshot = state.snapshot;
  if (snapshot === null) {
    stats.textContent = '';
    return;
  }
  const data = snapshot.stats;
  const structures = snapshot.nodes.filter((node) => node.type === 'structure').length;
  const assets = snapshot.nodes.filter((node) => node.type === 'asset').length;
  const parts = [
    `${String(data.interactions)} interacciones`,
    `${String(data.files)} archivos`,
    `${String(data.controls)} controles`,
    `${String(structures)} estructuras`,
    `${String(assets)} recursos CSS/JS`,
    `${String(data.forms)} formularios`,
    `${String(data.clicks)} clics`,
    `${String(data.requests)} peticiones`,
    `${String(data.routes)} rutas`,
    `${String(data.queries)} SQL`,
    `${String(data.tables)} tablas`,
    `${String(data.databases)} BD`,
  ];
  if (data.externalRequests > 0) {
    parts.push(`${String(data.externalRequests)} externas fuera del mapa`);
  }
  if (data.preflightRequests > 0) {
    parts.push(`${String(data.preflightRequests)} preflight fuera del mapa`);
  }
  stats.textContent = parts.join(' · ');
}

function renderEventFilter(): void {
  const select = element<HTMLSelectElement>('map-event');
  const counts = new Map<FlowInteractionEvent, number>();
  if (model !== null) {
    for (const node of model.snapshot.nodes) {
      if (node.type !== 'element') continue;
      for (const event of node.events ?? []) {
        if (event.count <= 0) continue;
        counts.set(event.event, (counts.get(event.event) ?? 0) + event.count);
      }
    }
  }
  if (eventFilter !== null && model !== null && !state.building && !counts.has(eventFilter)) {
    eventFilter = null;
  }
  const available = FLOW_INTERACTION_EVENTS.filter((event) => counts.has(event));
  if (eventOnly && eventFilter === null && available.length > 0) {
    eventFilter = available[0] ?? null;
  }
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos los eventos';
  select.append(all);
  for (const event of available) {
    const option = document.createElement('option');
    option.value = event;
    option.textContent = `${EVENT_LABEL[event]} (${String(counts.get(event) ?? 0)})`;
    select.append(option);
  }
  select.value = eventFilter ?? '';
  select.disabled = available.length === 0;
  syncEventOnly();
}

function addStatusBox(text: string, className: string): void {
  const box = document.createElement('div');
  box.className = className === '' ? 'box' : `box ${className}`;
  box.textContent = text;
  element('map-status').append(box);
}

function renderStatus(): void {
  const status = element('map-status');
  status.replaceChildren();
  if (!state.open) return;
  if (state.error !== null) {
    addStatusBox(`Error al construir el mapa: ${state.error}`, 'is-error');
  }
  if (layoutMode === 'structural' && !state.building) {
    addStatusBox(
      'Orden estructural: mismas columnas por categoría, filas ordenadas por archivo, línea y posición en el DOM.',
      '',
    );
  }
  if (layoutMode === 'hierarchical' && !state.building) {
    addStatusBox(
      'Orden jerárquico: cada archivo agrupa sus nodos y cada padre abre a sus hijos a izquierda y derecha; las flechas bajan por la cadena de evidencia.',
      '',
    );
  }
  const jsonCapture = jsonCaptureLiveSet ? jsonCaptureLive : (state.jsonCapture ?? null);
  if (jsonCapture !== null && jsonCapture !== undefined) {
    if (!jsonCapture.ok) {
      addStatusBox(
        `Captura JSON no disponible: ${jsonCapture.error ?? 'sin hooks utilizables'}`,
        'is-error',
      );
    } else {
      const last = jsonCapture.lastAt === null ? '' : ` · último ${clock(jsonCapture.lastAt)}`;
      addStatusBox(
        `JSON en runtime · ${jsonCapture.hooks.join(', ')} · ${String(
          jsonCapture.movements,
        )} movimientos · ${String(jsonCapture.bodies)} con cuerpo${last}`,
        '',
      );
    }
  }
  if (state.building) {
    addStatusBox(
      state.snapshot === null ? 'Indexando rutas y construyendo el mapa…' : 'Actualizando el mapa…',
      '',
    );
  }
  if (state.snapshot === null) {
    if (!state.building && state.error === null) {
      addStatusBox('Sin datos todavía.', 'is-empty');
    }
    return;
  }
  if (state.snapshot.nodes.length === 0 && !state.building) {
    addStatusBox(
      'Sin datos todavía. Interactúa con la página o espera tráfico del backend.',
      'is-empty',
    );
    return;
  }
  if (!state.building && state.snapshot.stack.backend === null) {
    addStatusBox(
      state.snapshot.stack.workspaceOpen
        ? 'Sin rutas de backend indexadas: el mapa muestra el frente y el tráfico observado.'
        : 'Sin proyecto abierto: abre la carpeta del backend en el IDE para indexar rutas, SQL y base de datos.',
      'is-empty',
    );
  }
  if (
    trafficMode === 'interacted' &&
    focusScope === null &&
    model !== null &&
    model.runtimeReachable.size === 0
  ) {
    addStatusBox(
      'Modo «Solo lo que interactuaste»: todavía no hay interacciones registradas.',
      'is-empty',
    );
  } else if (trafficMode === 'interacted' && focusScope === null && model !== null) {
    const requests = model.viewNodes.filter((node) => node.type === 'request').length;
    const routes = model.viewNodes.filter((node) => node.type === 'route').length;
    addStatusBox(
      `Modo «Solo lo que interactuaste»: ${String(model.viewNodes.length)} nodos · ${String(
        requests,
      )} peticiones · ${String(routes)} rutas · el resto oculto.`,
      '',
    );
  }
  if (eventOnly && model !== null && eventFilter === null) {
    addStatusBox(
      '«Solo esos» esperando un evento: todavía no hay eventos registrados en la página.',
      'is-empty',
    );
  }
  if (focusScope !== null && focusOriginId !== null && model !== null) {
    const origin = model.nodesById.get(focusOriginId);
    const box = document.createElement('div');
    box.className = 'box';
    const text = document.createElement('span');
    const routeCount = model.viewNodes.filter((node) => node.type === 'route').length;
    const label =
      origin === undefined ? '' : `${nodeTypeLabel(origin)} «${truncate(origin.title, 40)}»`;
    text.textContent = `Enfoque: ${label} · ${String(routeCount)} rutas · ${String(
      model.viewNodes.length,
    )} nodos visibles`;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'action';
    action.textContent = 'Quitar enfoque';
    action.addEventListener('click', () => {
      clearSelection();
    });
    box.append(text, action);
    status.append(box);
  }
}

function setOpenUi(open: boolean): void {
  const map = document.getElementById('map');
  if (map !== null) map.hidden = !open;
  document.body.classList.toggle('map-open', open);
  const toggle = document.getElementById('map-toggle');
  if (toggle === null) return;
  toggle.textContent = open ? 'Volver' : 'Mapa';
  toggle.classList.toggle('is-on', open);
  toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
}

function resetViewOnOpen(): void {
  hideTip();
  closeNodeMenu();
  tooltipsPinned = false;
  shiftHeld = false;
  syncTipToggle();
  selectedId = null;
  selectionHighlight = false;
  highlightScope = null;
  eventFilter = null;
  eventOnly = false;
  syncEventOnly();
  focusScope = null;
  focusOriginId = null;
  focusDirection = 'both';
  trafficMode = 'interacted';
  syncTrafficButtons();
  kindMode = 'all';
  syncKindButtons();
  pickedCell = null;
  clearCellFlash();
  searchTerm = '';
  element<HTMLInputElement>('map-search').value = '';
  hideSearchResults();
  viewReady = false;
  const detail = element('map-detail');
  detail.hidden = true;
  detail.replaceChildren();
}

interface StackStage {
  tech: string;
  meta: string;
  title: string;
  types: FlowNodeType[];
  missing: boolean;
  runtime: boolean;
}

function stackStages(snapshot: FlowSnapshot): StackStage[] {
  const counts: Record<FlowNodeType, number> = {
    file: 0,
    structure: 0,
    asset: 0,
    element: 0,
    handler: 0,
    request: 0,
    route: 0,
    function: 0,
    query: 0,
    table: 0,
    database: 0,
  };
  for (const node of snapshot.nodes) {
    counts[node.type] += 1;
  }
  const stack = snapshot.stack;
  const interactions = snapshot.stats.interactions;
  const observedSql = snapshot.nodes.some(
    (node) => node.type === 'query' && node.evidence.includes('RUNTIME'),
  );
  const pageMeta = `${String(snapshot.stats.controls)} controles · ${String(
    snapshot.stats.forms,
  )} formularios${interactions === 0 ? '' : ` · ${String(interactions)} interacciones`}`;
  return [
    {
      tech: 'HTML',
      meta: pageMeta,
      title: 'Página HTML inspeccionada',
      types: ['structure', 'asset', 'element'],
      missing: false,
      runtime: interactions > 0,
    },
    {
      tech: stack.frontend?.label ?? 'Frontend',
      meta:
        stack.frontend === null
          ? counts.handler === 0
            ? 'sin framework detectado'
            : `${String(counts.handler)} handlers`
          : `detectado · ${String(counts.handler)} handlers`,
      title:
        stack.frontend === null
          ? 'No se detectó React, Vue, Angular, Svelte, Astro, Solid, Remix, Next.js ni Nuxt en la página.'
          : `${stack.frontend.label} · ${stack.frontend.detail}`,
      types: ['handler'],
      missing: stack.frontend === null && counts.handler === 0,
      runtime: counts.handler > 0,
    },
    {
      tech: stack.backend?.label ?? 'Backend',
      meta:
        stack.backend === null
          ? stack.workspaceOpen
            ? 'sin rutas indexadas'
            : 'sin proyecto abierto'
          : `${String(counts.route)} rutas · ${String(counts.function)} funciones`,
      title:
        stack.backend === null
          ? stack.workspaceOpen
            ? 'El proyecto abierto no tiene rutas Express, Fastify, FastAPI o Flask indexadas.'
            : 'Abre la carpeta del backend en el IDE para indexar rutas, SQL y base de datos.'
          : `${stack.backend.label} · ${stack.backend.detail}`,
      types: ['route', 'function'],
      missing: stack.backend === null,
      runtime: counts.request > 0,
    },
    {
      tech: stack.database?.label ?? 'Base de datos',
      meta:
        stack.database === null
          ? counts.query === 0
            ? 'sin SQL detectado'
            : 'motor no detectado'
          : `${String(counts.query)} SQL · ${String(counts.table)} tablas`,
      title:
        stack.database === null
          ? 'No se detectó motor ni dialecto SQL en el código indexado.'
          : `${stack.database.label} · ${stack.database.detail}`,
      types: ['query', 'table', 'database'],
      missing: stack.database === null,
      runtime: observedSql,
    },
  ];
}

function focusStage(types: readonly FlowNodeType[]): void {
  if (model === null) return;
  const ids = model.snapshot.nodes
    .filter((node) => types.includes(node.type))
    .map((node) => node.id);
  if (ids.length === 0) return;
  clearSelection();
  fitToNodes(ids);
}

function renderStack(): void {
  const container = element('map-stack');
  container.replaceChildren();
  const snapshot = state.snapshot;
  if (snapshot === null || !state.open) return;

  const stages = stackStages(snapshot);
  const linkOn = [
    snapshot.stats.interactions > 0,
    snapshot.stats.requests > 0,
    snapshot.nodes.some((node) => node.type === 'query' && node.evidence.includes('RUNTIME')),
  ];
  const linkText: Array<[string, string]> = [
    ['Interacción registrada en la página', 'Sin interacciones todavía'],
    ['Petición HTTP observada del frontend al backend', 'Sin peticiones de backend en el mapa'],
    ['Consulta SQL observada durante la petición', 'SQL solo estático o sin observación'],
  ];

  let hint = '';
  if (!snapshot.stack.workspaceOpen) {
    hint = 'Abre la carpeta del backend para completar la cadena';
  } else if (snapshot.stack.backend === null) {
    hint = 'Sin rutas de backend indexadas';
  } else if (snapshot.stack.database === null) {
    hint = 'Sin base de datos detectada en el código';
  } else if (!linkOn[1]) {
    hint = 'Interactúa con la página para seguir el dato';
  }

  stages.forEach((stage, index) => {
    const enabled = snapshot.nodes.some((node) => stage.types.includes(node.type));
    const actionable = enabled && !stage.missing;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stack-node';
    button.classList.toggle('is-missing', stage.missing);
    button.classList.toggle('is-runtime', stage.runtime && !stage.missing);
    button.disabled = !actionable;
    button.title = stage.title;
    const tech = document.createElement('span');
    tech.className = 'tech';
    tech.textContent = stage.tech;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = stage.meta;
    button.append(tech, meta);
    if (actionable) {
      button.addEventListener('click', () => {
        focusStage(stage.types);
      });
    }
    container.append(button);

    if (index < stages.length - 1) {
      const on = linkOn[index] === true;
      const arrow = document.createElement('span');
      arrow.className = on ? 'stack-arrow is-on' : 'stack-arrow';
      arrow.textContent = '→';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.title = on ? (linkText[index]?.[0] ?? '') : (linkText[index]?.[1] ?? '');
      container.append(arrow);
    }
  });

  if (hint !== '') {
    const note = document.createElement('span');
    note.className = 'stack-hint';
    note.textContent = hint;
    container.append(note);
  }
}

function applyFlowMapState(next: FlowMapState): void {
  const opening = next.open && !state.open;
  state = next;
  setOpenUi(state.open);
  if (!state.open) {
    endColumnResize();
    hideTip();
    closeNodeMenu();
    renderStats();
    renderStatus();
    return;
  }
  if (opening) {
    resetViewOnOpen();
  }
  const snapshot = state.snapshot;
  if (snapshot === null) {
    model = null;
    jsonOwnerCache = new Map();
    jsonMovementOwnerIndex = new Map();
    jsonFunctionsByFile = new Map();
    jsonRequests = [];
    jsonRoutes = [];
    nodeViews = new Map();
    edgeViews = new Map();
    edgePlans = [];
    filterVisibility = new Map();
    planGrid = new Map();
    nodeGrid = new Map();
    strokeZoom = 0;
    viewport = null;
    branchLayer = null;
    trunkLayer = null;
    nodeLayer = null;
    cellRouteLayer = null;
    if (pickedCell !== null) {
      pickedCell = null;
      clearCellFlash();
    }
    if (viewportFrame !== 0) {
      cancelAnimationFrame(viewportFrame);
      viewportFrame = 0;
    }
    hideTip();
    closeNodeMenu();
    svgById('map-svg').replaceChildren();
    renderAxis();
    if (selectedId !== null || focusScope !== null) {
      selectedId = null;
      selectionHighlight = false;
      highlightScope = null;
      focusScope = null;
      focusOriginId = null;
      focusDirection = 'both';
      const detail = element('map-detail');
      detail.hidden = true;
      detail.replaceChildren();
    }
    renderEventFilter();
    renderSearchResults();
    renderTraces();
    renderStack();
  } else {
    const changed = model === null || model.snapshot.revision !== snapshot.revision || opening;
    if (changed) {
      prepare(snapshot);
      if (pickedCell !== null) {
        const pickedTable = tableIndex === null ? null : tableIndex.of(pickedCell.tableId);
        const rowMissing =
          pickedCell.rowIndex !== null &&
          (pickedTable === null || pickedTable.grid.rows[pickedCell.rowIndex] === undefined);
        if (pickedTable === null || rowMissing) {
          pickedCell = null;
          clearCellFlash();
        }
      }
      if (focusOriginId !== null) {
        if (model?.nodesById.has(focusOriginId) === true) {
          focusScope = involvedScope(focusOriginId, focusDirection);
        } else {
          focusScope = null;
          focusOriginId = null;
          focusDirection = 'both';
        }
      }
      renderEventFilter();
      const viewScope = scopeForView();
      applyDisplayScope(viewScope);
      renderSearchResults();
      renderGraph();
      if (focusScope !== null || eventOnly) {
        const fitScope = scopeForView();
        if (fitScope === null) {
          fitView();
        } else {
          fitToNodes([...fitScope]);
        }
      }
      renderTraces();
      renderStack();
      if (selectedId !== null) {
        const node = model?.nodesById.get(selectedId);
        if (node === undefined) {
          clearSelection();
        } else {
          renderDetail(node);
        }
      }
    }
  }
  renderStats();
  renderStatus();
  if (state.open) syncJsonRail();
}

function initFlowMap(): void {
  if (initialized) return;
  initialized = true;
  const svg = svgById('map-svg');
  const search = element<HTMLInputElement>('map-search');
  const results = element('map-results');
  const traces = element('map-traces');
  const eventSelect = element<HTMLSelectElement>('map-event');

  const toggle = document.getElementById('map-toggle');
  if (toggle !== null) {
    toggle.addEventListener('click', () => {
      ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, !state.open);
    });
  }
  const modeButton = document.getElementById('map-mode');
  if (modeButton !== null) {
    modeButton.addEventListener('click', () => {
      ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, true);
    });
  }
  const pageButton = document.getElementById('map-page');
  if (pageButton !== null) {
    pageButton.addEventListener('click', () => {
      ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, false);
    });
  }
  resizeObserver = new ResizeObserver(() => {
    scheduleViewportUpdate();
  });
  resizeObserver.observe(svg);
  element<HTMLButtonElement>('map-fit').addEventListener('click', () => {
    if (focusScope !== null) {
      fitToNodes([...focusScope]);
    } else {
      fitView();
    }
  });
  element<HTMLButtonElement>('map-zoom-in').addEventListener('click', () => {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 1.2);
  });
  element<HTMLButtonElement>('map-zoom-out').addEventListener('click', () => {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 1 / 1.2);
  });
  const tipToggle = document.getElementById('map-tip-toggle');
  if (tipToggle !== null) {
    tipToggle.addEventListener('click', () => {
      tooltipsPinned = !tooltipsPinned;
      syncTipToggle();
      showTipAtPointer();
    });
  }
  syncTipToggle();
  element<HTMLButtonElement>('map-scope-all').addEventListener('click', () => {
    setTrafficMode('all');
  });
  element<HTMLButtonElement>('map-scope-interacted').addEventListener('click', () => {
    setTrafficMode('interacted');
  });
  element<HTMLButtonElement>('map-kind-all').addEventListener('click', () => {
    setKindMode('all');
  });
  element<HTMLButtonElement>('map-kind-read').addEventListener('click', () => {
    setKindMode('read');
  });
  element<HTMLButtonElement>('map-kind-write').addEventListener('click', () => {
    setKindMode('write');
  });
  syncKindButtons();
  element<HTMLButtonElement>('map-order-chrono').addEventListener('click', () => {
    setLayoutMode('chronological');
  });
  element<HTMLButtonElement>('map-order-structural').addEventListener('click', () => {
    setLayoutMode('structural');
  });
  element<HTMLButtonElement>('map-order-hierarchy').addEventListener('click', () => {
    setLayoutMode('hierarchical');
  });
  syncOrderButtons();
  const compactBox = element<HTMLInputElement>('map-compact');
  compactBox.addEventListener('change', () => {
    setCompactMode(compactBox.checked);
  });
  syncCompact();

  search.addEventListener('input', () => {
    searchTerm = normalizeSearchText(search.value.trim());
    searchOpen = true;
    renderSearchResults();
    applyFiltersAndSelection();
  });
  search.addEventListener('focus', () => {
    if (searchTerm === '') return;
    searchOpen = true;
    renderSearchResults();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const first = searchResults[0];
    if (first === undefined) return;
    event.preventDefault();
    focusFromNode(first.id, 'forward');
  });
  results.addEventListener('scroll', () => {
    if (results.scrollTop + results.clientHeight >= results.scrollHeight - 32) {
      appendSearchPage();
    }
  });
  traces.addEventListener('scroll', () => {
    if (traces.scrollTop + traces.clientHeight >= traces.scrollHeight - 32) {
      appendTracePage();
    }
  });
  eventSelect.addEventListener('change', () => {
    eventFilter = asEvent(eventSelect.value);
    if (eventFilter === null) {
      if (!eventOnly) {
        syncEventOnly();
        applyFiltersAndSelection();
        return;
      }
      eventOnly = false;
      syncEventOnly();
      scheduleScopeApply();
      return;
    }
    if (eventOnly) {
      scheduleScopeApply();
      return;
    }
    applyFiltersAndSelection();
  });
  const eventOnlyBox = document.getElementById('map-event-only');
  if (eventOnlyBox instanceof HTMLInputElement) {
    eventOnlyBox.addEventListener('change', () => {
      eventOnly = eventOnlyBox.checked;
      if (eventOnly) {
        focusScope = null;
        focusOriginId = null;
        focusDirection = 'both';
        hideSearchResults();
        if (eventFilter === null) {
          const chosen = Array.from(eventSelect.options).find((option) => option.value !== '');
          if (chosen !== undefined) {
            eventFilter = asEvent(chosen.value);
            eventSelect.value = chosen.value;
          }
        }
      }
      syncEventOnly();
      scheduleScopeApply();
      renderStatus();
    });
  }

  svg.addEventListener(
    'wheel',
    (event) => {
      if (!state.open) return;
      event.preventDefault();
      closeNodeMenu();
      hideTip();
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      zoomAt(px, py, Math.exp(-event.deltaY * 0.0015));
    },
    { passive: false },
  );
  svg.addEventListener('pointermove', (event) => {
    if (!state.open || pan !== null || columnResize !== null) return;
    trackHover(event);
  });
  svg.addEventListener('pointerleave', () => {
    hoverKey = null;
    hoverText = '';
    hideTip();
  });
  svg.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    closeNodeMenu();
  });
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (menuNodeId === null) return;
      const target = event.target;
      if (target instanceof Element && target.closest('#map-menu') !== null) return;
      closeNodeMenu();
    },
    true,
  );

  svg.addEventListener('pointerdown', (event) => {
    if (!state.open || event.button !== 0) return;
    hideSearchResults();
    hideTip();
    const target = event.target;
    if (target instanceof Element && target.closest('.flow-node') !== null) return;
    pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: view.x,
      viewY: view.y,
      moved: false,
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('is-panning');
  });

  svg.addEventListener('pointermove', (event) => {
    if (pan === null || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
    view = { ...view, x: pan.viewX + dx, y: pan.viewY + dy };
    viewReady = true;
    applyView();
  });

  const endPan = (event: PointerEvent): void => {
    if (pan === null || pan.pointerId !== event.pointerId) return;
    const moved = pan.moved;
    pan = null;
    svg.classList.remove('is-panning');
    if (svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
    if (!moved && focusScope === null) clearSelection();
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  window.addEventListener('keydown', (event) => {
    if (!state.open) return;
    if (event.key === 'Shift') {
      setMapShiftHeld(true);
      return;
    }
    if (event.key !== 'Escape') return;
    if (menuNodeId !== null) {
      closeNodeMenu();
      return;
    }
    if (!results.hidden) {
      hideSearchResults();
      return;
    }
    ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, false);
  });
  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Shift') return;
    setMapShiftHeld(false);
  });
  window.addEventListener('blur', () => {
    setMapShiftHeld(false);
    closeNodeMenu();
  });
}

export { applyFlowJsonState, applyFlowMapState, initFlowMap, setFlowCardRequests, setMapShiftHeld };
