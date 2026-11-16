import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  ERROR_CODES,
  FLOW_INTERACTION_EVENTS,
  IPC_CHANNELS,
  handlerLabel,
  handlerProfileTags,
  normalizeSearchText,
  reasonPhrase,
  requestStatusView,
  type CapturedBody,
  type FileContent,
  type FileSaveResult,
  type FlowEdge,
  type FlowElementKind,
  type FlowInteractionEvent,
  type FlowJsonCaptureState,
  type FlowJsonMovement,
  type FlowJsonState,
  type FlowMapState,
  type FlowNode,
  type FlowNodeType,
  type FlowNodeWeight,
  type FlowRequestDetail,
  type FlowRequestState,
  type FlowSnapshot,
  type IpcResult,
  type RequestStatusView,
} from '@bdt/protocol';
import {
  FLOW_MARGIN,
  FLOW_NODE_COMPACT_HEIGHT,
  FLOW_NODE_HEIGHT,
  LAYER_GAP,
  isFrontendLayerType,
  layoutFlow,
  type FlowLayerInfo,
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
const MIDDLEWARE_MIN_WIDTH = 320;
const MIDDLEWARE_MAX_WIDTH = 500;
const MIDDLEWARE_INSET = 40;
const MIDDLEWARE_SIDE_WIDTH = 400;
const MIDDLEWARE_SIDE_MIN = 280;
const MIDDLEWARE_SIDE_GAP = 32;
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
const CODE_LINE_HEIGHT = 13;
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
  middleware: MiddlewareBand | null;
  baseHeight: number;
}

interface MiddlewareBand {
  x: number;
  width: number;
  gapStart: number;
  gapEnd: number;
  sideWidth: number;
}

interface MiddlewareRow {
  key: string;
  movement: FlowJsonMovement | null;
  frontend: FlowNode | null;
  backend: FlowNode | null;
  detail: FlowRequestDetail | null;
  detailCount: number;
  detailHeuristic: boolean;
}

interface MiddlewareRowView {
  row: MiddlewareRow;
  left: HTMLElement | null;
  center: HTMLElement | null;
  right: HTMLElement | null;
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

interface NodeView {
  node: FlowNode;
  group: SVGGElement;
  card: HTMLElement | null;
  cardKey: string;
}

interface CodeBuffer {
  path: string;
  text: string;
  baseText: string;
  baseMtimeMs: number;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  conflict: boolean;
}

interface CodeFocus {
  path: string;
  start: number;
  end: number;
  top: number;
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
let searchTerm = '';
let trafficMode: TrafficMode = 'interacted';
let layoutMode: FlowLayoutMode = 'chronological';
let compactMode = true;
const columnWidths = new Map<FlowNodeType, number>();
const expandedNodes = new Set<string>();
const expandedHeights = new Map<string, number>();
const sectionExpanded = new Set<string>();
const codeBuffers = new Map<string, CodeBuffer>();
const codeReveal = new Map<string, number>();
let ctrlPending = false;
let cardHeightPass = false;
let middlewareSignature = '';
let eventFilter: FlowInteractionEvent | null = null;
let eventOnly = false;
let statusFilter: string | null = null;
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
let middlewareLinkLayer: SVGGElement | null = null;
let axisEntries: Array<{ el: HTMLElement; x: number | null; width: number | null }> = [];
let axisGrips: Array<{ el: HTMLElement; x: number }> = [];
let columnResize: { type: FlowNodeType; startClientX: number; startWidth: number } | null = null;
let columnFrame = 0;
const AXIS_HEIGHT = 22;
let edgePlans: EdgePlan[] = [];
let planById = new Map<string, EdgePlan>();
let respondedScope = new Set<string>();
let nodeViews = new Map<string, NodeView>();
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
let shiftHeld = false;
let tipFrozen = false;
let tipSignature = '';
let hoverCardId: string | null = null;
let hoverProvider: (() => InfoCardModel | null) | null = null;
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

const STATUS_CATEGORY_ORDER = ['2', '3', '4', '5', 'other'] as const;
type StatusCategory = (typeof STATUS_CATEGORY_ORDER)[number];

const STATUS_CATEGORY_LABEL: Record<StatusCategory, string> = {
  '2': '2xx · Correctas',
  '3': '3xx · Redirecciones',
  '4': '4xx · Error del cliente',
  '5': '5xx · Error del servidor',
  other: 'Otros estados',
};

function statusCategoryOf(code: number): StatusCategory {
  const category = String(Math.floor(code / 100));
  return category === '2' || category === '3' || category === '4' || category === '5'
    ? category
    : 'other';
}

function statusCategoryKey(category: StatusCategory): string {
  return category === 'other' ? 'cat:other' : `cat:${category}xx`;
}

// Las claves del filtro son exactamente lo que el nodo ya enseña: código, categoría,
// pendiente, sin respuesta o sin estado. No se inventa un estado que el snapshot no trae.
function statusFilterKeys(node: FlowNode): string[] {
  const status = requestStatus(node);
  if (status === null) return [];
  if (status.kind === 'network-error') return ['err'];
  if (status.kind === 'pending') return ['pending'];
  const code = node.statusCode;
  if (code === null || code === undefined) return ['none'];
  return [statusCategoryKey(statusCategoryOf(code)), `code:${String(code)}`];
}

function statusKeyCategory(key: string): StatusCategory | 'special' | null {
  if (key === 'err' || key === 'pending' || key === 'none') return 'special';
  if (key.startsWith('cat:')) {
    const raw = key.slice(4);
    if (raw === 'other') return 'other';
    const digit = raw.slice(0, 1);
    return digit === '2' || digit === '3' || digit === '4' || digit === '5' ? digit : null;
  }
  if (key.startsWith('code:')) {
    const code = Number(key.slice(5));
    return Number.isFinite(code) ? statusCategoryOf(code) : null;
  }
  return null;
}

function statusKeyLabel(key: string): string {
  if (key === 'err') return 'ERR · sin respuesta';
  if (key === 'pending') return '··· · pendiente';
  if (key === 'none') return '— · sin estado';
  if (key.startsWith('cat:')) {
    const raw = key.slice(4);
    return raw === 'other' ? 'Otros · todas' : `${raw} · todas`;
  }
  const code = Number(key.slice(5));
  return Number.isFinite(code) ? `${String(code)} ${reasonPhrase(code)}` : key;
}

function statusMatchCount(key: string): number {
  if (model === null) return 0;
  let total = 0;
  for (const node of model.snapshot.nodes) {
    if (statusFilterKeys(node).includes(key)) total += 1;
  }
  return total;
}

function eventSummary(node: FlowNode): string | null {
  const events = node.events ?? [];
  if (events.length === 0) return null;
  return [...events]
    .sort((left, right) => right.count - left.count)
    .map((event) => `${eventLabel(event.event)} ×${String(event.count)}`)
    .join(' · ');
}

type InfoTone = 'neutral' | 'request' | 'response' | 'ok' | 'warn' | 'error';

interface InfoRow {
  label: string;
  value: string;
  file: string | null;
  line: number | null;
  endLine: number | null;
}

interface InfoSectionEditor {
  path: string;
  value: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  conflict: boolean;
  onInput: (value: string) => void;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onMount?: (editor: HTMLTextAreaElement) => void;
}

interface InfoSection {
  id: string;
  label: string;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  editable?: InfoSectionEditor;
}

interface InfoCardExpansion {
  expanded: boolean;
  onToggle: () => void;
}

interface InfoCardModel {
  id: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  status: string;
  meta: string;
  tone: InfoTone;
  chips: readonly string[];
  rows: readonly InfoRow[];
  sections: readonly InfoSection[];
  location: InfoRow | null;
  footer: { label: string; onClick: () => void } | null;
  expansion: InfoCardExpansion | null;
}

interface InfoCardOptions {
  variant: 'tip' | 'rail' | 'middleware' | 'detail' | 'node';
  rows: 'all' | 'body';
  className?: string;
  collapsed?: boolean;
}

interface InfoCardInput {
  id: string;
  eyebrow: string;
  title: string;
  subtitle?: string;
  status?: string;
  meta?: string;
  tone?: InfoTone;
  chips?: readonly string[];
  rows?: readonly InfoRow[];
  sections?: readonly InfoSection[];
  location?: InfoRow | null;
  footer?: { label: string; onClick: () => void } | null;
  expansion?: InfoCardExpansion | null;
}

// Única puerta de entrada a una tarjeta: todas las superficies (tooltip, raíl,
// middleware, detalle, celdas, etapas y corredores) comparten estas propiedades.
function infoCard(input: InfoCardInput): InfoCardModel {
  return {
    id: input.id,
    eyebrow: input.eyebrow,
    title: input.title,
    subtitle: input.subtitle ?? '',
    status: input.status ?? '',
    meta: input.meta ?? '',
    tone: input.tone ?? 'neutral',
    chips: input.chips ?? [],
    rows: input.rows ?? [],
    sections: input.sections ?? [],
    location: input.location ?? null,
    footer: input.footer ?? null,
    expansion: input.expansion ?? null,
  };
}

const JSON_DIRECTION_LABEL: Record<FlowJsonMovement['direction'], string> = {
  in: 'entrada',
  out: 'salida',
  internal: 'interno',
};

function infoRow(
  label: string,
  value: string | null | undefined,
  file: string | null = null,
  line: number | null = null,
  endLine: number | null = null,
): InfoRow | null {
  if (value === null || value === undefined || value === '') return null;
  return { label, value, file, line, endLine };
}

function pushInfoRow(
  rows: InfoRow[],
  label: string,
  value: string | null | undefined,
  file: string | null = null,
  line: number | null = null,
  endLine: number | null = null,
): void {
  const row = infoRow(label, value, file, line, endLine);
  if (row !== null) rows.push(row);
}

function toneFromStatus(tone: RequestStatusView['tone']): InfoTone {
  if (tone === 'ok') return 'ok';
  if (tone === 'warning' || tone === 'pending') return 'warn';
  if (tone === 'error') return 'error';
  return 'neutral';
}

function jsonBodySection(movement: FlowJsonMovement, text: string): InfoSection {
  const key = `json:${movement.id}`;
  return {
    id: key,
    label: `Cuerpo JSON · ${JSON_KIND_LABEL[movement.kind]} · ${clock(movement.at)}`,
    text,
    expanded: sectionExpanded.has(key),
    onToggle: () => {
      toggleSection(key);
    },
  };
}

function cardForJsonMovement(movement: FlowJsonMovement): InfoCardModel {
  const formatted = movement.body === null ? null : formatJsonBody(movement);
  const rows: InfoRow[] = [];
  pushInfoRow(rows, 'Hora', clock(movement.at));
  pushInfoRow(rows, 'Dirección', JSON_DIRECTION_LABEL[movement.direction]);
  if (movement.method !== null || movement.path !== null) {
    pushInfoRow(rows, 'Camino', [movement.method ?? '', movement.path ?? ''].join(' ').trim());
  }
  pushInfoRow(rows, 'Estado', movement.status === null ? null : String(movement.status));
  pushInfoRow(rows, 'Repeticiones', movement.count > 1 ? String(movement.count) : null);
  const owner = jsonOwnerNode(movement);
  pushInfoRow(rows, 'Asociado', owner === null ? null : `${nodeTypeLabel(owner)} · ${owner.title}`);
  pushInfoRow(
    rows,
    'Cuerpo',
    formatted === null
      ? movement.body === null
        ? 'sin cuerpo visible'
        : 'oculto para la celda elegida'
      : jsonBodySummary(formatted.text, textBytes(movement.body ?? formatted.text)),
  );
  if (movement.truncated) pushInfoRow(rows, 'Aviso', 'El capturador recortó este cuerpo.');
  const where = movement.file === null ? null : movement.file;
  return infoCard({
    id: `json:${movement.id}`,
    eyebrow: `JSON · ${JSON_KIND_LABEL[movement.kind]}`,
    title:
      movement.method !== null && movement.path !== null
        ? `${movement.method} ${movement.path}`
        : (movement.file ?? 'Movimiento JSON'),
    subtitle: `${JSON_DIRECTION_LABEL[movement.direction]} · ${clock(movement.at)}${
      movement.count > 1 ? ` · ${String(movement.count)} apariciones` : ''
    }`,
    status: movement.status === null ? '' : String(movement.status),
    tone:
      movement.kind === 'response'
        ? 'response'
        : movement.kind === 'request'
          ? 'request'
          : 'neutral',
    chips: movement.truncated ? ['RECORTADO'] : [],
    rows,
    sections:
      formatted !== null && movement.body !== null
        ? [jsonBodySection(movement, formatted.text)]
        : [],
    location:
      where === null
        ? null
        : {
            label: 'Ubicación',
            value: movement.line > 0 ? `${where}:${String(movement.line)}` : where,
            file: where,
            line: movement.line > 0 ? movement.line : null,
            endLine: null,
          },
    footer:
      owner === null
        ? null
        : {
            label: `Enfocar ${nodeTypeLabel(owner)} · ${owner.title}`,
            onClick: () => {
              selectNode(owner.id);
              fitToNodes([owner.id]);
            },
          },
  });
}

function dirtyCodePaths(): string[] {
  return [...codeBuffers.values()].filter((buffer) => buffer.dirty).map((buffer) => buffer.path);
}

function pushCodeDirty(): void {
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.mapDirty, { paths: dirtyCodePaths() });
}

function captureCodeFocus(): CodeFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !active.classList.contains('info-editor')) {
    return null;
  }
  const path = active.dataset.codePath;
  if (path === undefined) return null;
  return { path, start: active.selectionStart, end: active.selectionEnd, top: active.scrollTop };
}

function restoreCodeFocus(focus: CodeFocus | null): void {
  if (focus === null) return;
  for (const editor of Array.from(document.querySelectorAll('textarea.info-editor'))) {
    if (!(editor instanceof HTMLTextAreaElement) || editor.dataset.codePath !== focus.path)
      continue;
    editor.focus();
    editor.setSelectionRange(focus.start, focus.end);
    editor.scrollTop = focus.top;
    return;
  }
}

// Repintar las tarjetas sustituye el textarea: se conserva el foco y el cursor para que
// escribir no se interrumpa cuando llega evidencia nueva o se guarda.
function refreshCodeSurfaces(): void {
  const focus = captureCodeFocus();
  refreshNodeCards();
  if (selectedId !== null && model !== null) {
    const node = model.nodesById.get(selectedId);
    if (node !== undefined) renderDetail(node);
  }
  refreshFrozenTip();
  renderStatus();
  restoreCodeFocus(focus);
}

async function loadCodeBuffer(path: string, revealLine: number | null): Promise<void> {
  const existing = codeBuffers.get(path);
  if (existing !== undefined && (existing.loading || existing.error === null)) return;
  const buffer: CodeBuffer = existing ?? {
    path,
    text: '',
    baseText: '',
    baseMtimeMs: 0,
    dirty: false,
    loading: true,
    error: null,
    conflict: false,
  };
  buffer.loading = true;
  buffer.error = null;
  codeBuffers.set(path, buffer);
  refreshCodeSurfaces();
  const result = (await ipcRenderer.invoke(IPC_CHANNELS.readFile, {
    path,
  })) as IpcResult<FileContent>;
  buffer.loading = false;
  if (!result.ok) {
    buffer.error = result.error.message;
    refreshCodeSurfaces();
    return;
  }
  buffer.text = result.value.content;
  buffer.baseText = result.value.content;
  buffer.baseMtimeMs = result.value.mtimeMs;
  buffer.dirty = false;
  buffer.conflict = false;
  if (revealLine !== null && revealLine > 0) codeReveal.set(path, revealLine);
  refreshCodeSurfaces();
}

