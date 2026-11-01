import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  FLOW_INTERACTION_EVENTS,
  type FlowEdge,
  type FlowElementKind,
  type FlowInteractionEvent,
  type FlowMapState,
  type FlowNode,
  type FlowNodeType,
  type FlowSnapshot,
} from '@bdt/protocol';
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  layoutFlow,
  type FlowLayout,
  type FlowPlacedNode,
} from './flow-layout';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2.5;
const PAGE_SIZE = 20;
const CULL_MARGIN = 280;
const BUNDLE_JUNCTION_GAP = 44;

type TrafficMode = 'all' | 'interacted';
type FocusDirection = 'forward' | 'both';

const SEARCH_TYPE_ORDER: Record<FlowNodeType, number> = {
  element: 0,
  handler: 1,
  request: 2,
  route: 3,
  function: 4,
  query: 5,
  table: 6,
  database: 7,
};

const TYPE_LABEL: Record<FlowNodeType, string> = {
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

const OUTCOME_LABEL: Record<string, string> = {
  pending: 'pendiente',
  finished: 'completada',
  failed: 'fallida',
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
  className: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

let initialized = false;
let state: FlowMapState = { open: false, building: false, error: null, snapshot: null };
let model: GraphModel | null = null;
let selectedId: string | null = null;
let currentCardRequests = new Set<string>();
let searchTerm = '';
let trafficMode: TrafficMode = 'all';
let eventFilter: FlowInteractionEvent | null = null;
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
let edgePlans: EdgePlan[] = [];
let nodeViews = new Map<string, { node: FlowNode; group: SVGGElement }>();
let edgeViews = new Map<string, { plan: EdgePlan; path: SVGPathElement }>();
let filterVisibility = new Map<string, boolean>();
let viewportFrame = 0;
let resizeObserver: ResizeObserver | null = null;
let traceButtons = new Map<string, HTMLButtonElement>();

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

function svgText(className: string, x: number, y: number, value: string): SVGTextElement {
  const node = svgElement('text', {
    class: className,
    x: String(x),
    y: String(y),
  });
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

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function evidenceClass(evidence: readonly string[]): string {
  const runtime = evidence.includes('RUNTIME');
  const staticEvidence = evidence.includes('STATIC');
  if (runtime && staticEvidence) return 'is-both';
  return runtime ? 'is-runtime' : '';
}

function arrowMarker(evidence: readonly string[]): string {
  const runtime = evidence.includes('RUNTIME');
  const staticEvidence = evidence.includes('STATIC');
  if (runtime && staticEvidence) return 'url(#flow-arrow-both)';
  return runtime ? 'url(#flow-arrow-runtime)' : 'url(#flow-arrow-static)';
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
  if (node.file !== null) {
    const line = node.line === null ? '' : `:${String(node.line)}`;
    parts.push(`${node.file}${line}`);
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

function edgeTooltip(edge: FlowEdge): string {
  const parts = [
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
    if (current === undefined) continue;
    for (const next of outgoing.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return reachable;
}

function prepare(snapshot: FlowSnapshot): void {
  const layout = layoutFlow(snapshot);
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
    placed.x + FLOW_NODE_WIDTH >= bounds.minX &&
    placed.x <= bounds.maxX &&
    placed.y + FLOW_NODE_HEIGHT >= bounds.minY &&
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

function updateVisibleViews(): void {
  if (model === null || viewport === null) return;
  const bounds = worldBounds();
  if (bounds === null) return;

  for (const placed of model.layout.nodes) {
    const mounted = nodeViews.get(placed.node.id);
    if (nodeInBounds(placed, bounds)) {
      if (mounted === undefined) mountNode(placed);
    } else if (mounted !== undefined) {
      mounted.group.remove();
      nodeViews.delete(placed.node.id);
    }
  }

  for (const plan of edgePlans) {
    const mounted = edgeViews.get(plan.id);
    if (planInBounds(plan, bounds)) {
      if (mounted === undefined) mountPlan(plan);
    } else if (mounted !== undefined) {
      mounted.path.remove();
      edgeViews.delete(plan.id);
    }
  }
}

function applyView(): void {
  if (viewport === null) return;
  viewport.setAttribute(
    'transform',
    `translate(${String(view.x)} ${String(view.y)}) scale(${String(view.k)})`,
  );
  scheduleViewportUpdate();
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
  const k = clamp(
    Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height),
    MIN_ZOOM,
    1.15,
  );
  view = {
    k,
    x: (rect.width - width * k) / 2,
    y: (rect.height - height * k) / 2,
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
    maxX = Math.max(maxX, placed.x + FLOW_NODE_WIDTH);
    maxY = Math.max(maxY, placed.y + FLOW_NODE_HEIGHT);
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
  const k = clamp(
    Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  view = {
    k,
    x: rect.width / 2 - (minX + width / 2) * k,
    y: rect.height / 2 - (minY + height / 2) * k,
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

function mergedEdgeTooltip(target: FlowNode, edges: readonly FlowEdge[]): string {
  const kinds = edges.map(
    (edge) =>
      `${edge.type}${edge.occurrences > 1 ? ` ×${String(edge.occurrences)}` : ''}${
        edge.correlation === 'heuristic' ? ' (heurística)' : ''
      }`,
  );
  const parts = [
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

function edgeClassName(evidence: readonly string[], heuristic: boolean, bundle: boolean): string {
  let name = 'flow-edge';
  const evidenceName = evidenceClass(evidence);
  if (evidenceName !== '') name += ` ${evidenceName}`;
  if (heuristic) name += ' is-heuristic';
  if (bundle) name += ' is-bundle';
  return name;
}

function planBBox(x1: number, y1: number, x2: number, y2: number): EdgePlan['bbox'] {
  return {
    minX: Math.min(x1, x2) - 8,
    minY: Math.min(y1, y2) - 8,
    maxX: Math.max(x1, x2) + 8,
    maxY: Math.max(y1, y2) + 8,
  };
}

function edgePath(sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const bend = Math.max(36, Math.abs(targetX - sourceX) / 2);
  return `M ${String(sourceX)} ${String(sourceY)} C ${String(sourceX + bend)} ${String(
    sourceY,
  )}, ${String(targetX - bend)} ${String(targetY)}, ${String(targetX)} ${String(targetY)}`;
}

function buildEdgePlans(): EdgePlan[] {
  if (model === null) return [];
  const positions = model.layout.positions;
  const forward = new Map<string, Map<string, FlowEdge[]>>();
  const backward: FlowEdge[] = [];
  for (const edge of model.viewEdges) {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    if (source === undefined || target === undefined) continue;
    if (source.x + FLOW_NODE_WIDTH > target.x) {
      backward.push(edge);
      continue;
    }
    let bySource = forward.get(edge.to);
    if (bySource === undefined) {
      bySource = new Map();
      forward.set(edge.to, bySource);
    }
    const list = bySource.get(edge.from);
    if (list === undefined) {
      bySource.set(edge.from, [edge]);
    } else {
      list.push(edge);
    }
  }

  const plans: EdgePlan[] = [];
  for (const edge of backward) {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    if (source === undefined || target === undefined) continue;
    const sourceX = source.x + FLOW_NODE_WIDTH;
    const sourceY = source.y + FLOW_NODE_HEIGHT / 2;
    const targetX = target.x;
    const targetY = target.y + FLOW_NODE_HEIGHT / 2;
    plans.push({
      id: `edge:${edge.id}`,
      kind: 'edge',
      sources: [edge.from],
      to: edge.to,
      edgeIds: [edge.id],
      tooltip: edgeTooltip(edge),
      d: edgePath(sourceX, sourceY, targetX, targetY),
      marker: arrowMarker(edge.evidence),
      className: edgeClassName(edge.evidence, edge.correlation === 'heuristic', false),
      bbox: planBBox(sourceX, sourceY, targetX, targetY),
    });
  }

  for (const [targetId, bySource] of forward) {
    const targetNode = model.nodesById.get(targetId);
    const target = positions.get(targetId);
    if (targetNode === undefined || target === undefined) continue;
    const sourceIds = [...bySource.keys()];
    const firstSourceId = sourceIds[0];
    if (firstSourceId === undefined) continue;

    if (sourceIds.length === 1) {
      const source = positions.get(firstSourceId);
      const edges = bySource.get(firstSourceId) ?? [];
      if (source === undefined || edges.length === 0) continue;
      const sourceX = source.x + FLOW_NODE_WIDTH;
      const sourceY = source.y + FLOW_NODE_HEIGHT / 2;
      const targetX = target.x;
      const targetY = target.y + FLOW_NODE_HEIGHT / 2;
      const evidence = mergeEvidence(edges);
      const first = edges[0];
      plans.push({
        id: `edge:${targetId}:${firstSourceId}`,
        kind: 'edge',
        sources: [firstSourceId],
        to: targetId,
        edgeIds: edges.map((edge) => edge.id),
        tooltip:
          edges.length === 1 && first !== undefined
            ? edgeTooltip(first)
            : mergedEdgeTooltip(targetNode, edges),
        d: edgePath(sourceX, sourceY, targetX, targetY),
        marker: arrowMarker(evidence),
        className: edgeClassName(
          evidence,
          edges.some((edge) => edge.correlation === 'heuristic'),
          false,
        ),
        bbox: planBBox(sourceX, sourceY, targetX, targetY),
      });
      continue;
    }

    const junctionX = target.x - BUNDLE_JUNCTION_GAP;
    const placedSources: Array<{
      sourceId: string;
      edges: FlowEdge[];
      x: number;
      y: number;
    }> = [];
    let sumY = 0;
    for (const sourceId of sourceIds) {
      const source = positions.get(sourceId);
      if (source === undefined) continue;
      const sourceX = source.x + FLOW_NODE_WIDTH;
      const sourceY = source.y + FLOW_NODE_HEIGHT / 2;
      sumY += sourceY;
      placedSources.push({ sourceId, edges: bySource.get(sourceId) ?? [], x: sourceX, y: sourceY });
    }
    if (placedSources.length === 0) continue;
    const junctionY = sumY / placedSources.length;

    for (const item of placedSources) {
      const evidence = mergeEvidence(item.edges);
      const first = item.edges[0];
      const bend = Math.max(24, (junctionX - item.x) / 2);
      plans.push({
        id: `branch:${targetId}:${item.sourceId}`,
        kind: 'branch',
        sources: [item.sourceId],
        to: targetId,
        edgeIds: item.edges.map((edge) => edge.id),
        tooltip:
          item.edges.length === 1 && first !== undefined
            ? edgeTooltip(first)
            : mergedEdgeTooltip(targetNode, item.edges),
        d: `M ${String(item.x)} ${String(item.y)} C ${String(item.x + bend)} ${String(
          item.y,
        )}, ${String(junctionX - bend)} ${String(junctionY)}, ${String(junctionX)} ${String(
          junctionY,
        )}`,
        marker: '',
        className: edgeClassName(
          evidence,
          item.edges.some((edge) => edge.correlation === 'heuristic'),
          true,
        ),
        bbox: planBBox(item.x, item.y, junctionX, junctionY),
      });
    }

    const allEdges = placedSources.flatMap((item) => item.edges);
    const trunkEvidence = mergeEvidence(allEdges);
    const targetX = target.x;
    const targetY = target.y + FLOW_NODE_HEIGHT / 2;
    const trunkBend = Math.max(18, (targetX - junctionX) / 2);
    const latest = lastSeenOf(allEdges);
    const tooltipParts = [
      `Flechas convergentes hacia ${TYPE_LABEL[targetNode.type]} ${targetNode.title}`,
      `${String(placedSources.length)} orígenes · ${String(
        allEdges.length,
      )} conexiones agrupadas en un solo tronco`,
    ];
    if (latest > 0) tooltipParts.push(`Visto: ${clock(latest)}`);
    plans.push({
      id: `trunk:${targetId}`,
      kind: 'trunk',
      sources: placedSources.map((item) => item.sourceId),
      to: targetId,
      edgeIds: allEdges.map((edge) => edge.id),
      tooltip: tooltipParts.join('\n'),
      d: `M ${String(junctionX)} ${String(junctionY)} C ${String(
        junctionX + trunkBend,
      )} ${String(junctionY)}, ${String(targetX - trunkBend)} ${String(targetY)}, ${String(
        targetX,
      )} ${String(targetY)}`,
      marker: arrowMarker(trunkEvidence),
      className: edgeClassName(
        trunkEvidence,
        allEdges.some((edge) => edge.correlation === 'heuristic'),
        true,
      ),
      bbox: planBBox(junctionX, junctionY, targetX, targetY),
    });
  }
  return plans;
}

function mountPlan(plan: EdgePlan): void {
  const attributes: Record<string, string> = { class: plan.className, d: plan.d };
  if (plan.marker !== '') attributes['marker-end'] = plan.marker;
  const path = svgElement('path', attributes);
  if (plan.tooltip !== '') {
    const tooltip = svgElement('title');
    tooltip.textContent = plan.tooltip;
    path.append(tooltip);
  }
  const layer = plan.kind === 'trunk' ? trunkLayer : branchLayer;
  if (layer !== null) layer.append(path);
  const view = { plan, path };
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
  viewport = null;
  branchLayer = null;
  trunkLayer = null;
  nodeLayer = null;
  if (model === null) return;

  const defs = svgElement('defs');
  const markers: Array<[string, string]> = [
    ['flow-arrow-static', '#6e7f8f'],
    ['flow-arrow-runtime', '#3fb950'],
    ['flow-arrow-both', '#58a6ff'],
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
  svg.append(group);

  const branches = svgElement('g');
  const trunks = svgElement('g');
  const nodes = svgElement('g');
  branchLayer = branches;
  trunkLayer = trunks;
  nodeLayer = nodes;
  group.append(branches, trunks, nodes);

  for (const layer of model.layout.layers) {
    const tech = layerTech(model.snapshot, layer.type);
    const layerLabel = layer.type === 'element' ? 'CONTROLES' : TYPE_LABEL[layer.type];
    const caption = `${layerLabel} · ${String(layer.count)}${tech === null ? '' : ` · ${tech}`}`;
    group.append(svgText('flow-layer-label', layer.x, 24, caption));
  }

  edgePlans = buildEdgePlans();
  applyFiltersAndSelection();
  if (!viewReady) {
    fitView();
  } else {
    applyView();
  }
  updateVisibleViews();
}

function createNodeGroup(placed: FlowPlacedNode): SVGGElement {
  const node = placed.node;
  const group = svgElement('g', {
    class: `flow-node${evidenceClass(node.evidence) === '' ? '' : ` ${evidenceClass(node.evidence)}`}`,
    transform: `translate(${String(placed.x)} ${String(placed.y)})`,
  });
  if (node.type === 'element') {
    group.classList.toggle('is-hidden', node.visible === false);
    group.classList.toggle('is-disabled', node.disabled === true);
  }
  const tooltip = svgElement('title');
  tooltip.textContent = nodeTooltip(node);
  group.append(tooltip);
  group.append(
    svgElement('rect', {
      class: 'box',
      x: '0',
      y: '0',
      width: String(FLOW_NODE_WIDTH),
      height: String(FLOW_NODE_HEIGHT),
    }),
  );
  group.append(
    svgElement('rect', {
      class: 'bar',
      x: '0',
      y: '0',
      width: '3',
      height: String(FLOW_NODE_HEIGHT),
    }),
  );
  group.append(svgText('type', 10, 14, nodeTypeLabel(node)));
  const total = eventTotal(node);
  if (total > 0) {
    group.append(svgText('badge', FLOW_NODE_WIDTH - 8, 14, `${String(total)}×`));
  }
  const seen = node.firstSeen > 0 ? clock(node.firstSeen) : '';
  group.append(svgText('title', 10, 28, truncate(node.title, 28)));
  if (node.subtitle !== null && node.subtitle !== '') {
    group.append(svgText('sub', 10, 41, truncate(node.subtitle, seen === '' ? 33 : 21)));
  }
  if (seen !== '') {
    group.append(svgText('time', FLOW_NODE_WIDTH - 8, 41, seen));
  }
  group.addEventListener('click', (event) => {
    event.stopPropagation();
    selectNode(node.id);
  });
  return group;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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
    node.type === 'element' ? nodeTypeLabel(node) : null,
  ];
  for (const table of node.tablesRead ?? []) parts.push(table);
  for (const table of node.tablesWritten ?? []) parts.push(table);
  for (const hint of node.handlers ?? []) {
    parts.push(hint.name, hint.source, hint.event);
  }
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

function syncTrafficButtons(): void {
  const all = element<HTMLButtonElement>('map-scope-all');
  const interacted = element<HTMLButtonElement>('map-scope-interacted');
  all.classList.toggle('is-on', trafficMode === 'all');
  interacted.classList.toggle('is-on', trafficMode === 'interacted');
  all.setAttribute('aria-pressed', trafficMode === 'all' ? 'true' : 'false');
  interacted.setAttribute('aria-pressed', trafficMode === 'interacted' ? 'true' : 'false');
}

function setTrafficMode(mode: TrafficMode): void {
  trafficMode = mode;
  syncTrafficButtons();
  if (!state.open) return;
  focusScope = null;
  focusOriginId = null;
  focusDirection = 'both';
  hideSearchResults();
  const scope = trafficScope();
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
  const isNeighbor =
    selectedId !== null &&
    selectedId !== view.node.id &&
    (model?.neighbors.get(selectedId)?.has(view.node.id) ?? false);
  const visibleNode = filterVisibility.get(view.node.id) ?? true;
  const selectionDim = focusScope === null && selectedId !== null && !isSelected && !isNeighbor;
  view.group.classList.toggle('is-selected', isSelected);
  view.group.classList.toggle('is-neighbor', isNeighbor);
  view.group.classList.toggle('is-dimmed', !visibleNode || selectionDim);
}

function applyPlanViewState(view: { plan: EdgePlan; path: SVGPathElement }): void {
  const plan = view.plan;
  const targetVisible = filterVisibility.get(plan.to) ?? true;
  const sourceVisible =
    plan.kind === 'trunk'
      ? plan.sources.some((id) => filterVisibility.get(id) ?? true)
      : plan.sources.every((id) => filterVisibility.get(id) ?? true);
  const lit = selectedId !== null && (plan.to === selectedId || plan.sources.includes(selectedId));
  const selectionDim = focusScope === null && selectedId !== null && !lit;
  view.path.classList.toggle('is-lit', lit);
  view.path.classList.toggle('is-dimmed', !targetVisible || !sourceVisible || selectionDim);
}

function applyFiltersAndSelection(): void {
  if (model === null) return;
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

function addRow(container: HTMLElement, label: string, value: string | null): void {
  if (value === null || value === '') return;
  const row = document.createElement('div');
  row.className = 'row';
  const key = document.createElement('div');
  key.className = 'label';
  key.textContent = label;
  const text = document.createElement('div');
  text.className = 'value';
  text.textContent = value;
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
  if (node.statusCode !== null && node.statusCode !== undefined) {
    parts.push(String(node.statusCode));
  }
  if (node.outcome !== null && node.outcome !== undefined) {
    parts.push(OUTCOME_LABEL[node.outcome] ?? node.outcome);
  }
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

function routeLine(node: FlowNode): string {
  const method = node.method ?? 'GET';
  const path = node.path ?? node.title;
  const location =
    node.file === null ? '' : ` · ${node.file}${node.line === null ? '' : `:${String(node.line)}`}`;
  const time = node.firstSeen > 0 ? `${clock(node.firstSeen)} · ` : '';
  return `${time}${method} ${path}${location} · ${node.evidence.includes('RUNTIME') ? 'RUNTIME' : 'STATIC'}`;
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

function reachableRoutes(node: FlowNode): string[] {
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

function pagedList(items: readonly string[]): HTMLElement {
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
      row.textContent = item;
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
  items: readonly string[],
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
    const handlers = (node.handlers ?? []).map(
      (hint) => `${eventLabel(hint.event)} → ${hint.name ?? 'anónimo'} (${hint.source})`,
    );
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
  addRow(detail, 'Ubicación', locationText(node));
  if (node.method !== null && node.path !== null) {
    addRow(detail, 'Camino', `${node.method} ${node.path}`);
  }
  addRow(detail, 'URL', node.url);
  addRow(detail, 'Petición', requestSummary(node));
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
  if (node === undefined || node.type !== 'element') return null;
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
  const target = pageElementFor(node);
  if (target === null) return;
  const selector = pageSelector(target);
  if (selector === null) return;
  const key = target.id.startsWith('element:') ? target.id.slice('element:'.length) : null;
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.highlight, { key, selector });
}

function selectNode(id: string): void {
  const node = model?.nodesById.get(id);
  if (node === undefined) return;
  selectedId = id;
  focusDirection = 'both';
  focusScope = involvedScope(id, focusDirection);
  focusOriginId = id;
  eventFilter = null;
  element<HTMLSelectElement>('map-event').value = '';
  renderDetail(node);
  applyDisplayScope(focusScope);
  renderGraph();
  fitToNodes([...focusScope]);
  hideSearchResults();
  renderStatus();
  highlightInPage(node);
}

function clearSelection(): void {
  if (selectedId === null && focusScope === null) return;
  const hadFocus = focusScope !== null;
  selectedId = null;
  focusScope = null;
  focusOriginId = null;
  focusDirection = 'both';
  const detail = element('map-detail');
  detail.hidden = true;
  detail.replaceChildren();
  if (hadFocus && model !== null) {
    applyDisplayScope(trafficScope());
    renderGraph();
    fitView();
  } else {
    applyFiltersAndSelection();
  }
  renderStatus();
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

function applyDisplayScope(scope: Set<string> | null): void {
  if (model === null) return;
  if (scope === null) {
    model.viewNodes = model.snapshot.nodes;
    model.viewEdges = model.snapshot.edges;
    model.layout = layoutFlow(model.snapshot);
    return;
  }
  const nodes = model.snapshot.nodes.filter((node) => scope.has(node.id));
  const edges = model.snapshot.edges.filter((edge) => scope.has(edge.from) && scope.has(edge.to));
  model.viewNodes = nodes;
  model.viewEdges = edges;
  model.layout = layoutFlow({ ...model.snapshot, nodes, edges });
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
  eventFilter = null;
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

function searchResultButton(node: FlowNode): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-result';
  button.classList.toggle('is-selected', selectedId === node.id);
  const tag = document.createElement('span');
  tag.className = 'tag';
  const location =
    node.file === null
      ? ''
      : ` · ${truncate(node.file, 34)}${node.line === null ? '' : `:${String(node.line)}`}`;
  tag.textContent = `${nodeTypeLabel(node)}${location}`;
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
  const stats = element('map-stats');
  const snapshot = state.snapshot;
  if (snapshot === null) {
    stats.textContent = '';
    return;
  }
  const data = snapshot.stats;
  const parts = [
    `${String(data.interactions)} interacciones`,
    `${String(data.controls)} controles`,
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
  if (state.building) parts.push('actualizando…');
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
  if (eventFilter !== null && !counts.has(eventFilter)) eventFilter = null;
  const available = FLOW_INTERACTION_EVENTS.filter((event) => counts.has(event));
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
  selectedId = null;
  eventFilter = null;
  focusScope = null;
  focusOriginId = null;
  focusDirection = 'both';
  trafficMode = 'all';
  syncTrafficButtons();
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
      types: ['element'],
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
    nodeViews = new Map();
    edgeViews = new Map();
    edgePlans = [];
    filterVisibility = new Map();
    viewport = null;
    branchLayer = null;
    trunkLayer = null;
    nodeLayer = null;
    if (viewportFrame !== 0) {
      cancelAnimationFrame(viewportFrame);
      viewportFrame = 0;
    }
    svgById('map-svg').replaceChildren();
    if (selectedId !== null || focusScope !== null) {
      selectedId = null;
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
      if (focusOriginId !== null) {
        if (model?.nodesById.has(focusOriginId) === true) {
          focusScope = involvedScope(focusOriginId, focusDirection);
        } else {
          focusScope = null;
          focusOriginId = null;
          focusDirection = 'both';
        }
      }
      applyDisplayScope(focusScope ?? trafficScope());
      renderEventFilter();
      renderSearchResults();
      renderGraph();
      if (focusScope !== null) {
        fitToNodes([...focusScope]);
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
  element<HTMLButtonElement>('map-scope-all').addEventListener('click', () => {
    setTrafficMode('all');
  });
  element<HTMLButtonElement>('map-scope-interacted').addEventListener('click', () => {
    setTrafficMode('interacted');
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
    applyFiltersAndSelection();
  });

  svg.addEventListener(
    'wheel',
    (event) => {
      if (!state.open) return;
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      zoomAt(px, py, Math.exp(-event.deltaY * 0.0015));
    },
    { passive: false },
  );

  svg.addEventListener('pointerdown', (event) => {
    if (!state.open || event.button !== 0) return;
    hideSearchResults();
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
    if (!moved) clearSelection();
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.open) return;
    if (!results.hidden) {
      hideSearchResults();
      return;
    }
    ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, false);
  });
}

export { applyFlowMapState, initFlowMap, setFlowCardRequests };