async function saveCodeBuffer(path: string, force = false): Promise<boolean> {
  const buffer = codeBuffers.get(path);
  if (buffer === undefined || buffer.loading) return false;
  if (buffer.conflict && !force) return false;
  if (!buffer.dirty && !force) return true;
  const result = (await ipcRenderer.invoke(IPC_CHANNELS.saveFile, {
    path,
    content: buffer.text,
    baseMtimeMs: buffer.baseMtimeMs,
  })) as IpcResult<FileSaveResult>;
  if (!result.ok) {
    buffer.conflict = result.error.code === ERROR_CODES.FILE_CONFLICT;
    buffer.error = buffer.conflict
      ? 'El archivo cambió en disco. Recarga o guarda encima.'
      : result.error.message;
    refreshCodeSurfaces();
    return false;
  }
  buffer.baseMtimeMs = result.value.mtimeMs;
  buffer.baseText = buffer.text;
  buffer.dirty = false;
  buffer.conflict = false;
  buffer.error = null;
  pushCodeDirty();
  refreshCodeSurfaces();
  return true;
}

async function overwriteCodeBuffer(path: string): Promise<boolean> {
  const buffer = codeBuffers.get(path);
  if (buffer === undefined) return false;
  const result = (await ipcRenderer.invoke(IPC_CHANNELS.readFile, {
    path,
  })) as IpcResult<FileContent>;
  if (!result.ok) {
    buffer.error = result.error.message;
    refreshCodeSurfaces();
    return false;
  }
  buffer.baseMtimeMs = result.value.mtimeMs;
  buffer.conflict = false;
  buffer.error = null;
  return saveCodeBuffer(path, true);
}

async function reloadCodeBuffer(path: string): Promise<void> {
  codeBuffers.delete(path);
  pushCodeDirty();
  await loadCodeBuffer(path, null);
}

async function saveAllCodeBuffers(): Promise<boolean> {
  for (const path of dirtyCodePaths()) {
    const saved = await saveCodeBuffer(path);
    if (!saved) return false;
  }
  return true;
}

function saveCodeFromKeyboard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.classList.contains('info-editor')) {
    const path = active.dataset.codePath;
    if (path !== undefined) {
      void saveCodeBuffer(path);
      return;
    }
  }
  if (dirtyCodePaths().length === 0) return;
  void saveAllCodeBuffers();
}

function codeSectionFor(node: FlowNode): InfoSection | null {
  const path = node.file;
  if (path === null) return null;
  const key = `code:${node.id}`;
  const expanded = sectionExpanded.has(key);
  const buffer = codeBuffers.get(path) ?? null;
  const range =
    node.line === null
      ? ''
      : ` (líneas ${String(node.line)}${node.endLine === null ? '' : `–${String(node.endLine)}`})`;
  const editable: InfoSectionEditor = {
    path,
    value: buffer?.text ?? '',
    dirty: buffer?.dirty ?? false,
    loading: buffer === null || buffer.loading,
    error: buffer?.error ?? null,
    conflict: buffer?.conflict ?? false,
    onInput: (value) => {
      if (buffer === null) return;
      const before = buffer.dirty;
      buffer.text = value;
      buffer.dirty = value !== buffer.baseText;
      editable.dirty = buffer.dirty;
      if (before === buffer.dirty) return;
      pushCodeDirty();
      renderStatus();
    },
    onSave: () => {
      void saveCodeBuffer(path);
    },
    onReload: () => {
      void reloadCodeBuffer(path);
    },
    onOverwrite: () => {
      void overwriteCodeBuffer(path);
    },
    onMount: (editor) => {
      const reveal = codeReveal.get(path);
      if (reveal === undefined) return;
      codeReveal.delete(path);
      editor.scrollTop = Math.max(0, (reveal - 3) * CODE_LINE_HEIGHT);
    },
  };
  return {
    id: key,
    label: `Código · ${path}${range}`,
    text: '',
    expanded,
    onToggle: () => {
      toggleSection(key);
      if (!sectionExpanded.has(key)) return;
      void loadCodeBuffer(path, node.line);
    },
    editable,
  };
}

function cardForNode(node: FlowNode): InfoCardModel {
  const rows: InfoRow[] = [];
  const table = tableDataOf(node);
  if (node.type === 'structure' || node.type === 'asset' || node.type === 'element') {
    pushInfoRow(rows, 'Selector', node.selector ?? null);
  }
  if (node.type === 'asset') pushInfoRow(rows, 'Archivo', node.href ?? null);
  if (node.type === 'element') {
    pushInfoRow(rows, 'Destino del enlace', node.href ?? null);
    if (node.formAction !== null && node.formAction !== undefined) {
      pushInfoRow(rows, 'Formulario', `${node.formMethod ?? 'GET'} ${node.formAction}`);
    } else if (node.formKey !== null && node.formKey !== undefined) {
      pushInfoRow(rows, 'Formulario', 'sin action declarada');
    }
    if (node.disabled === true) pushInfoRow(rows, 'Estado del control', 'deshabilitado');
    if (node.visible === false) pushInfoRow(rows, 'Estado del control', 'oculto en el DOM');
    const handlers = (node.handlers ?? []).map((hint) => {
      const tags = handlerProfileTags(hint.profile ?? null);
      const suffix = tags.length === 0 ? '' : ` · ${tags.join(' · ')}`;
      return `${eventLabel(hint.event)} → ${handlerLabel(hint.name, hint.profile ?? null)}${suffix}`;
    });
    pushInfoRow(rows, 'Manejadores', handlers.join('\n'));
    pushInfoRow(rows, 'Eventos', eventSummary(node));
    const routes = reachableNodeList(node.id).filter((item) => item.type === 'route');
    pushInfoRow(
      rows,
      'Rutas alcanzables',
      routes
        .map((route) => [route.method ?? '', route.path ?? route.title].join(' ').trim())
        .join('\n'),
    );
    pushInfoRow(rows, 'Peticiones alcanzables', reachableRequests(node).join('\n'));
  }
  if (table !== null) {
    pushInfoRow(rows, 'Columnas', String(table.columns.length));
    pushInfoRow(rows, 'Consultas', String(table.queries.length));
    pushInfoRow(
      rows,
      'Operaciones',
      [table.read ? 'lecturas' : '', table.write ? 'escrituras' : '']
        .filter((part) => part !== '')
        .join(' y '),
    );
    pushInfoRow(
      rows,
      'Filas observadas',
      table.grid.rows.length > 0
        ? `${String(table.grid.rows.length)} · clic en una celda para seguir su recorrido`
        : null,
    );
    pushInfoRow(
      rows,
      'Lista de columnas',
      table.columns.length === 0
        ? null
        : table.columns
            .map((column) => {
              const tags = usageTags(column).map(usageText).join(' · ');
              return `${column.name}${tags === '' ? '' : ` · ${tags}`}${
                column.runtime ? ' · RUNTIME' : ''
              }`;
            })
            .join('\n'),
    );
    pushInfoRow(
      rows,
      'SQL asociado',
      table.queries.length === 0 ? null : table.queries.map(tableQueryLine).join('\n'),
    );
    pushInfoRow(rows, 'Notas', table.notes.length === 0 ? null : table.notes.join('\n'));
  }
  if (node.method !== null && node.path !== null) {
    pushInfoRow(rows, 'Camino', `${node.method} ${node.path}`);
  }
  pushInfoRow(rows, 'URL', node.url ?? null);
  pushInfoRow(rows, 'Petición', requestSummary(node));
  const status = requestStatus(node);
  if (status !== null) {
    pushInfoRow(rows, 'Estado', status.label);
    pushInfoRow(rows, 'Ciclo', status.phase);
    if (node.backendObserved === true) {
      pushInfoRow(rows, 'Backend', 'ejecución capturada con Node Inspector');
    } else if (node.backendObserved === false) {
      pushInfoRow(rows, 'Backend', 'sin evidencia de ejecución');
    }
  }
  pushInfoRow(rows, 'Iniciador', node.initiatorFunction ?? null);
  pushInfoRow(rows, 'SQL', querySummary(node));
  pushInfoRow(rows, 'Conexiones', connectionSummary(node));
  const outgoing = connectionItems(node, 'out');
  if (outgoing.length > 0) pushInfoRow(rows, 'Sale hacia', outgoing.join('\n'));
  const incoming = connectionItems(node, 'in');
  if (incoming.length > 0) pushInfoRow(rows, 'Llega desde', incoming.join('\n'));
  if ((node.tablesRead ?? []).length > 0) {
    pushInfoRow(rows, 'Lee', (node.tablesRead ?? []).join('\n'));
  }
  if ((node.tablesWritten ?? []).length > 0) {
    pushInfoRow(rows, 'Escribe', (node.tablesWritten ?? []).join('\n'));
  }
  pushInfoRow(rows, 'Motor', node.engine ?? null);
  pushInfoRow(rows, 'Base de datos', node.database ?? null);
  pushInfoRow(rows, 'Detalle', node.subtitle);
  if (node.type === 'element') {
    pushInfoRow(rows, 'Interacciones', String(Math.max(node.occurrences, eventTotal(node))));
  } else if (node.countLabel !== null && node.countLabel !== undefined && node.occurrences > 0) {
    pushInfoRow(rows, node.countLabel, String(node.occurrences));
  } else if (node.occurrences > 1) {
    pushInfoRow(rows, 'Repeticiones', String(node.occurrences));
  }
  pushInfoRow(
    rows,
    'Peticiones',
    node.requestIds.length > 0 ? String(node.requestIds.length) : null,
  );
  pushInfoRow(rows, 'Trazas', node.traceIds.length > 0 ? String(node.traceIds.length) : null);
  if (node.firstSeen > 0) {
    pushInfoRow(
      rows,
      'Visto',
      node.firstSeen === node.lastSeen
        ? clock(node.firstSeen)
        : `${clock(node.firstSeen)} → ${clock(node.lastSeen)}`,
    );
  }
  pushInfoRow(rows, 'Peso', nodeWeightText(node));
  pushInfoRow(rows, 'Evidencia', node.evidence.join(' · '));
  pushInfoRow(rows, 'Nota', node.note);

  const sections: InfoSection[] = [];
  if (node.sql !== null && node.sql !== undefined && node.sql !== '') {
    const key = `sql:${node.id}`;
    sections.push({
      id: key,
      label: 'Consulta SQL',
      text: node.sql,
      expanded: sectionExpanded.has(key),
      onToggle: () => {
        toggleSection(key);
      },
    });
  }
  if (table !== null) {
    for (const query of table.queries) {
      const sql = query.node.sql;
      if (sql === null || sql === undefined || sql === '') continue;
      if (query.node.id === node.id) continue;
      const key = `sql:${query.node.id}`;
      sections.push({
        id: key,
        label: `Consulta SQL · ${tableQueryLine(query)}`,
        text: sql,
        expanded: sectionExpanded.has(key),
        onToggle: () => {
          toggleSection(key);
        },
      });
    }
  }
  for (const movement of jsonMovementsForNode(node)) {
    if (movement.body === null) continue;
    const formatted = formatJsonBody(movement);
    if (formatted === null) continue;
    sections.push(jsonBodySection(movement, formatted.text));
  }
  const code = codeSectionFor(node);
  if (code !== null) sections.push(code);

  const location = locationText(node);
  if (node.type === 'request') {
    const pick = pickRequestDetail(node, null);
    if (pick.detail === null) {
      pushInfoRow(rows, 'Contenido', 'sin detalle capturado de esta petición');
    } else {
      if (pick.count > 1) {
        pushInfoRow(rows, 'Peticiones capturadas', `${String(pick.count)} · mostrando la última`);
      }
      sections.push(...requestDetailSections(pick.detail, `node:${node.id}`));
    }
  }
  return infoCard({
    id: `node:${node.id}`,
    eyebrow: nodeTypeLabel(node),
    title: node.title,
    subtitle: node.subtitle ?? '',
    status: status?.label ?? '',
    tone: status === null ? 'neutral' : toneFromStatus(status.tone),
    chips: node.evidence,
    rows,
    sections,
    location:
      location === null || node.file === null
        ? null
        : {
            label: 'Ubicación',
            value: location,
            file: node.file,
            line: node.line,
            endLine: node.endLine,
          },
  });
}

function cardForCell(
  tableId: string,
  columnName: string,
  rowIndex: number | null,
): InfoCardModel | null {
  const table = tableIndex?.of(tableId);
  if (table === null || table === undefined) return null;
  const row = rowIndex === null ? null : (table.grid.rows[rowIndex] ?? null);
  const gridColumn = table.grid.columns.find(
    (entry) => entry.name.toLowerCase() === columnName.toLowerCase(),
  );
  const value = rowIndex === null ? null : tableCellAt(table, columnName, rowIndex);
  const query = row?.query ?? null;
  const rows: InfoRow[] = [];
  pushInfoRow(rows, 'Tabla', table.name);
  pushInfoRow(rows, 'Columna', columnName);
  pushInfoRow(rows, 'Fila', rowIndex === null ? 'columna completa' : String(rowIndex + 1));
  pushInfoRow(rows, 'Valor', value ?? (rowIndex === null ? null : '·'));
  if (gridColumn !== undefined) {
    pushInfoRow(
      rows,
      'Uso',
      gridColumn.tags.length === 0 ? null : gridColumn.tags.map(usageText).join(' · '),
    );
  }
  if (query !== null) {
    pushInfoRow(rows, 'Consulta', tableQueryLine(query));
    if (query.functionNode !== null) {
      const fn = query.functionNode;
      pushInfoRow(rows, 'Función', fn.title, fn.file, fn.line, fn.endLine);
    }
    const result = query.node.result;
    if (result !== null && result !== undefined) {
      pushInfoRow(
        rows,
        'Ejecución',
        `${result.driver} · ${clock(result.observedAt)} · ${String(result.rows.length)} ${
          result.rows.length === 1 ? 'fila' : 'filas'
        }${result.truncated ? ' · truncada' : ''}`,
      );
    }
  }
  const sections: InfoSection[] = [];
  if (
    query !== null &&
    query.node.sql !== null &&
    query.node.sql !== undefined &&
    query.node.sql !== ''
  ) {
    const key = `sql:${query.node.id}`;
    sections.push({
      id: key,
      label: 'Consulta SQL',
      text: query.node.sql,
      expanded: sectionExpanded.has(key),
      onToggle: () => {
        toggleSection(key);
      },
    });
  }
  return infoCard({
    id: cellCardId(table.id, columnName, rowIndex),
    eyebrow: 'Celda SQL',
    title: `${table.name}.${columnName}`,
    subtitle: rowIndex === null ? 'Columna completa' : `Fila ${String(rowIndex + 1)}`,
    chips: query !== null && query.runtime ? ['RUNTIME'] : [],
    rows,
    sections,
    location:
      query === null || query.node.file === null
        ? null
        : {
            label: 'Ubicación',
            value: locationText(query.node) ?? query.node.file,
            file: query.node.file,
            line: query.node.line,
            endLine: query.node.endLine,
          },
    footer:
      query === null
        ? null
        : {
            label: `Enfocar SQL · ${truncate(query.node.title, 40)}`,
            onClick: () => {
              selectNode(query.node.id);
              fitToNodes([query.node.id]);
            },
          },
  });
}

function cardForPlan(plan: EdgePlan): InfoCardModel {
  const rows: InfoRow[] = [];
  const target = plan.to === '' ? null : (model?.nodesById.get(plan.to) ?? null);
  const sources = plan.sources
    .map((id) => model?.nodesById.get(id))
    .filter((node): node is FlowNode => node !== undefined);
  pushInfoRow(
    rows,
    'Desde',
    sources.map((node) => `${nodeTypeLabel(node)} · ${node.title}`).join('\n'),
  );
  pushInfoRow(rows, 'Hacia', target === null ? null : `${nodeTypeLabel(target)} · ${target.title}`);
  const edges =
    model === null ? [] : model.snapshot.edges.filter((edge) => plan.edgeIds.includes(edge.id));
  const types = [...new Set(edges.map((edge) => edge.type))];
  pushInfoRow(rows, 'Relación', types.join(' · '));
  const evidence = [...new Set(edges.flatMap((edge) => edge.evidence))];
  pushInfoRow(rows, 'Evidencia', evidence.join(' · '));
  if (edges.length > 0) {
    const heuristics = edges.filter((edge) => edge.correlation === 'heuristic').length;
    pushInfoRow(
      rows,
      'Correlación',
      `${String(edges.length - heuristics)} directas · ${String(heuristics)} heurísticas`,
    );
    const occurrences = Math.max(...edges.map((edge) => edge.occurrences), 1);
    if (occurrences > 1) pushInfoRow(rows, 'Apariciones', String(occurrences));
    const lastSeen = Math.max(...edges.map((edge) => edge.lastSeen), 0);
    if (lastSeen > 0) pushInfoRow(rows, 'Visto', clock(lastSeen));
    pushInfoRow(
      rows,
      'Nota',
      edges
        .map((edge) => edge.note)
        .filter((note): note is string => note !== null && note !== '')
        .join('\n'),
    );
  }
  return infoCard({
    id: `plan:${plan.id}`,
    eyebrow: plan.kind === 'trunk' ? 'Corredor' : plan.kind === 'branch' ? 'Rama' : 'Conexión',
    title: plan.tooltip,
    subtitle: directionLabel(plan.flowClass, plan.roundTrip),
    tone:
      plan.flowClass === 'send' ? 'request' : plan.flowClass === 'receive' ? 'response' : 'neutral',
    rows,
    footer:
      target === null
        ? null
        : {
            label: `Enfocar ${nodeTypeLabel(target)} · ${truncate(target.title, 40)}`,
            onClick: () => {
              selectNode(target.id);
              fitToNodes([target.id]);
            },
          },
  });
}

function renderSectionBody(text: string): HTMLElement {
  const body = document.createElement('pre');
  body.className = 'info-body';
  body.textContent = text;
  return body;
}

interface CodeEditState {
  loading: boolean;
  dirty: boolean;
  conflict: boolean;
  error: string | null;
}

function syncCodeSaveBar(wrap: HTMLElement, state: CodeEditState): void {
  const save = wrap.querySelector('.info-save-run');
  const reload = wrap.querySelector('.info-save-reload');
  const overwrite = wrap.querySelector('.info-save-over');
  const dirty = wrap.querySelector('.info-dirty');
  const status = wrap.querySelector('.info-edit-status');
  if (save instanceof HTMLButtonElement) {
    save.hidden = state.conflict;
    save.disabled = state.loading || !state.dirty;
  }
  if (reload instanceof HTMLElement) reload.hidden = !state.conflict;
  if (overwrite instanceof HTMLElement) overwrite.hidden = !state.conflict;
  if (dirty instanceof HTMLElement) dirty.hidden = !state.dirty;
  if (status instanceof HTMLElement) {
    status.hidden = state.error === null;
    status.textContent = state.error ?? '';
  }
}

// La tarjeta con el cursor dentro no se reconstruye: se sincroniza en sitio para que llegar
// el archivo, guardar o recibir evidencia nueva no interrumpa la escritura.
function syncFocusedCodeEditor(): void {
  const editor = document.activeElement;
  if (!(editor instanceof HTMLTextAreaElement) || !editor.classList.contains('info-editor')) return;
  const path = editor.dataset.codePath;
  if (path === undefined) return;
  const wrap = editor.closest('.info-edit');
  if (!(wrap instanceof HTMLElement)) return;
  const buffer = codeBuffers.get(path);
  const loading = buffer === undefined || buffer.loading;
  editor.readOnly = loading;
  editor.placeholder = loading ? 'Cargando el archivo completo…' : '';
  if (!loading && buffer !== undefined && editor.value !== buffer.text) {
    editor.value = buffer.text;
  }
  syncCodeSaveBar(wrap, {
    loading,
    dirty: buffer?.dirty ?? false,
    conflict: buffer?.conflict ?? false,
    error: buffer?.error ?? null,
  });
}

function renderSectionEditor(editable: InfoSectionEditor): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'info-edit';
  const editor = document.createElement('textarea');
  editor.className = 'info-editor';
  editor.spellcheck = false;
  editor.wrap = 'off';
  editor.value = editable.value;
  editor.dataset.codePath = editable.path;
  editor.readOnly = editable.loading;
  editor.placeholder = editable.loading ? 'Cargando el archivo completo…' : '';
  editor.setAttribute('aria-label', `Código de ${editable.path}`);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'info-save info-save-run';
  save.textContent = 'Guardar · Ctrl+S';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'info-save info-save-reload';
  reload.textContent = 'Recargar';
  const overwrite = document.createElement('button');
  overwrite.type = 'button';
  overwrite.className = 'info-save info-save-over';
  overwrite.textContent = 'Guardar encima';
  const dirty = document.createElement('span');
  dirty.className = 'info-dirty';
  dirty.textContent = 'Sin guardar';
  const status = document.createElement('span');
  status.className = 'info-edit-status';
  const sync = (): void => {
    syncCodeSaveBar(wrap, editable);
  };
  save.addEventListener('click', (event) => {
    event.stopPropagation();
    editable.onSave();
  });
  reload.addEventListener('click', (event) => {
    event.stopPropagation();
    editable.onReload();
  });
  overwrite.addEventListener('click', (event) => {
    event.stopPropagation();
    editable.onOverwrite();
  });
  editor.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  editor.addEventListener('input', () => {
    editable.onInput(editor.value);
    sync();
  });
  const bar = document.createElement('div');
  bar.className = 'info-savebar';
  bar.append(save, reload, overwrite, dirty, status);
  wrap.append(editor, bar);
  sync();
  editable.onMount?.(editor);
  return wrap;
}

function renderInfoCard(card: InfoCardModel, options: InfoCardOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = `info-card is-${options.variant} is-${card.tone}`;
  if (options.className !== undefined && options.className !== '') {
    for (const name of options.className.split(' ')) root.classList.add(name);
  }
  root.dataset.cardId = card.id;

  const head = document.createElement('div');
  head.className = 'info-head';
  const top = document.createElement('div');
  top.className = 'info-head-top';
  const expansion = card.expansion;
  if (expansion !== null && options.variant === 'node') {
    const expander = document.createElement('button');
    expander.type = 'button';
    expander.className = 'info-expander';
    expander.textContent = expansion.expanded ? '▾' : '▸';
    expander.title = expansion.expanded ? 'Contraer la tarjeta' : 'Desplegar la tarjeta';
    expander.setAttribute('aria-expanded', expansion.expanded ? 'true' : 'false');
    expander.addEventListener('click', (event) => {
      event.stopPropagation();
      expansion.onToggle();
    });
    top.append(expander);
    head.classList.add('is-toggleable');
    head.addEventListener('click', (event) => {
      event.stopPropagation();
      expansion.onToggle();
    });
  }
  const eyebrow = document.createElement('span');
  eyebrow.className = 'info-eyebrow';
  eyebrow.textContent = card.eyebrow;
  top.append(eyebrow);
  if (card.meta !== '') {
    const meta = document.createElement('span');
    meta.className = 'info-meta';
    meta.textContent = card.meta;
    top.append(meta);
  }
  if (card.status !== '') {
    const status = document.createElement('span');
    status.className = `info-status is-${card.tone}`;
    status.textContent = card.status;
    top.append(status);
  }
  head.append(top);
  const title = document.createElement('div');
  title.className = 'info-title';
  title.textContent = card.title;
  head.append(title);
  if (card.subtitle !== '') {
    const subtitle = document.createElement('div');
    subtitle.className = 'info-sub';
    subtitle.textContent = card.subtitle;
    head.append(subtitle);
  }
  root.append(head);
  if (options.collapsed === true) return root;

  if (card.chips.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'info-chips';
    for (const chip of card.chips) {
      const item = document.createElement('span');
      item.className = `info-chip is-${chip.toLowerCase()}`;
      item.textContent = chip;
      chips.append(item);
    }
    root.append(chips);
  }

  const rows =
    options.rows === 'body' ? card.rows.filter((row) => row.label === 'Cuerpo') : card.rows;
  if (rows.length > 0) {
    const list = document.createElement('div');
    list.className = 'info-rows';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'info-row';
      const label = document.createElement('span');
      label.className = 'info-label';
      label.textContent = row.label;
      const value = document.createElement('span');
      value.className = 'info-value';
      if (row.file === null) {
        value.textContent = row.value;
      } else {
        value.append(codeLink(row.value, row.file, row.line, row.endLine));
      }
      item.append(label, value);
      list.append(item);
    }
    root.append(list);
  }

  if (card.sections.length > 0) {
    const sections = document.createElement('div');
    sections.className = 'info-sections';
    for (const section of card.sections) {
      const wrap = document.createElement('div');
      wrap.className = 'info-section';
      wrap.classList.toggle('is-open', section.expanded);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'info-toggle';
      toggle.setAttribute('aria-expanded', section.expanded ? 'true' : 'false');
      toggle.title = section.expanded ? `Contraer ${section.label}` : `Ver ${section.label}`;
      const caret = document.createElement('span');
      caret.className = 'info-caret';
      caret.textContent = section.expanded ? '▾' : '▸';
      const name = document.createElement('span');
      name.className = 'info-name';
      name.textContent = section.label;
      toggle.append(caret, name);
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = !wrap.classList.contains('is-open');
        wrap.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.title = open ? `Contraer ${section.label}` : `Ver ${section.label}`;
        caret.textContent = open ? '▾' : '▸';
        body.hidden = !open;
        section.onToggle();
      });
      const body =
        section.editable === undefined
          ? renderSectionBody(section.text)
          : renderSectionEditor(section.editable);
      body.hidden = !section.expanded;
      wrap.append(toggle, body);
      sections.append(wrap);
    }
    root.append(sections);
  }

  if (card.location !== null) {
    const location = document.createElement('div');
    location.className = 'info-location';
    const label = document.createElement('span');
    label.className = 'info-label';
    label.textContent = card.location.label;
    const value = document.createElement('span');
    value.className = 'info-value';
    value.append(
      codeLink(card.location.value, card.location.file, card.location.line, card.location.endLine),
    );
    location.append(label, value);
    root.append(location);
  }

  if (card.footer !== null) {
    const footer = document.createElement('div');
    footer.className = 'info-footer';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'info-action';
    action.textContent = card.footer.label;
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      card.footer?.onClick();
    });
    footer.append(action);
    root.append(footer);
  }
  return root;
}

const infoProviders = new Map<string, () => InfoCardModel | null>();

function mountInfoCard(
  card: InfoCardModel,
  options: InfoCardOptions,
  provider: () => InfoCardModel | null,
): HTMLElement {
  const root = renderInfoCard(card, options);
  infoProviders.set(card.id, provider);
  return root;
}

function nodeInfoProvider(id: string): () => InfoCardModel | null {
  return () => {
    const current = model;
    const node = current?.nodesById.get(id);
    if (current === null || node === undefined) return null;
    if (!current.viewNodes.some((entry) => entry.id === id)) return null;
    return cardForNode(node);
  };
}

function jsonCardProvider(id: string): () => InfoCardModel | null {
  return () => {
    const movement = findJsonMovement(id);
    if (movement === null || !jsonMovementVisible(movement)) return null;
    return cardForJsonMovement(movement);
  };
}

function planInfoProvider(id: string): () => InfoCardModel | null {
  return () => {
    const plan = planById.get(id);
    return plan === undefined ? null : cardForPlan(plan);
  };
}

function stageInfoProvider(id: string): () => InfoCardModel | null {
  return () => {
    const snapshot = state.snapshot;
    if (snapshot === null) return null;
    const stage = stackStages(snapshot).find((entry) => entry.id === id);
    return stage === undefined ? null : cardForStage(stage, snapshot);
  };
}

function bindStageInfo(el: Element, id: string): void {
  el.setAttribute('data-card-id', `stage:${id}`);
  infoProviders.set(`stage:${id}`, stageInfoProvider(id));
}

function bindNodeInfo(el: Element, id: string): void {
  el.setAttribute('data-card-id', `node:${id}`);
  infoProviders.set(`node:${id}`, nodeInfoProvider(id));
}

function bindPlanInfo(el: Element, id: string): void {
  el.setAttribute('data-card-id', `plan:${id}`);
  infoProviders.set(`plan:${id}`, planInfoProvider(id));
}

function cellCardId(tableId: string, column: string, rowIndex: number | null): string {
  return `cell:${tableId}|${column.toLowerCase()}|${rowIndex === null ? '*' : String(rowIndex)}`;
}

function cellInfoProvider(
  tableId: string,
  column: string,
  rowIndex: number | null,
): () => InfoCardModel | null {
  return () => {
    const current = model;
    if (current === null) return null;
    if (!current.viewNodes.some((entry) => entry.id === tableId)) return null;
    return cardForCell(tableId, column, rowIndex);
  };
}

function bindCellInfo(el: Element, tableId: string, column: string, rowIndex: number | null): void {
  const id = cellCardId(tableId, column, rowIndex);
  el.setAttribute('data-card-id', id);
  infoProviders.set(id, cellInfoProvider(tableId, column, rowIndex));
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
  if (!compactMode && expandedNodes.has(node.id)) {
    const measured = expandedHeights.get(node.id);
    if (measured !== undefined) return measured;
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
  const weight = nodeWeightLabel(node);
  const weightWidth = weight === null ? 0 : 8 + textWidth(weight, BADGE_FONT);
  const typeWidth = textWidth(nodeTypeLabel(node), TYPE_FONT, TYPE_LETTER_SPACING);
  const seen = node.firstSeen > 0 ? clock(node.firstSeen) : '';
  const timeWidth = seen === '' ? 0 : 8 + textWidth(seen, TIME_FONT);
  const subtitle = node.subtitle ?? '';
  const subWidth = subtitle === '' ? 0 : textWidth(subtitle, SUB_FONT) + timeWidth;
  const required = Math.max(
    CARD_TEXT_LEFT + typeWidth + badgeWidth + weightWidth + CARD_TEXT_RIGHT,
    CARD_TEXT_LEFT + textWidth(node.title, TITLE_FONT) + CARD_TEXT_RIGHT,
    CARD_TEXT_LEFT + subWidth + CARD_TEXT_RIGHT,
  );
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

function exchangeGapWidth(): number {
  return (
    MIDDLEWARE_INSET * 2 +
    MIDDLEWARE_SIDE_WIDTH * 2 +
    MIDDLEWARE_MAX_WIDTH +
    MIDDLEWARE_SIDE_GAP * 2
  );
}

// El hueco se decide con la lista ya filtrada, nunca con posiciones colocadas: si dependiera
// del layout, el layout dependería de sí mismo.
function exchangeActive(): boolean {
  if (layoutMode === 'hierarchical' || model === null) return false;
  let frontend = false;
  let backend = false;
  for (const node of model.viewNodes) {
    if (isFrontendLayerType(node.type)) frontend = true;
    else backend = true;
  }
  if (!frontend || !backend) return false;
  if (visibleJsonMovements(['request', 'response']).length > 0) return true;
  return pickedCellText() === null && middlewareRequestNodes().length > 0;
}

function layoutOptions(): {
  compact: boolean;
  widthOf: (node: FlowNode) => number;
  heightOf: (node: FlowNode) => number;
  boundaryGap: number;
} {
  return {
    compact: compactMode,
    widthOf: nodeWidthOf,
    heightOf: nodeHeightOf,
    boundaryGap: exchangeActive() ? exchangeGapWidth() : LAYER_GAP,
  };
}

function computeMiddlewareBand(layout: FlowLayout): MiddlewareBand | null {
  if (layout.mode === 'hierarchical') return null;
  let lastFrontend: FlowLayerInfo | null = null;
  let firstBackend: FlowLayerInfo | null = null;
  for (const layer of layout.layers) {
    if (isFrontendLayerType(layer.type)) {
      lastFrontend = layer;
    } else if (firstBackend === null) {
      firstBackend = layer;
    }
  }
  if (lastFrontend === null || firstBackend === null) return null;
  const gapStart = lastFrontend.x + (lastFrontend.width ?? 0);
  const gapEnd = firstBackend.x;
  if (gapEnd - gapStart < MIDDLEWARE_MIN_WIDTH + 48) return null;
  const width = Math.round(
    clamp(gapEnd - gapStart - 160, MIDDLEWARE_MIN_WIDTH, MIDDLEWARE_MAX_WIDTH),
  );
  // Las tarjetas laterales solo aparecen si el hueco deja sitio a las tres columnas
  // con la separación actual; si no, queda la banda central sola.
  const inner = gapEnd - gapStart - MIDDLEWARE_INSET * 2;
  const room = Math.floor((inner - width - MIDDLEWARE_SIDE_GAP * 2) / 2);
  const sideWidth = room >= MIDDLEWARE_SIDE_MIN ? Math.min(MIDDLEWARE_SIDE_WIDTH, room) : 0;
  return {
    x: Math.round(gapStart + (gapEnd - gapStart - width) / 2),
    width,
    gapStart,
    gapEnd,
    sideWidth,
  };
}

function applyMiddlewareGeometry(): void {
  if (model === null) return;
  model.middleware = computeMiddlewareBand(model.layout);
  model.baseHeight = model.layout.height;
}

function sectionNodeAlive(rest: string, alive: Set<string>): boolean {
  let index = rest.indexOf(':');
  while (index !== -1) {
    if (alive.has(rest.slice(0, index))) return true;
    index = rest.indexOf(':', index + 1);
  }
  return alive.has(rest);
}

// Los ids son estables entre revisiones, pero un nodo puede desaparecer: su tarjeta
// desplegada, su altura medida y sus secciones abiertas no deben sobrevivirle.
function pruneExpansion(nodesById: Map<string, FlowNode>): void {
  const alive = new Set(nodesById.keys());
  for (const id of [...expandedNodes]) {
    if (alive.has(id)) continue;
    expandedNodes.delete(id);
    expandedHeights.delete(id);
  }
  for (const id of [...expandedHeights.keys()]) {
    if (!alive.has(id)) expandedHeights.delete(id);
  }
  for (const key of [...sectionExpanded]) {
    const colon = key.indexOf(':');
    const prefix = key.slice(0, colon);
    if (prefix !== 'node' && prefix !== 'sql' && prefix !== 'code') continue;
    if (!sectionNodeAlive(key.slice(colon + 1), alive)) sectionExpanded.delete(key);
  }
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
  pruneExpansion(nodesById);
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
    middleware: null,
    baseHeight: layout.height,
  };
  applyMiddlewareGeometry();
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
      unmountNodeCard(nodeView);
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
      if (hoverCardId === `plan:${id}`) hideTip();
    }
  }
  correctNodeCardHeights(true);
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
  syncOverlayTransforms();
  scheduleViewportUpdate();
}

function syncTextVisibility(): void {
  const hidden = view.k < TEXT_MIN_ZOOM;
  if (hidden === textsHidden) return;
  textsHidden = hidden;
  const svg = document.getElementById('map-svg');
  if (svg !== null) svg.classList.toggle('is-zoom-out', hidden);
  const middleware = document.getElementById('map-middleware');
  if (middleware !== null) middleware.classList.toggle('is-zoom-out', hidden);
  const cards = document.getElementById('map-cards');
  if (cards !== null) cards.classList.toggle('is-zoom-out', hidden);
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
  if (!hierarchical && model !== null && model.middleware !== null) {
    const rows = buildMiddlewareRows();
    const band = model.middleware;
    const messages = rows.filter((row) => row.movement !== null).length;
    const label = document.createElement('span');
    label.className = 'axis-label is-middleware is-mw-json';
    label.textContent = `⇄ JSON · ${String(messages)}`;
    label.title = `Middleware JSON · ${String(messages)} mensajes entre el frontend y el backend`;
    bar.append(label);
    axisEntries.push({ el: label, x: band.x, width: band.width });
    if (band.sideWidth > 0) {
      const requests = document.createElement('span');
      requests.className = 'axis-label is-middleware is-mw-requests';
      requests.textContent = `PETICIONES · ${String(rows.length)}`;
      bar.append(requests);
      axisEntries.push({
        el: requests,
        x: band.gapStart + MIDDLEWARE_INSET,
        width: band.sideWidth,
      });
      const routes = document.createElement('span');
      routes.className = 'axis-label is-middleware is-mw-routes';
      routes.textContent = `RUTAS · ${String(rows.length)}`;
      bar.append(routes);
      axisEntries.push({
        el: routes,
        x: band.gapEnd - MIDDLEWARE_INSET - band.sideWidth,
        width: band.sideWidth,
      });
    }
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
    tooltip: directionLabel(flowClass, roundTrip),
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
    tooltip: directionLabel(flowClass, roundTrip),
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
  const className = edgeClassName(
    trunkEvidence,
    trunkHeuristic,
    true,
    group.flowClass,
    anyRoundTrip,
  );
  const summary = neutral
    ? 'Contención agrupada en un solo eje'
    : directionLabel(group.flowClass, anyRoundTrip);
  const railTooltip = `${String(origins.length)} ${origins.length === 1 ? 'origen' : 'orígenes'} · ${String(allEdges.length)} conexiones`;

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
    if (dest.edges.length === 0) continue;
    const y = dest.ySum / dest.yCount;
    plans.push(
      makePlan({
        id: `corr-branch:${String(group.originLayer)}:${String(group.destLayer)}:${dest.destId}:${group.flowClass}`,
        kind: 'trunk',
        sources: [...dest.originIds],
        to: dest.destId,
        edgeIds: dest.edges.map((edge) => edge.id),
        tooltip: directionLabel(group.flowClass, dest.roundTrip),
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
  bindPlanInfo(group, plan.id);
  const attributes: Record<string, string> = {
    class: plan.className,
    d: plan.d,
  };
  if (plan.marker !== '') attributes['marker-end'] = plan.marker;
  if (plan.startMarker !== '') attributes['marker-start'] = plan.startMarker;
  group.append(svgElement('path', { class: 'flow-edge-hit', d: plan.d }));
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
  const built = buildNodeCard(placed);
  if (built !== null) nodeCardWorld()?.append(built.root);
  const view: NodeView = {
    node: placed.node,
    group,
    card: built?.root ?? null,
    cardKey: built?.key ?? '',
  };
  nodeViews.set(placed.node.id, view);
  applyNodeViewState(view);
}

function nodeCardWorld(): HTMLElement | null {
  return document.getElementById('map-cards-world');
}

function nodeCardModel(node: FlowNode): InfoCardModel {
  const card = cardForNode(node);
  const weight = nodeWeightLabel(node);
  const badge = badgeText(node);
  const meta = [weight ?? '', badge].filter((part) => part !== '').join(' · ');
  const seen = node.firstSeen > 0 ? clock(node.firstSeen) : '';
  const subtitle = [node.subtitle ?? '', seen].filter((part) => part !== '').join(' · ');
  return {
    ...card,
    id: `canvas:${node.id}`,
    subtitle,
    meta,
    expansion: {
      expanded: expandedNodes.has(node.id),
      onToggle: () => {
        toggleNodeCard(node.id);
      },
    },
  };
}

function nodeCardProvider(id: string): () => InfoCardModel | null {
  return () => {
    const current = model;
    const node = current?.nodesById.get(id);
    if (current === null || node === undefined) return null;
    if (!current.viewNodes.some((entry) => entry.id === id)) return null;
    return nodeCardModel(node);
  };
}

interface NodeCardBuild {
  root: HTMLElement;
  key: string;
}

// El SVG conserva la geometría y la interacción; la tarjeta HTML solo pinta el contenido.
// Las tablas se quedan en el SVG: su despliegue es la rejilla SQL con interacción por celda.
function buildNodeCard(placed: FlowPlacedNode): NodeCardBuild | null {
  if (compactMode || placed.node.type === 'table') return null;
  const card = nodeCardModel(placed.node);
  const expanded = expandedNodes.has(placed.node.id);
  const root = mountInfoCard(
    card,
    {
      variant: 'node',
      rows: 'all',
      collapsed: !expanded,
      className: expanded ? 'is-expanded' : 'is-collapsed',
    },
    nodeCardProvider(placed.node.id),
  );
  root.style.left = `${String(placed.x)}px`;
  root.style.top = `${String(placed.y)}px`;
  root.style.width = `${String(placed.width)}px`;
  if (!expanded) root.style.height = `${String(placed.height)}px`;
  root.addEventListener('click', (event) => {
    event.stopPropagation();
    selectNode(placed.node.id);
  });
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openNodeMenu(placed.node.id, event.clientX, event.clientY);
  });
  return { root, key: infoCardSignature(card) };
}

function unmountNodeCard(view: NodeView): void {
  if (view.card === null) return;
  view.card.remove();
  infoProviders.delete(`canvas:${view.node.id}`);
  view.card = null;
  view.cardKey = '';
}

// Repinta en sitio cuando llega evidencia nueva (detalle de peticiones, secciones abiertas)
// sin volver a montar el grafo entero.
function refreshNodeCards(): void {
  if (compactMode || model === null) return;
  const active = document.activeElement;
  const typing = active instanceof HTMLTextAreaElement && active.classList.contains('info-editor');
  for (const view of nodeViews.values()) {
    if (view.card === null) continue;
    if (typing && view.card.contains(active)) continue;
    const placed = model.layout.positions.get(view.node.id);
    if (placed === undefined) continue;
    const card = nodeCardModel(view.node);
    const key = infoCardSignature(card);
    if (key === view.cardKey) continue;
    const built = buildNodeCard(placed);
    if (built === null) continue;
    view.card.replaceWith(built.root);
    view.card = built.root;
    view.cardKey = built.key;
    applyNodeViewState(view);
  }
  syncFocusedCodeEditor();
  correctNodeCardHeights();
}

function measureNodeCards(onlyMissing: boolean): boolean {
  let changed = false;
  for (const [id, view] of nodeViews) {
    if (view.card === null || !expandedNodes.has(id)) continue;
    if (onlyMissing && expandedHeights.has(id)) continue;
    const height = Math.ceil(view.card.offsetHeight);
    if (height <= 0 || expandedHeights.get(id) === height) continue;
    expandedHeights.set(id, height);
    changed = true;
  }
  return changed;
}

// El ancho no cambia al desplegar, así que la altura medida es estable: una sola pasada
// de corrección recoloca el layout con la altura real y no vuelve a entrar.
function correctNodeCardHeights(onlyMissing = false): void {
  if (compactMode || cardHeightPass || model === null || !state.open) return;
  if (!measureNodeCards(onlyMissing)) return;
  cardHeightPass = true;
  applyDisplayScope(scopeForView());
  renderGraph();
  cardHeightPass = false;
}

function clearNodeCards(): void {
  for (const view of nodeViews.values()) unmountNodeCard(view);
  nodeCardWorld()?.replaceChildren();
  for (const key of [...infoProviders.keys()]) {
    if (key.startsWith('canvas:')) infoProviders.delete(key);
  }
}

function renderGraph(): void {
  const focus = captureCodeFocus();
  const svg = svgById('map-svg');
  svg.replaceChildren();
  clearNodeCards();
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
  if (!tipFrozen) {
    hoverCardId = null;
    hoverProvider = null;
    tipSignature = '';
    hideTipNow();
  }
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
  renderMiddleware();
  if (!viewReady) {
    fitView();
  } else {
    applyView();
  }
  mountCellRoutes();
  updateVisibleViews();
  if (state.open) syncJsonRail();
  refreshFrozenTip();
  correctNodeCardHeights();
  restoreCodeFocus(focus);
}

function createNodeGroup(placed: FlowPlacedNode): SVGGElement {
  const node = placed.node;
  const group = svgElement('g', {
    class: `flow-node${evidenceClass(node.evidence) === '' ? '' : ` ${evidenceClass(node.evidence)}`}`,
    transform: `translate(${String(placed.x)} ${String(placed.y)})`,
    'data-node-id': node.id,
  });
  bindNodeInfo(group, node.id);
  if (node.type === 'element') {
    group.classList.toggle('is-hidden', node.visible === false);
    group.classList.toggle('is-disabled', node.disabled === true);
  }
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
  if (!compactMode) {
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
  const badge = badgeText(node);
  const badgeWidth = badge === '' ? 0 : 8 + textWidth(badge, BADGE_FONT);
  const weight = nodeWeightLabel(node);
  const weightWidth = weight === null ? 0 : 8 + textWidth(weight, BADGE_FONT);
  const typeMax = width - CARD_TEXT_LEFT - CARD_TEXT_RIGHT - badgeWidth - weightWidth;
  group.append(
    svgText(
      'type',
      CARD_TEXT_LEFT,
      14,
      truncateToWidth(nodeTypeLabel(node), typeMax, TYPE_FONT, TYPE_LETTER_SPACING),
    ),
  );
  if (weight !== null) {
    group.append(svgText('weight', width - CARD_TEXT_RIGHT - badgeWidth, 14, weight));
  }
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
  syncJsonRail();
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
        cellHit.addEventListener('click', select);
        cellHit.addEventListener('contextmenu', openMenu);
        bindCellInfo(cellHit, table.id, plan.name, rowIndex);
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

function intersectScope(base: Set<string> | null, other: Set<string>): Set<string> {
  if (base === null) return other;
  const scope = new Set<string>();
  for (const id of other) {
    if (base.has(id)) scope.add(id);
  }
  return scope;
}

// Misma evidencia que «Ver interacciones», pero para todas las peticiones con ese estado.
function statusScope(): Set<string> | null {
  const key = statusFilter;
  if (key === null || model === null) return null;
  const scope = new Set<string>();
  for (const node of model.snapshot.nodes) {
    if (!statusFilterKeys(node).includes(key)) continue;
    for (const id of involvedScope(node.id, 'both')) scope.add(id);
  }
  return scope;
}

function scopeForView(): Set<string> | null {
  let scope = focusScope ?? trafficScope();
  const statuses = statusScope();
  if (statuses !== null) scope = intersectScope(scope, statuses);
  if (eventOnly && eventFilter !== null) scope = intersectScope(scope, eventSubgraph(eventFilter));
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

function toggleNodeCard(id: string): void {
  if (expandedNodes.has(id)) {
    expandedNodes.delete(id);
    expandedHeights.delete(id);
  } else {
    expandedNodes.add(id);
  }
  if (!state.open || model === null) return;
  applyDisplayScope(scopeForView());
  renderGraph();
  renderStatus();
}

function sectionKey(prefixes: readonly string[]): string {
  return [...sectionExpanded]
    .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
    .sort()
    .join(',');
}

// Una sola ruta de expansión para todas las superficies. El prefijo de la clave decide
// qué vistas se repintan: abrir el SQL de un nodo no vuelve a montar la fila de intercambio.
function toggleSection(key: string): void {
  if (sectionExpanded.has(key)) {
    sectionExpanded.delete(key);
  } else {
    sectionExpanded.add(key);
  }
  const json = key.startsWith('json:');
  const exchange = json || key.startsWith('req:') || key.startsWith('route:');
  const canvas =
    json || key.startsWith('node:') || key.startsWith('sql:') || key.startsWith('code:');
  if (json) jsonRailSignature = '';
  if (exchange) middlewareSignature = '';
  if (!state.open) return;
  if (json) syncJsonRail();
  if (exchange) renderMiddleware();
  if (canvas) refreshNodeCards();
  if (selectedId !== null && model !== null) {
    const node = model.nodesById.get(selectedId);
    if (node !== undefined) renderDetail(node);
  }
  refreshFrozenTip();
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

function setStatusFilter(key: string | null): void {
  if (statusFilter === key) return;
  statusFilter = key;
  hideSearchResults();
  if (!state.open || model === null) {
    renderStatus();
    return;
  }
  scheduleScopeApply();
}

function applyNodeViewState(view: NodeView): void {
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
  if (view.card !== null) {
    view.card.classList.toggle('is-selected', isSelected);
    view.card.classList.toggle('is-dimmed', !visibleNode || selectionDim);
  }
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

let jsonMovementsLive: readonly FlowJsonMovement[] = [];
let jsonCaptureLive: FlowJsonCaptureState | null = null;
let jsonCaptureLiveSet = false;
let jsonRailSignature = '';
const jsonMovementBodies = new Map<string, string>();
const jsonFormattedBodies = new Map<string, { source: string; text: string | null }>();
let jsonMovementIndex = new Map<string, FlowJsonMovement>();
let jsonMovementIndexDirty = true;

let jsonOwnerCache = new Map<string, string | null>();
let jsonMovementOwnerIndex = new Map<string, string>();
let jsonFunctionsByFile = new Map<string, FlowNode[]>();
let jsonRequests: FlowNode[] = [];
let jsonRoutes: FlowNode[] = [];
let jsonRouteByHandler = new Map<string, string>();
let jsonRequestByRoute = new Map<string, string>();
let jsonRouteByRequest = new Map<string, string>();

const requestDetails = new Map<string, FlowRequestDetail>();
const requestBodies = new Map<string, CapturedBody>();
let middlewareRowViews: MiddlewareRowView[] = [];

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
  jsonRouteByHandler = new Map();
  jsonRequestByRoute = new Map();
  jsonRouteByRequest = new Map();
  for (const edge of snapshot.edges) {
    if (edge.type === 'HANDLES') jsonRouteByHandler.set(edge.to, edge.from);
    else if (edge.type === 'MATCHES') {
      jsonRequestByRoute.set(edge.to, edge.from);
      jsonRouteByRequest.set(edge.from, edge.to);
    }
  }
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

function allJsonMovements(): readonly FlowJsonMovement[] {
  if (jsonMovementsLive.length > 0) return jsonMovementsLive;
  return model?.snapshot.nodes.flatMap((node) => node.jsonMovements ?? []) ?? [];
}

function findJsonMovement(id: string): FlowJsonMovement | null {
  if (jsonMovementIndexDirty) {
    jsonMovementIndex = new Map();
    for (const movement of allJsonMovements()) jsonMovementIndex.set(movement.id, movement);
    jsonMovementIndexDirty = false;
  }
  return jsonMovementIndex.get(id) ?? null;
}

function jsonBodyMatchesCell(movement: FlowJsonMovement, cellValue: string): boolean {
  if (movement.body === null) return false;
  const trimmed = movement.body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return formatJsonBody(movement) !== null;
  }
  return movement.body.includes(cellValue);
}

function jsonMovementVisible(movement: FlowJsonMovement): boolean {
  const cellValue = pickedCellText();
  if (cellValue !== null && !jsonBodyMatchesCell(movement, cellValue)) return false;
  const scope = scopeForView();
  if (scope === null) return true;
  const owner = jsonOwnerNode(movement);
  if (owner !== null) return scope.has(owner.id);
  const endpoints = middlewareEndpoints(movement);
  return (
    (endpoints.frontend !== null && scope.has(endpoints.frontend.id)) ||
    (endpoints.backend !== null && scope.has(endpoints.backend.id))
  );
}

function visibleJsonMovements(kinds?: readonly FlowJsonMovement['kind'][]): FlowJsonMovement[] {
  return allJsonMovements().filter(
    (movement) =>
      (kinds === undefined || kinds.includes(movement.kind)) && jsonMovementVisible(movement),
  );
}

function jsonMovementsForNode(node: FlowNode): FlowJsonMovement[] {
  const indexed = new Set((node.jsonMovements ?? []).map((movement) => movement.id));
  const cellValue = pickedCellText();
  const list = allJsonMovements().filter(
    (movement) => indexed.has(movement.id) || jsonOwnerNode(movement)?.id === node.id,
  );
  return list
    .filter((movement) => cellValue === null || jsonBodyMatchesCell(movement, cellValue))
    .sort((left, right) => right.at - left.at);
}

function pickedCellText(): string | null {
  if (pickedCell === null || pickedCell.rowIndex === null || tableIndex === null) return null;
  const table = tableIndex.of(pickedCell.tableId);
  if (table === null) return null;
  const value = tableCellAt(table, pickedCell.column, pickedCell.rowIndex);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '·' ? null : trimmed;
}

const JSON_NO_MATCH = Symbol('json-no-match');

function jsonScalarMatches(value: unknown, target: string): boolean {
  if (value === null) return target.toLowerCase() === 'null';
  if (typeof value === 'boolean') return String(value) === target.toLowerCase();
  if (typeof value === 'number') {
    if (String(value) === target) return true;
    const numeric = Number(target);
    return Number.isFinite(numeric) && value === numeric;
  }
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === target) return true;
  if (text === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return false;
  const numeric = Number(target);
  return Number.isFinite(numeric) && Number(text) === numeric;
}

// Conserva solo las ramas del JSON que contienen el valor de la celda; los
// ancestros se mantienen para que la ruta siga siendo legible.
function pruneJsonToValue(
  value: unknown,
  target: string,
  depth: number,
): unknown | typeof JSON_NO_MATCH {
  if (depth > 64) return JSON_NO_MATCH;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      const pruned = pruneJsonToValue(item, target, depth + 1);
      if (pruned !== JSON_NO_MATCH) kept.push(pruned);
    }
    return kept.length === 0 ? JSON_NO_MATCH : kept;
  }
  if (value !== null && typeof value === 'object') {
    const kept: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneJsonToValue(item, target, depth + 1);
      if (pruned === JSON_NO_MATCH) continue;
      kept[key] = pruned;
      count += 1;
    }
    return count === 0 ? JSON_NO_MATCH : kept;
  }
  return jsonScalarMatches(value, target) ? value : JSON_NO_MATCH;
}

function formatJsonBody(movement: FlowJsonMovement): { text: string } | null {
  return formatJsonText(movement.id, movement.body);
}

function formatJsonText(cacheId: string, body: string | null): { text: string } | null {
  if (body === null) return null;
  const cellValue = pickedCellText();
  const cacheKey = cellValue === null ? cacheId : `${cacheId}\u0000${cellValue}`;
  const cached = jsonFormattedBodies.get(cacheKey);
  if (cached !== undefined && cached.source === body) {
    return cached.text === null ? null : { text: cached.text };
  }
  let text: string | null = body;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (cellValue === null) {
        text = JSON.stringify(parsed, null, 2);
      } else {
        const pruned = pruneJsonToValue(parsed, cellValue, 0);
        text = pruned === JSON_NO_MATCH ? null : JSON.stringify(pruned, null, 2);
      }
    } catch {
      text = body;
    }
  }
  jsonFormattedBodies.set(cacheKey, { source: body, text });
  if (jsonFormattedBodies.size > 256) {
    const oldest = jsonFormattedBodies.keys().next();
    if (!oldest.done) jsonFormattedBodies.delete(oldest.value);
  }
  return text === null ? null : { text };
}

function jsonScopeKey(): string {
  const scope = scopeForView();
  return scope === null ? '' : [...scope].sort().join(',');
}

function jsonExpansionKey(movements: readonly FlowJsonMovement[]): string {
  return movements
    .map((movement) => (sectionExpanded.has(`json:${movement.id}`) ? '1' : '0'))
    .join('');
}

function syncJsonRail(): void {
  const capture = jsonCaptureLiveSet ? jsonCaptureLive : (state.jsonCapture ?? null);
  const captureKey = capture === null ? '' : `${String(capture.ok)}|${capture.error ?? ''}`;
  const sorted = visibleJsonMovements().sort((left, right) => right.at - left.at);
  const signature = `${signatureOf(sorted)}#${captureKey}#${pickedCellText() ?? ''}#${jsonScopeKey()}#${jsonExpansionKey(sorted)}`;
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

function jsonEmptyMessage(
  capture: FlowJsonCaptureState | null,
  surface: 'rail' | 'middleware',
): string {
  if (capture !== null && !capture.ok) {
    return capture.error ?? 'La captura JSON no está disponible.';
  }
  const cellValue = pickedCellText();
  if (cellValue !== null) return `Ningún cuerpo JSON contiene «${cellValue}».`;
  if (scopeForView() !== null) return 'No hay cuerpos JSON en el alcance actual.';
  if (surface === 'rail') {
    return capture === null
      ? 'Conecta el backend con Node Inspector para capturar JSON.'
      : 'La captura está activa; aún no hay cuerpos JSON en el backend.';
  }
  return 'Aún no hay cuerpos JSON de petición o respuesta en tránsito.';
}

function renderJsonRail(
  movements: readonly FlowJsonMovement[],
  capture: FlowJsonCaptureState | null,
): void {
  const title = element('map-json-title');
  const list = element('map-json-list');
  title.textContent = `Movimientos JSON · ${String(movements.length)}`;
  list.replaceChildren();
  if (movements.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = jsonEmptyMessage(capture, 'rail');
    list.append(empty);
    return;
  }
  for (const movement of movements) {
    const card = cardForJsonMovement(movement);
    list.append(
      mountInfoCard(
        card,
        { variant: 'rail', rows: 'all', className: 'json-item' },
        jsonCardProvider(movement.id),
      ),
    );
  }
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
  for (const key of jsonFormattedBodies.keys()) {
    const id = key.split('\u0000')[0] ?? key;
    if (!alive.has(id)) jsonFormattedBodies.delete(key);
  }
  jsonMovementsLive = movements;
  jsonMovementIndexDirty = true;
  jsonRailSignature = '';
  middlewareSignature = '';
  renderStatus();
  if (state.open) {
    syncJsonRail();
    renderMiddleware();
    refreshFrozenTip();
  }
}

function rehydrateRequestBody(
  key: string,
  body: CapturedBody | null,
  omitted: boolean | undefined,
): CapturedBody | null {
  if (omitted === true) return requestBodies.get(key) ?? null;
  if (body !== null) requestBodies.set(key, body);
  return body;
}

function applyFlowRequestState(next: FlowRequestState): void {
  const alive = new Set<string>();
  requestDetails.clear();
  for (const request of next.requests) {
    alive.add(request.id);
    requestDetails.set(request.id, {
      ...request,
      requestBody: rehydrateRequestBody(
        `${request.id}:request`,
        request.requestBody,
        request.requestBodyOmitted,
      ),
      responseBody: rehydrateRequestBody(
        `${request.id}:response`,
        request.responseBody,
        request.responseBodyOmitted,
      ),
      requestBodyOmitted: false,
      responseBodyOmitted: false,
    });
  }
  for (const key of requestBodies.keys()) {
    const id = key.slice(0, key.lastIndexOf(':'));
    if (!alive.has(id)) requestBodies.delete(key);
  }
  for (const key of jsonFormattedBodies.keys()) {
    const base = key.split('\u0000')[0] ?? key;
    if (!base.startsWith('body:')) continue;
    const rest = base.slice(5);
    if (!alive.has(rest.slice(0, rest.lastIndexOf(':')))) jsonFormattedBodies.delete(key);
  }
  middlewareSignature = '';
  if (!state.open) return;
  renderMiddleware();
  refreshNodeCards();
  if (selectedId !== null && model !== null) {
    const node = model.nodesById.get(selectedId);
    if (node !== undefined && node.type === 'request') renderDetail(node);
  }
  refreshFrozenTip();
}

function headersText(headers: Record<string, string>): string | null {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return entries.map(([name, value]) => `${name}: ${value}`).join('\n');
}

function initiatorText(initiator: FlowRequestDetail['initiator']): string | null {
  if (initiator === null) return null;
  const head = `${initiator.type}${initiator.async ? ' · asíncrona' : ''}${
    initiator.mapped ? '' : ' · sin mapa de origen'
  }`;
  const frames = initiator.frames.map(
    (frame) =>
      `${frame.functionName ?? '(anónima)'} · ${frame.url}:${String(frame.line)}:${String(
        frame.column,
      )}`,
  );
  return [head, ...frames].join('\n');
}

function requestBodyText(detail: FlowRequestDetail, side: 'request' | 'response'): string | null {
  const body = side === 'request' ? detail.requestBody : detail.responseBody;
  if (body === null) return null;
  const formatted = formatJsonText(`body:${detail.id}:${side}`, body.text);
  return formatted === null ? null : formatted.text;
}

function requestDetailSections(detail: FlowRequestDetail, cardId: string): InfoSection[] {
  const sections: InfoSection[] = [];
  const add = (key: string, label: string, text: string | null): void => {
    if (text === null || text === '') return;
    const id = `${cardId}:${key}`;
    sections.push({
      id,
      label,
      text,
      expanded: sectionExpanded.has(id),
      onToggle: () => {
        toggleSection(id);
      },
    });
  };
  const sentHeaders = headersText(detail.headers);
  const receivedHeaders = headersText(detail.responseHeaders);
  add('headers', `Cabeceras enviadas · ${String(Object.keys(detail.headers).length)}`, sentHeaders);
  add(
    'response-headers',
    `Cabeceras recibidas · ${String(Object.keys(detail.responseHeaders).length)}`,
    receivedHeaders,
  );
  const hidden = pickedCellText() !== null ? 'Oculto para la celda elegida.' : null;
  add(
    'request-body',
    'Cuerpo enviado',
    requestBodyText(detail, 'request') ?? (detail.requestBody === null ? null : hidden),
  );
  add(
    'response-body',
    'Cuerpo recibido',
    requestBodyText(detail, 'response') ?? (detail.responseBody === null ? null : hidden),
  );
  add('initiator', 'Pila del iniciador', initiatorText(detail.initiator));
  return sections;
}

function requestDetailRows(detail: FlowRequestDetail): InfoRow[] {
  const rows: InfoRow[] = [];
  const status = requestStatusView({
    statusCode: detail.statusCode,
    outcome: detail.outcome,
    error: detail.error,
  });
  pushInfoRow(rows, 'Método', detail.method);
  pushInfoRow(rows, 'Camino', detail.path);
  pushInfoRow(rows, 'URL', detail.url);
  pushInfoRow(rows, 'Estado', status.label);
  pushInfoRow(rows, 'Ciclo', status.phase);
  pushInfoRow(
    rows,
    'Duración',
    detail.durationMs === null ? null : `${String(Math.round(detail.durationMs))} ms`,
  );
  pushInfoRow(rows, 'Origen', ORIGIN_LABEL[detail.origin] ?? detail.origin);
  pushInfoRow(rows, 'Tipo', detail.resourceType);
  pushInfoRow(rows, 'MIME', detail.mimeType);
  pushInfoRow(rows, 'Hora', clock(detail.wallStartedAt));
  pushInfoRow(rows, 'Iniciador', initiatorSummary(detail));
  pushInfoRow(rows, 'Error', detail.error);
  pushInfoRow(
    rows,
    'Cuerpo enviado',
    detail.requestBody === null
      ? 'sin cuerpo JSON capturado'
      : jsonBodySummary(detail.requestBody.text),
  );
  pushInfoRow(
    rows,
    'Cuerpo recibido',
    detail.responseBody === null
      ? 'sin cuerpo JSON capturado'
      : jsonBodySummary(detail.responseBody.text),
  );
  if (detail.requestBody?.truncated === true || detail.responseBody?.truncated === true) {
    pushInfoRow(rows, 'Aviso', 'El capturador recortó un cuerpo; se muestra el fragmento válido.');
  }
  return rows;
}

function initiatorSummary(detail: FlowRequestDetail): string | null {
  const initiator = detail.initiator;
  if (initiator === null) return null;
  const first = initiator.frames[0];
  if (first === undefined) return initiator.type;
  return `${first.functionName ?? '(anónima)'} · ${first.url}:${String(first.line)}`;
}

interface RequestPick {
  detail: FlowRequestDetail | null;
  count: number;
  heuristic: boolean;
}

function requestCandidates(
  node: FlowNode | null,
  method: string | null,
  path: string | null,
): FlowRequestDetail[] {
  const byId: FlowRequestDetail[] = [];
  for (const id of node?.requestIds ?? []) {
    const detail = requestDetails.get(id);
    if (detail !== undefined) byId.push(detail);
  }
  if (byId.length > 0) return byId;
  if (method === null || path === null) return [];
  const target = method.toUpperCase();
  const matched: FlowRequestDetail[] = [];
  for (const detail of requestDetails.values()) {
    if (detail.method.toUpperCase() !== target) continue;
    if (!jsonPathMatches(path, detail.path) && !jsonPathMatches(detail.path, path)) continue;
    matched.push(detail);
  }
  return matched;
}

// El nodo puede agrupar varias peticiones: se muestra la más cercana al movimiento
// y se rotula como elección heurística, nunca como linaje demostrado.
function pickRequestDetail(node: FlowNode | null, movement: FlowJsonMovement | null): RequestPick {
  const method = movement?.method ?? node?.method ?? null;
  const path = movement?.path ?? node?.path ?? null;
  const candidates = requestCandidates(node, method, path);
  const at = movement?.at ?? null;
  let best: FlowRequestDetail | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = at === null ? -candidate.wallStartedAt : Math.abs(candidate.wallStartedAt - at);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === null) return { detail: null, count: 0, heuristic: false };
  const byId = node !== null && node.requestIds.includes(best.id);
  return { detail: best, count: candidates.length, heuristic: !byId || candidates.length > 1 };
}

function middlewareSignatureOf(rows: readonly MiddlewareRow[]): string {
  const capture = jsonCaptureLiveSet ? jsonCaptureLive : (state.jsonCapture ?? null);
  const captureKey = capture === null ? '' : `${String(capture.ok)}:${capture.error ?? ''}`;
  const band = model?.middleware;
  const parts = rows.map((row) => {
    const movement = row.movement;
    const detail = row.detail;
    const movementKey =
      movement === null
        ? 'none'
        : `${movement.id}:${movement.kind}:${String(movement.at)}:${String(
            movement.count,
          )}:${movement.body === null ? '0' : String(movement.body.length)}:${
            movement.truncated ? '1' : '0'
          }:${sectionExpanded.has(`json:${movement.id}`) ? '1' : '0'}`;
    const detailKey =
      detail === null
        ? 'none'
        : `${detail.id}:${detail.outcome}:${String(detail.statusCode ?? '')}:${String(
            detail.durationMs ?? '',
          )}:${String(detail.requestBody?.text.length ?? 0)}:${String(
            detail.responseBody?.text.length ?? 0,
          )}:${String(Object.keys(detail.headers).length)}:${String(
            Object.keys(detail.responseHeaders).length,
          )}`;
    return `${row.key}~${movementKey}~${detailKey}~${row.frontend?.id ?? ''}~${
      row.frontend?.evidence.join('+') ?? ''
    }~${row.backend?.id ?? ''}~${row.backend?.evidence.join('+') ?? ''}~${String(row.detailCount)}`;
  });
  return [
    compactMode ? 'compact' : 'full',
    captureKey,
    pickedCellText() ?? '',
    band === null || band === undefined
      ? ''
      : `${String(band.x)}:${String(band.width)}:${String(band.sideWidth)}:${String(
          band.gapStart,
        )}:${String(band.gapEnd)}`,
    sectionKey(['json:', 'req:', 'route:']),
    parts.join('|'),
  ].join('#');
}

let overlayRasterTimer: ReturnType<typeof setTimeout> | null = null;

const OVERLAY_WORLDS = ['map-middleware-world', 'map-cards-world'];

function scheduleOverlayRaster(): void {
  if (overlayRasterTimer !== null) clearTimeout(overlayRasterTimer);
  overlayRasterTimer = setTimeout(() => {
    overlayRasterTimer = null;
    for (const id of OVERLAY_WORLDS) {
      const world = document.getElementById(id);
      if (world === null || world.firstElementChild === null) continue;
      // Fuerza un repintado del texto a la escala actual: si no, el navegador reutiliza el raster anterior y se ve borroso.
      world.style.textShadow = '0 0 0 transparent';
      void world.offsetWidth;
      world.style.textShadow = '';
    }
  }, 140);
}

function syncOverlayTransforms(): void {
  const transform = `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.k)})`;
  for (const id of OVERLAY_WORLDS) {
    const world = document.getElementById(id);
    if (world !== null) world.style.transform = transform;
  }
  scheduleOverlayRaster();
}

function hideMiddleware(): void {
  if (overlayRasterTimer !== null) {
    clearTimeout(overlayRasterTimer);
    overlayRasterTimer = null;
  }
  if (middlewareLinkLayer !== null) {
    middlewareLinkLayer.remove();
    middlewareLinkLayer = null;
  }
  const host = document.getElementById('map-middleware');
  if (host !== null) host.hidden = true;
  middlewareRowViews = [];
  middlewareSignature = '';
}

const utf8Encoder = new TextEncoder();

function textBytes(text: string): number {
  return utf8Encoder.encode(text).length;
}

function byteSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const WEIGHT_BASIS_LABEL: Record<FlowNodeWeight['basis'], string> = {
  file: 'archivo completo',
  range: 'rango de líneas',
  rows: 'muestra observada',
  bodies: 'cuerpos capturados',
};

function nodeWeight(node: FlowNode): FlowNodeWeight | null {
  return node.weight ?? null;
}

function nodeWeightLabel(node: FlowNode): string | null {
  const weight = nodeWeight(node);
  return weight === null || weight.bytes === null ? null : byteSizeLabel(weight.bytes);
}

function nodeWeightText(node: FlowNode): string | null {
  const weight = nodeWeight(node);
  if (weight === null) return null;
  if (weight.bytes === null) return weight.note ?? 'No medible.';
  const note = weight.note === null ? '' : ` · ${weight.note}`;
  return `${byteSizeLabel(weight.bytes)} · ${WEIGHT_BASIS_LABEL[weight.basis]}${note}`;
}

function jsonBodySummary(body: string, bytes: number = textBytes(body)): string {
  const trimmed = body.trim();
  if (trimmed === '') return 'Cuerpo vacío';
  const size = byteSizeLabel(bytes);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return truncate(trimmed, 140);
  }
  if (Array.isArray(value)) return `Lista · ${String(value.length)} elementos · ${size}`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const shown = keys.slice(0, 8).map((key) => {
      const entry = record[key];
      return Array.isArray(entry) ? `${key}[${String(entry.length)}]` : key;
    });
    const suffix = keys.length > shown.length ? ', …' : '';
    return `{ ${shown.join(', ')}${suffix} } · ${size}`;
  }
  const type = typeof value === 'string' ? 'Texto' : typeof value;
  return `${type} · ${size}`;
}

function middlewareCard(movement: FlowJsonMovement): HTMLElement {
  const card = cardForJsonMovement(movement);
  const root = mountInfoCard(
    card,
    { variant: 'middleware', rows: 'body', className: 'mw-card' },
    jsonCardProvider(movement.id),
  );
  root.classList.toggle('is-response', movement.kind === 'response');
  root.classList.toggle('is-request', movement.kind === 'request');
  return root;
}

function cardForRequestSide(
  rowKey: string,
  node: FlowNode | null,
  movement: FlowJsonMovement | null,
  pick: RequestPick,
): InfoCardModel {
  const detail = pick.detail;
  const cardId = `req:${rowKey}`;
  const method = detail?.method ?? node?.method ?? movement?.method ?? null;
  const path = detail?.path ?? node?.path ?? movement?.path ?? null;
  const status =
    detail === null
      ? node === null
        ? null
        : requestStatus(node)
      : requestStatusView({
          statusCode: detail.statusCode,
          outcome: detail.outcome,
          error: detail.error,
        });
  const rows: InfoRow[] = [];
  if (detail !== null) {
    rows.push(...requestDetailRows(detail));
  } else {
    pushInfoRow(rows, 'Método', method);
    pushInfoRow(rows, 'Camino', path);
    pushInfoRow(rows, 'URL', node?.url ?? null);
    pushInfoRow(rows, 'Estado', status?.label ?? null);
    pushInfoRow(rows, 'Ciclo', status?.phase ?? null);
    pushInfoRow(
      rows,
      'Duración',
      node?.durationMs === null || node?.durationMs === undefined
        ? null
        : `${String(Math.round(node.durationMs))} ms`,
    );
    pushInfoRow(
      rows,
      'Origen',
      node?.origin === null || node?.origin === undefined
        ? null
        : (ORIGIN_LABEL[node.origin] ?? node.origin),
    );
    pushInfoRow(rows, 'Iniciador', node?.initiatorFunction ?? null);
    pushInfoRow(rows, 'Cuerpo', 'sin cuerpo JSON capturado');
  }
  if (node === null) pushInfoRow(rows, 'Nodo', 'sin nodo asociado en el grafo');
  if (pick.count > 1) {
    pushInfoRow(
      rows,
      'Peticiones',
      `${String(pick.count)} · mostrando ${movement === null ? 'la última' : 'la más cercana al movimiento'}`,
    );
  }
  if (pick.heuristic && detail !== null) {
    pushInfoRow(rows, 'Asociación', 'heurística por método y camino');
  }
  const location = node === null ? null : locationText(node);
  return infoCard({
    id: cardId,
    eyebrow: 'PETICIÓN FRONTEND',
    title:
      method !== null && path !== null
        ? `${method} ${path}`
        : (node?.title ?? 'Petición sin camino'),
    subtitle:
      detail === null
        ? (node?.subtitle ?? '')
        : `${ORIGIN_LABEL[detail.origin] ?? detail.origin} · ${detail.resourceType}`,
    status: status?.label ?? '',
    tone: status === null ? 'request' : toneFromStatus(status.tone),
    chips: pick.heuristic && detail !== null ? ['HEURÍSTICO'] : [],
    rows,
    sections: detail === null ? [] : requestDetailSections(detail, cardId),
    location:
      location === null || node?.file === null || node === null
        ? null
        : {
            label: 'Ubicación',
            value: location,
            file: node.file,
            line: node.line,
            endLine: node.endLine,
          },
    footer:
      node === null
        ? null
        : {
            label: `Enfocar ${nodeTypeLabel(node)} · ${truncate(node.title, 40)}`,
            onClick: () => {
              selectNode(node.id);
              fitToNodes([node.id]);
            },
          },
  });
}

function routeQueryNodes(node: FlowNode): FlowNode[] {
  if (model === null) return [];
  const sources = [node.id];
  for (const edge of model.snapshot.edges) {
    if (edge.type === 'HANDLES' && edge.from === node.id) sources.push(edge.to);
  }
  const queries: FlowNode[] = [];
  const seen = new Set<string>();
  for (const edge of model.snapshot.edges) {
    if (edge.type !== 'QUERIES' || !sources.includes(edge.from)) continue;
    if (seen.has(edge.to)) continue;
    const query = model.nodesById.get(edge.to);
    if (query === undefined || query.type !== 'query') continue;
    seen.add(edge.to);
    queries.push(query);
  }
  return queries;
}

function cardForRouteSide(
  rowKey: string,
  node: FlowNode | null,
  movement: FlowJsonMovement | null,
  pick: RequestPick,
): InfoCardModel {
  const detail = pick.detail;
  const cardId = `route:${rowKey}`;
  const method = node?.method ?? movement?.method ?? detail?.method ?? null;
  const path = node?.path ?? movement?.path ?? detail?.path ?? null;
  const rows: InfoRow[] = [];
  pushInfoRow(rows, 'Ruta', method !== null && path !== null ? `${method} ${path}` : null);
  pushInfoRow(rows, 'Manejador', node?.subtitle ?? null);
  pushInfoRow(rows, 'Evidencia', node === null ? null : node.evidence.join(' · '));
  if (node?.backendObserved === true) {
    pushInfoRow(rows, 'Ejecución', 'capturada con Node Inspector');
  } else if (node?.backendObserved === false) {
    pushInfoRow(rows, 'Ejecución', 'sin evidencia de ejecución');
  }
  if (detail !== null) {
    const status = requestStatusView({
      statusCode: detail.statusCode,
      outcome: detail.outcome,
      error: detail.error,
    });
    pushInfoRow(rows, 'Estado', status.label);
    pushInfoRow(
      rows,
      'Duración',
      detail.durationMs === null ? null : `${String(Math.round(detail.durationMs))} ms`,
    );
    pushInfoRow(
      rows,
      'Cuerpo devuelto',
      detail.responseBody === null
        ? 'sin cuerpo JSON capturado'
        : jsonBodySummary(detail.responseBody.text),
    );
  } else {
    pushInfoRow(rows, 'Cuerpo devuelto', 'sin cuerpo JSON capturado');
  }
  const queries = node === null ? [] : routeQueryNodes(node);
  pushInfoRow(rows, 'Consultas', queries.length === 0 ? null : String(queries.length));
  if (detail !== null && pick.count > 1) {
    pushInfoRow(
      rows,
      'Peticiones',
      `${String(pick.count)} · mostrando ${movement === null ? 'la última' : 'la más cercana al movimiento'}`,
    );
  }
  if (detail !== null && pick.heuristic) {
    pushInfoRow(rows, 'Asociación', 'heurística por método y camino');
  }
  pushInfoRow(rows, 'Nota', node?.note ?? null);
  if (node === null) pushInfoRow(rows, 'Nodo', 'sin ruta asociada en el grafo');

  const sections: InfoSection[] = [];
  for (const query of queries) {
    const sql = query.sql;
    if (sql === null || sql === undefined || sql === '') continue;
    const id = `${cardId}:sql:${query.id}`;
    sections.push({
      id,
      label: `SQL · ${querySummary(query) ?? query.title}`,
      text: sql,
      expanded: sectionExpanded.has(id),
      onToggle: () => {
        toggleSection(id);
      },
    });
  }
  if (detail !== null) {
    const headers = headersText(detail.responseHeaders);
    if (headers !== null) {
      const id = `${cardId}:response-headers`;
      sections.push({
        id,
        label: `Cabeceras recibidas · ${String(Object.keys(detail.responseHeaders).length)}`,
        text: headers,
        expanded: sectionExpanded.has(id),
        onToggle: () => {
          toggleSection(id);
        },
      });
    }
    const text =
      requestBodyText(detail, 'response') ??
      (detail.responseBody === null || pickedCellText() === null
        ? null
        : 'Oculto para la celda elegida.');
    if (text !== null) {
      const id = `${cardId}:response-body`;
      sections.push({
        id,
        label: 'Cuerpo devuelto',
        text,
        expanded: sectionExpanded.has(id),
        onToggle: () => {
          toggleSection(id);
        },
      });
    }
  }
  const location = node === null ? null : locationText(node);
  const status = node === null ? null : requestStatus(node);
  return infoCard({
    id: cardId,
    eyebrow: 'PETICIÓN BACKEND',
    title:
      node?.title ?? (method !== null && path !== null ? `${method} ${path}` : 'Ruta sin resolver'),
    subtitle: node === null ? '' : nodeTypeLabel(node),
    status: status?.label ?? '',
    tone: node === null ? 'response' : toneFromStatus(status?.tone ?? 'ok'),
    chips:
      detail !== null && pick.heuristic
        ? [...(node?.evidence ?? []), 'HEURÍSTICO']
        : (node?.evidence ?? []),
    rows,
    sections,
    location:
      location === null || node === null || node.file === null
        ? null
        : {
            label: 'Ubicación',
            value: location,
            file: node.file,
            line: node.line,
            endLine: node.endLine,
          },
    footer:
      node === null
        ? null
        : {
            label: `Enfocar ${nodeTypeLabel(node)} · ${truncate(node.title, 40)}`,
            onClick: () => {
              selectNode(node.id);
              fitToNodes([node.id]);
            },
          },
  });
}

function requestSideProvider(
  rowKey: string,
  nodeId: string | null,
  movementId: string | null,
): () => InfoCardModel | null {
  return () => {
    const node = nodeId === null ? null : (model?.nodesById.get(nodeId) ?? null);
    const movement = movementId === null ? null : findJsonMovement(movementId);
    if (node === null && movement === null) return null;
    return cardForRequestSide(rowKey, node, movement, pickRequestDetail(node, movement));
  };
}

function routeSideProvider(
  rowKey: string,
  nodeId: string | null,
  movementId: string | null,
): () => InfoCardModel | null {
  return () => {
    const node = nodeId === null ? null : (model?.nodesById.get(nodeId) ?? null);
    const movement = movementId === null ? null : findJsonMovement(movementId);
    if (node === null && movement === null) return null;
    return cardForRouteSide(rowKey, node, movement, pickRequestDetail(node, movement));
  };
}

function middlewareRequestNodes(): FlowNode[] {
  if (model === null) return [];
  const scope = scopeForView();
  const shown = new Set(model.viewNodes.map((node) => node.id));
  return model.snapshot.nodes.filter(
    (node) =>
      node.type === 'request' &&
      shown.has(node.id) &&
      (filterVisibility.get(node.id) ?? true) &&
      (scope === null || scope.has(node.id)),
  );
}

function movementMatchesNode(movement: FlowJsonMovement, node: FlowNode): boolean {
  if (node.method === null || node.path === null) return false;
  if (movement.method === null || movement.path === null) return false;
  if (movement.method.toUpperCase() !== node.method.toUpperCase()) return false;
  return jsonPathMatches(node.path, movement.path) || jsonPathMatches(movement.path, node.path);
}

function middlewareRowTime(row: MiddlewareRow): number {
  if (row.movement !== null) return row.movement.at;
  if (row.detail !== null) return row.detail.wallStartedAt;
  return row.frontend?.lastSeen ?? 0;
}

function buildMiddlewareRows(): MiddlewareRow[] {
  const movements = visibleJsonMovements(['request', 'response']);
  const rows: MiddlewareRow[] = [];
  for (const movement of movements) {
    const endpoints = middlewareEndpoints(movement);
    const pick = pickRequestDetail(endpoints.frontend, movement);
    rows.push({
      key: `m:${movement.id}`,
      movement,
      frontend: endpoints.frontend,
      backend: endpoints.backend,
      detail: pick.detail,
      detailCount: pick.count,
      detailHeuristic: pick.heuristic,
    });
  }
  // Sin cuerpo JSON también se ve el intercambio: la petición y la ruta existen en el grafo.
  if (pickedCellText() === null) {
    for (const node of middlewareRequestNodes()) {
      if (movements.some((movement) => movementMatchesNode(movement, node))) continue;
      const pick = pickRequestDetail(node, null);
      const routeId = jsonRouteByRequest.get(node.id);
      rows.push({
        key: `n:${node.id}`,
        movement: null,
        frontend: node,
        backend: routeId === undefined ? null : (model?.nodesById.get(routeId) ?? null),
        detail: pick.detail,
        detailCount: pick.count,
        detailHeuristic: pick.heuristic,
      });
    }
  }
  return rows.sort(
    (left, right) =>
      middlewareRowTime(left) - middlewareRowTime(right) || left.key.localeCompare(right.key),
  );
}

function matchingJsonNode(
  nodes: readonly FlowNode[],
  method: string | null,
  path: string | null,
): FlowNode | null {
  if (method === null || path === null) return null;
  const target = method.toUpperCase();
  for (const node of nodes) {
    if (node.method === null || node.path === null) continue;
    if (node.method.toUpperCase() !== target) continue;
    if (!jsonPathMatches(node.path, path)) continue;
    return node;
  }
  return null;
}

function middlewareEndpoints(movement: FlowJsonMovement): {
  frontend: FlowNode | null;
  backend: FlowNode | null;
} {
  const owner = jsonOwnerNode(movement);
  const matchedRequest = matchingJsonNode(jsonRequests, movement.method, movement.path);
  const matchedRoute = matchingJsonNode(jsonRoutes, movement.method, movement.path);
  const ownerRoute =
    owner === null
      ? null
      : owner.type === 'route'
        ? owner
        : (model?.nodesById.get(jsonRouteByHandler.get(owner.id) ?? '') ?? null);
  const frontendOwner = owner !== null && isFrontendLayerType(owner.type) ? owner : null;
  const backendOwner = owner !== null && !isFrontendLayerType(owner.type) ? owner : null;
  // El endpoint (ruta) es el destino real del JSON; la función que lo atiende
  // solo se usa como último recurso cuando no hay ruta en el snapshot.
  const backend = matchedRoute ?? ownerRoute ?? backendOwner;
  const requestFromRoute =
    backend === null
      ? null
      : (model?.nodesById.get(jsonRequestByRoute.get(backend.id) ?? '') ?? null);
  return {
    frontend: matchedRequest ?? frontendOwner ?? requestFromRoute,
    backend,
  };
}

function middlewareGridLeft(band: MiddlewareBand): number {
  return band.sideWidth > 0 ? band.gapStart + MIDDLEWARE_INSET : band.x;
}

function middlewareCardAnchor(
  el: HTMLElement,
  band: MiddlewareBand,
  edge: 'left' | 'right',
): { x: number; y: number } {
  const left = middlewareGridLeft(band) + el.offsetLeft;
  return {
    x: edge === 'left' ? left : left + el.offsetWidth,
    y: FLOW_MARGIN + el.offsetTop + el.offsetHeight / 2,
  };
}

function middlewareNodeAnchor(
  node: FlowNode,
  edge: 'left' | 'right',
): { x: number; y: number } | null {
  const placed = model?.layout.positions.get(node.id);
  if (placed === undefined) return null;
  return {
    x: edge === 'left' ? placed.x : placed.x + placed.width,
    y: placed.y + placed.height / 2,
  };
}

function middlewareLink(
  from: { x: number; y: number },
  to: { x: number; y: number },
  direction: 1 | -1,
  className: string,
  cardId: string,
): SVGPathElement {
  const span = Math.abs(to.x - from.x);
  const first = from.x + direction * clamp(span * 0.45, 8, 320);
  const second = to.x - direction * clamp(span * 0.2, 6, 160);
  const path = svgElement('path', {
    class: className,
    d: `M ${String(from.x)} ${String(from.y)} C ${String(first)} ${String(from.y)}, ${String(
      second,
    )} ${String(to.y)}, ${String(to.x)} ${String(to.y)}`,
  });
  path.setAttribute('data-card-id', cardId);
  return path;
}

function renderMiddlewareLinks(band: MiddlewareBand): void {
  if (middlewareLinkLayer !== null) {
    middlewareLinkLayer.remove();
    middlewareLinkLayer = null;
  }
  if (viewport === null || middlewareRowViews.length === 0) return;
  const layer = svgElement('g', { class: 'mw-links' });
  let drawn = 0;
  for (const view of middlewareRowViews) {
    const row = view.row;
    const kind = row.movement?.kind === 'response' ? 'is-response' : 'is-request';
    const left = view.left;
    const center = view.center;
    const right = view.right;
    const segments: Array<
      [{ x: number; y: number } | null, { x: number; y: number } | null, 1 | -1, string, string]
    > = [];
    if (left !== null) {
      const cardId = `req:${row.key}`;
      const nodeAnchor = row.frontend === null ? null : middlewareNodeAnchor(row.frontend, 'right');
      segments.push([
        middlewareCardAnchor(left, band, 'left'),
        nodeAnchor,
        -1,
        `mw-link-line ${kind}`,
        cardId,
      ]);
      if (center !== null) {
        segments.push([
          middlewareCardAnchor(left, band, 'right'),
          middlewareCardAnchor(center, band, 'left'),
          1,
          `mw-link-line ${kind}`,
          cardId,
        ]);
      }
    }
    if (right !== null) {
      const cardId = `route:${row.key}`;
      if (center !== null) {
        segments.push([
          middlewareCardAnchor(center, band, 'right'),
          middlewareCardAnchor(right, band, 'left'),
          1,
          `mw-link-line ${kind}`,
          cardId,
        ]);
      }
      const nodeAnchor = row.backend === null ? null : middlewareNodeAnchor(row.backend, 'left');
      segments.push([
        middlewareCardAnchor(right, band, 'right'),
        nodeAnchor,
        1,
        `mw-link-line ${kind}`,
        cardId,
      ]);
    }
    for (const [from, to, direction, className, cardId] of segments) {
      if (from === null || to === null) continue;
      layer.append(middlewareLink(from, to, direction, className, cardId));
      drawn += 1;
    }
  }
  if (drawn === 0) return;
  middlewareLinkLayer = layer;
  if (nodeLayer !== null) {
    viewport.insertBefore(layer, nodeLayer);
  } else {
    viewport.append(layer);
  }
}

function middlewareTitle(label: string, count: number, noun: string, glyph: string): HTMLElement {
  const title = document.createElement('div');
  title.className = 'mw-title';
  const mark = document.createElement('span');
  mark.className = 'mw-title-glyph';
  mark.textContent = glyph;
  const name = document.createElement('span');
  name.className = 'mw-title-label';
  name.textContent = label;
  const total = document.createElement('span');
  total.className = 'mw-title-count';
  total.textContent = `${String(count)} ${noun}`;
  title.append(mark, name, total);
  return title;
}

function middlewareNote(text: string): HTMLElement {
  const note = document.createElement('div');
  note.className = 'mw-empty';
  note.textContent = text;
  return note;
}

function rowPick(row: MiddlewareRow): RequestPick {
  return { detail: row.detail, count: row.detailCount, heuristic: row.detailHeuristic };
}

function updateMiddlewareAxis(rows: readonly MiddlewareRow[]): void {
  const requests = rows.filter((row) => row.frontend !== null || row.detail !== null).length;
  const messages = rows.filter((row) => row.movement !== null).length;
  const routes = rows.filter((row) => row.backend !== null).length;
  const set = (selector: string, text: string, title: string): void => {
    const label = document.querySelector(`#map-axis ${selector}`);
    if (!(label instanceof HTMLElement)) return;
    label.textContent = text;
    label.title = title;
  };
  set(
    '.is-mw-requests',
    `PETICIONES · ${String(requests)}`,
    `Peticiones del frontend · ${String(requests)} en el intercambio`,
  );
  set(
    '.is-mw-json',
    `⇄ JSON · ${String(messages)}`,
    `Middleware JSON · ${String(messages)} mensajes entre el frontend y el backend`,
  );
  set(
    '.is-mw-routes',
    `RUTAS · ${String(routes)}`,
    `Rutas del backend · ${String(routes)} atienden el intercambio`,
  );
}

function renderMiddleware(): void {
  const host = document.getElementById('map-middleware');
  if (host === null) return;
  if (!state.open || model === null || model.middleware === null) {
    hideMiddleware();
    return;
  }
  const band = model.middleware;
  const world = element('map-middleware-world');
  const all = buildMiddlewareRows();
  const rows = band.sideWidth > 0 ? all : all.filter((row) => row.movement !== null);
  const sides = band.sideWidth > 0;
  updateMiddlewareAxis(rows);
  const signature = middlewareSignatureOf(rows);
  host.hidden = false;
  if (signature !== middlewareSignature || world.firstElementChild === null) {
    middlewareSignature = signature;
    for (const id of infoProviders.keys()) {
      if (id.startsWith('req:') || id.startsWith('route:')) infoProviders.delete(id);
    }
    world.replaceChildren();
    middlewareRowViews = [];
    const grid = document.createElement('div');
    grid.className = 'mw-grid';
    grid.style.left = `${String(middlewareGridLeft(band))}px`;
    grid.style.top = `${String(FLOW_MARGIN)}px`;
    grid.style.width = `${String(
      sides ? band.sideWidth * 2 + band.width + MIDDLEWARE_SIDE_GAP * 2 : band.width,
    )}px`;
    grid.style.columnGap = `${String(sides ? MIDDLEWARE_SIDE_GAP : 0)}px`;
    grid.style.gridTemplateColumns = sides
      ? `${String(band.sideWidth)}px ${String(band.width)}px ${String(band.sideWidth)}px`
      : `${String(band.width)}px`;
    const messages = rows.filter((row) => row.movement !== null).length;
    if (sides) {
      grid.append(
        middlewareTitle(
          'PETICIÓN FRONTEND',
          rows.filter((row) => row.frontend !== null || row.detail !== null).length,
          'peticiones',
          '→',
        ),
      );
    }
    grid.append(middlewareTitle('MIDDLEWARE JSON', messages, 'mensajes', '⇄'));
    if (sides) {
      grid.append(
        middlewareTitle(
          'PETICIÓN BACKEND',
          rows.filter((row) => row.backend !== null).length,
          'rutas',
          '←',
        ),
      );
    }
    if (rows.length === 0) {
      const capture = jsonCaptureLiveSet ? jsonCaptureLive : (state.jsonCapture ?? null);
      if (sides) grid.append(document.createElement('div'));
      grid.append(middlewareNote(jsonEmptyMessage(capture, 'middleware')));
      if (sides) grid.append(document.createElement('div'));
    }
    for (const row of rows) {
      const pick = rowPick(row);
      const movementId = row.movement?.id ?? null;
      const left =
        sides && (row.frontend !== null || row.movement !== null || row.detail !== null)
          ? mountInfoCard(
              cardForRequestSide(row.key, row.frontend, row.movement, pick),
              { variant: 'middleware', rows: 'all', className: 'mw-card is-frontend' },
              requestSideProvider(row.key, row.frontend?.id ?? null, movementId),
            )
          : null;
      const center =
        row.movement === null
          ? middlewareNote('Sin cuerpo JSON capturado para este intercambio.')
          : middlewareCard(row.movement);
      const right =
        sides && (row.backend !== null || row.movement !== null || row.detail !== null)
          ? mountInfoCard(
              cardForRouteSide(row.key, row.backend, row.movement, pick),
              { variant: 'middleware', rows: 'all', className: 'mw-card is-backend' },
              routeSideProvider(row.key, row.backend?.id ?? null, movementId),
            )
          : null;
      if (sides) grid.append(left ?? document.createElement('div'));
      grid.append(center);
      if (sides) grid.append(right ?? document.createElement('div'));
      middlewareRowViews.push({ row, left, center, right });
    }
    world.append(grid);
  }
  syncOverlayTransforms();
  const gridEl = world.firstElementChild;
  if (gridEl instanceof HTMLElement) {
    model.layout.height = Math.max(model.baseHeight, gridEl.offsetHeight + FLOW_MARGIN * 2);
    renderMiddlewareLinks(band);
  }
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

function reachableRequests(node: FlowNode): string[] {
  return reachableNodeList(node.id)
    .filter((item) => item.type === 'request')
    .sort(chronologicalNodes)
    .map(requestLine);
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

function renderDetail(node: FlowNode): void {
  const detail = element('map-detail');
  const children: HTMLElement[] = [
    mountInfoCard(cardForNode(node), { variant: 'detail', rows: 'all' }, nodeInfoProvider(node.id)),
  ];
  if (node.type === 'table') {
    const table = tableDataOf(node);
    const picked =
      table !== null && pickedCell !== null && pickedCell.tableId === table.id ? pickedCell : null;
    if (table !== null && picked !== null) {
      const card = cardForCell(table.id, picked.column, picked.rowIndex);
      if (card !== null) {
        children.push(
          mountInfoCard(
            card,
            { variant: 'detail', rows: 'all' },
            cellInfoProvider(table.id, picked.column, picked.rowIndex),
          ),
        );
      }
    }
  }
  detail.replaceChildren(...children);
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
    renderMiddleware();
  }
  syncJsonRail();
  hideSearchResults();
  renderStatus();
  highlightInPage(node);
  hideTip();
}

function clearSelection(): void {
  if (selectedId === null && focusScope === null && pickedCell === null) return;
  const hadFocus = focusScope !== null;
  const hadCell = pickedCell !== null;
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
  } else {
    applyFiltersAndSelection();
    mountCellRoutes();
    renderStatus();
  }
  if (hadCell) {
    renderMiddleware();
    syncJsonRail();
  }
}

function syncTipBlock(): void {
  const tip = document.getElementById('map-tip');
  if (tip !== null) tip.classList.toggle('is-frozen', tipFrozen);
  const block = document.getElementById('map-tip-block');
  if (block === null) return;
  block.hidden = !tipFrozen;
  block.textContent = 'bloquear';
}

function hideTipNow(): void {
  hoverCardId = null;
  tipSignature = '';
  const tip = document.getElementById('map-tip');
  if (tip === null) return;
  tip.hidden = true;
  document.getElementById('map-tip-card')?.replaceChildren();
  syncTipBlock();
}

function hideTip(): void {
  if (tipFrozen) return;
  hoverCardId = null;
  hoverProvider = null;
  hideTipNow();
}

function closeTip(): void {
  tipFrozen = false;
  hoverCardId = null;
  hoverProvider = null;
  hideTipNow();
}

function textFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function infoCardSignature(card: InfoCardModel): string {
  return [
    card.id,
    card.eyebrow,
    card.title,
    card.subtitle,
    card.status,
    card.tone,
    card.meta,
    card.expansion === null ? '' : card.expansion.expanded ? '1' : '0',
    card.chips.join(','),
    card.rows
      .map(
        (row) =>
          `${row.label}\u0000${row.value}\u0000${row.file ?? ''}\u0000${String(row.line ?? '')}\u0000${String(row.endLine ?? '')}`,
      )
      .join('\u0001'),
    card.sections
      .map(
        (section) =>
          `${section.id}\u0000${section.expanded ? '1' : '0'}\u0000${textFingerprint(section.text)}`,
      )
      .join('\u0001'),
    card.location === null
      ? ''
      : `${card.location.label}\u0000${card.location.value}\u0000${String(card.location.line ?? '')}`,
    card.footer?.label ?? '',
  ].join('\u0002');
}

function showTip(force = false): void {
  const tip = document.getElementById('map-tip');
  if (tip === null) return;
  if (!tipFrozen && !shiftHeld) {
    hideTipNow();
    return;
  }
  const card = hoverProvider?.() ?? null;
  if (card === null) {
    if (tipFrozen) {
      closeTip();
    } else {
      hideTipNow();
    }
    return;
  }
  const signature = infoCardSignature(card);
  if (force || signature !== tipSignature) {
    tipSignature = signature;
    const host = document.getElementById('map-tip-card');
    if (host !== null) {
      host.replaceChildren(renderInfoCard(card, { variant: 'tip', rows: 'all' }));
    }
  }
  tip.hidden = false;
  syncTipBlock();
  if (!tipFrozen) placeTip(tipPointerX, tipPointerY);
}

function refreshFrozenTip(): void {
  if (!tipFrozen) return;
  showTip();
}

function setMapShiftHeld(held: boolean): void {
  if (shiftHeld === held) return;
  shiftHeld = held;
  if (tipFrozen) return;
  if (held) {
    showTip();
  } else {
    hideTipNow();
  }
}

function toggleMapTipFreeze(): void {
  if (!state.open) return;
  if (tipFrozen) {
    tipFrozen = false;
    syncTipBlock();
    if (shiftHeld) {
      showTip();
    } else {
      hoverCardId = null;
      hoverProvider = null;
      hideTipNow();
    }
    return;
  }
  const provider = hoverProvider;
  if (hoverCardId === null || provider === null || provider() === null) return;
  tipFrozen = true;
  tipSignature = '';
  syncTipBlock();
  showTip(true);
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
    left = clientX - rect.left - width - 14;
  }
  if (top + height > canvas.clientHeight - 8) {
    top = clientY - rect.top - height - 12;
  }
  const maxLeft = Math.max(8, canvas.clientWidth - width - 8);
  const maxTop = Math.max(8, canvas.clientHeight - height - 8);
  tip.style.left = `${String(Math.round(clamp(left, 8, maxLeft)))}px`;
  tip.style.top = `${String(Math.round(clamp(top, 8, maxTop)))}px`;
}

function infoTargetAt(
  target: EventTarget | null,
): { id: string; provider: () => InfoCardModel | null } | null {
  if (!(target instanceof Element)) return null;
  const holder = target.closest('[data-card-id]');
  if (holder === null) return null;
  const id = holder.getAttribute('data-card-id');
  if (id === null || id === '') return null;
  const provider = infoProviders.get(id);
  return provider === undefined ? null : { id, provider };
}

function trackHover(event: PointerEvent): void {
  tipPointerX = event.clientX;
  tipPointerY = event.clientY;
  // El estado físico de Shift llega en el propio evento: así el tooltip funciona
  // aunque la ventana del mapa no tenga el foco del teclado.
  if (event.shiftKey !== shiftHeld) {
    shiftHeld = event.shiftKey;
    if (!shiftHeld && !tipFrozen) hideTipNow();
  }
  if (tipFrozen) return;
  const target = infoTargetAt(event.target);
  if ((target?.id ?? null) !== hoverCardId) {
    hoverCardId = target?.id ?? null;
    hoverProvider = target?.provider ?? null;
    tipSignature = '';
    if (shiftHeld) showTip();
    return;
  }
  if (!shiftHeld) {
    if (hoverCardId !== null) hideTipNow();
    return;
  }
  const tip = document.getElementById('map-tip');
  if (tip === null) return;
  if (tip.hidden) {
    showTip();
  } else {
    placeTip(tipPointerX, tipPointerY);
  }
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
  applyMiddlewareGeometry();
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
  renderDetail(node);
  // «Solo esos» sigue mandando: el enfoque se cruza con el subgrafo del evento
  // en vez de saltar a las peticiones generales de la sesión.
  applyScopeView();
  hideSearchResults();
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
  bindNodeInfo(button, node.id);
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
  bindNodeInfo(button, node.id);
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

function statusOption(key: string, count: number): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = `${statusKeyLabel(key)} (${String(count)})`;
  return option;
}

function compareStatusKeys(left: string, right: string): number {
  const leftCode = left.startsWith('code:') ? Number(left.slice(5)) : -1;
  const rightCode = right.startsWith('code:') ? Number(right.slice(5)) : -1;
  return leftCode - rightCode;
}

function renderStatusFilter(): void {
  const select = element<HTMLSelectElement>('map-status-filter');
  const counts = new Map<string, number>();
  if (model !== null) {
    for (const node of model.snapshot.nodes) {
      for (const key of statusFilterKeys(node)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  // El estado llega tarde: la clave elegida se conserva aunque todavía no haya coincidencias.
  const keys = new Set(counts.keys());
  if (statusFilter !== null) keys.add(statusFilter);
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Todos los estados';
  select.append(all);
  let available = 0;
  for (const category of STATUS_CATEGORY_ORDER) {
    const members = [...keys]
      .filter((key) => statusKeyCategory(key) === category)
      .sort(compareStatusKeys);
    if (members.length === 0) continue;
    const group = document.createElement('optgroup');
    group.label = STATUS_CATEGORY_LABEL[category];
    for (const key of members) group.append(statusOption(key, counts.get(key) ?? 0));
    select.append(group);
    available += members.length;
  }
  const special = [...keys].filter((key) => statusKeyCategory(key) === 'special').sort();
  if (special.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Sin estado HTTP';
    for (const key of special) group.append(statusOption(key, counts.get(key) ?? 0));
    select.append(group);
    available += special.length;
  }
  select.value = statusFilter ?? '';
  select.disabled = available === 0;
}

function addStatusBox(text: string, className: string): void {
  const box = document.createElement('div');
  box.className = className === '' ? 'box' : `box ${className}`;
  box.textContent = text;
  element('map-status').append(box);
}

function closeGuardOpen(): boolean {
  const guard = document.getElementById('map-close-guard');
  return guard !== null && !guard.hidden;
}

function hideCloseGuard(): void {
  const guard = document.getElementById('map-close-guard');
  if (guard !== null) guard.hidden = true;
}

function handleMapCloseBlocked(paths: readonly string[]): void {
  const guard = document.getElementById('map-close-guard');
  const text = document.getElementById('map-close-guard-text');
  if (guard === null || text === null) return;
  const dirty = dirtyCodePaths();
  const list = dirty.length > 0 ? dirty : paths;
  text.textContent = list.length === 0 ? 'Hay cambios sin guardar.' : list.join('\n');
  guard.hidden = false;
}

async function saveAndCloseMap(): Promise<void> {
  const saved = await saveAllCodeBuffers();
  if (!saved) return;
  hideCloseGuard();
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, false);
}

function discardAndCloseMap(): void {
  codeBuffers.clear();
  codeReveal.clear();
  pushCodeDirty();
  hideCloseGuard();
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, false);
}

function renderStatus(): void {
  const status = element('map-status');
  status.replaceChildren();
  if (!state.open) return;
  const dirty = dirtyCodePaths();
  if (dirty.length > 0) {
    addStatusBox(
      `${String(dirty.length)} ${
        dirty.length === 1 ? 'archivo sin guardar' : 'archivos sin guardar'
      } · Ctrl+S para guardar`,
      'is-warn',
    );
  }
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
  if (statusFilter !== null && model !== null) {
    const key = statusFilter;
    const matches = statusMatchCount(key);
    const box = document.createElement('div');
    box.className = matches === 0 ? 'box is-empty' : 'box';
    const text = document.createElement('span');
    text.textContent =
      matches === 0
        ? `Sin peticiones con estado ${statusKeyLabel(key)}.`
        : `Estado ${statusKeyLabel(key)}: ${String(matches)} ${
            matches === 1 ? 'petición' : 'peticiones'
          } · ${String(model.viewNodes.length)} nodos visibles`;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'action';
    action.textContent = 'Quitar filtro';
    action.addEventListener('click', () => {
      setStatusFilter(null);
      renderStatusFilter();
    });
    box.append(text, action);
    status.append(box);
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
  closeTip();
  closeNodeMenu();
  hideCloseGuard();
  shiftHeld = false;
  selectedId = null;
  selectionHighlight = false;
  highlightScope = null;
  eventFilter = null;
  eventOnly = false;
  statusFilter = null;
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
  expandedNodes.clear();
  expandedHeights.clear();
  sectionExpanded.clear();
  searchTerm = '';
  element<HTMLInputElement>('map-search').value = '';
  hideSearchResults();
  viewReady = false;
  const detail = element('map-detail');
  detail.hidden = true;
  detail.replaceChildren();
}

interface StackStage {
  id: 'html' | 'frontend' | 'backend' | 'database';
  tech: string;
  meta: string;
  title: string;
  types: FlowNodeType[];
  missing: boolean;
  runtime: boolean;
}

function cardForStage(stage: StackStage, snapshot: FlowSnapshot): InfoCardModel {
  const rows: InfoRow[] = [];
  const counts = new Map<FlowNodeType, number>();
  for (const node of snapshot.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  pushInfoRow(rows, 'Capa', stage.types.map((type) => TYPE_LABEL[type]).join(' · '));
  pushInfoRow(
    rows,
    'Nodos',
    stage.types.map((type) => `${TYPE_LABEL[type]}: ${String(counts.get(type) ?? 0)}`).join(' · '),
  );
  pushInfoRow(rows, 'Resumen', stage.meta);
  pushInfoRow(rows, 'Descripción', stage.title);
  pushInfoRow(rows, 'Estado', stage.missing ? 'sin detectar' : 'detectado');
  pushInfoRow(rows, 'Evidencia', stage.runtime ? 'RUNTIME' : 'STATIC');
  const ids = snapshot.nodes
    .filter((node) => stage.types.includes(node.type))
    .map((node) => node.id);
  return infoCard({
    id: `stage:${stage.id}`,
    eyebrow: 'Etapa de la cadena',
    title: stage.tech,
    subtitle: stage.meta,
    status: stage.missing ? 'sin detectar' : '',
    tone: stage.missing ? 'warn' : stage.runtime ? 'ok' : 'neutral',
    chips: [stage.runtime ? 'RUNTIME' : 'STATIC'],
    rows,
    footer:
      ids.length === 0
        ? null
        : {
            label: 'Enfocar etapa',
            onClick: () => {
              focusStage(stage.types);
            },
          },
  });
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
      id: 'html',
      tech: 'HTML',
      meta: pageMeta,
      title: 'Página HTML inspeccionada',
      types: ['structure', 'asset', 'element'],
      missing: false,
      runtime: interactions > 0,
    },
    {
      id: 'frontend',
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
      id: 'backend',
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
      id: 'database',
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
    bindStageInfo(button, stage.id);
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
    hideCloseGuard();
    hideMiddleware();
    clearNodeCards();
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
    jsonRouteByHandler = new Map();
    jsonRequestByRoute = new Map();
    jsonRouteByRequest = new Map();
    clearNodeCards();
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
    hideMiddleware();
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
    renderStatusFilter();
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
      renderStatusFilter();
      const viewScope = scopeForView();
      applyDisplayScope(viewScope);
      renderSearchResults();
      renderGraph();
      if (focusScope !== null || eventOnly || statusFilter !== null) {
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
  const statusSelect = element<HTMLSelectElement>('map-status-filter');

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

  element<HTMLButtonElement>('map-guard-save').addEventListener('click', () => {
    void saveAndCloseMap();
  });
  element<HTMLButtonElement>('map-guard-discard').addEventListener('click', () => {
    discardAndCloseMap();
  });
  element<HTMLButtonElement>('map-guard-cancel').addEventListener('click', () => {
    hideCloseGuard();
  });

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
  statusSelect.addEventListener('change', () => {
    setStatusFilter(statusSelect.value === '' ? null : statusSelect.value);
  });

  const onMapWheel = (event: WheelEvent): void => {
    if (!state.open) return;
    const target = event.target;
    if (target instanceof Element) {
      const body = target.closest('.info-body');
      if (body instanceof HTMLElement && body.scrollHeight > body.clientHeight) return;
    }
    event.preventDefault();
    closeNodeMenu();
    hideTip();
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    zoomAt(px, py, Math.exp(-event.deltaY * 0.0015));
  };
  svg.addEventListener('wheel', onMapWheel, { passive: false });
  const middlewareHost = document.getElementById('map-middleware');
  if (middlewareHost !== null) {
    middlewareHost.addEventListener('wheel', onMapWheel, { passive: false });
  }
  const cardsHost = document.getElementById('map-cards');
  if (cardsHost !== null) {
    cardsHost.addEventListener('wheel', onMapWheel, { passive: false });
  }
  const mapRoot = element('map');
  mapRoot.addEventListener('pointermove', (event) => {
    if (!state.open || pan !== null || columnResize !== null) return;
    trackHover(event);
  });
  mapRoot.addEventListener('pointerleave', () => {
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
    const target = event.target;
    const editing =
      target instanceof HTMLTextAreaElement && target.classList.contains('info-editor');
    if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      ctrlPending = false;
      saveCodeFromKeyboard();
      return;
    }
    if (event.key === 'Shift') {
      if (!editing) setMapShiftHeld(true);
      return;
    }
    // Ctrl alterna el bloqueo solo en pulsación corta: Ctrl+S es un acorde y no debe bloquear.
    if (event.key === 'Control') {
      if (event.repeat) return;
      ctrlPending = !editing;
      return;
    }
    ctrlPending = false;
    if (event.key !== 'Escape') return;
    if (editing) {
      target.blur();
      return;
    }
    if (closeGuardOpen()) {
      hideCloseGuard();
      return;
    }
    if (tipFrozen) {
      closeTip();
      return;
    }
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
    if (event.key === 'Shift') {
      setMapShiftHeld(false);
      return;
    }
    if (event.key !== 'Control' || !ctrlPending) return;
    ctrlPending = false;
    toggleMapTipFreeze();
  });
  window.addEventListener('blur', () => {
    setMapShiftHeld(false);
    ctrlPending = false;
    closeNodeMenu();
  });
}

export {
  applyFlowJsonState,
  applyFlowMapState,
  applyFlowRequestState,
  handleMapCloseBlocked,
  initFlowMap,
  setMapShiftHeld,
};
