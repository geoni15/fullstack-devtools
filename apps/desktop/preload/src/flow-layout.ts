import type { FlowEdgeType, FlowNode, FlowNodeType, FlowSnapshot } from '@bdt/protocol';

export const FLOW_NODE_WIDTH = 210;
export const FLOW_NODE_HEIGHT = 48;
export const FLOW_NODE_COMPACT_HEIGHT = 30;
const ROW_GAP = 20;
const COMPACT_ROW_GAP = 12;
const LAYER_GAP = 176;
const FRONTEND_BACKEND_GAP = LAYER_GAP * 7.5;
const MARGIN = 48;
const HIERARCHY_H_GAP = 48;
const HIERARCHY_V_GAP = 164;
const COMPACT_HIERARCHY_V_GAP = 96;
const HIERARCHY_ROOT_GAP = 240;

const FRONTEND_LAYERS = new Set<FlowNodeType>([
  'file',
  'structure',
  'asset',
  'element',
  'handler',
  'request',
]);

function layerGap(left: FlowNodeType, right: FlowNodeType): number {
  return FRONTEND_LAYERS.has(left) && !FRONTEND_LAYERS.has(right)
    ? FRONTEND_BACKEND_GAP
    : LAYER_GAP;
}

export type FlowLayoutMode = 'chronological' | 'hierarchical' | 'structural';

export interface FlowLayoutOptions {
  compact?: boolean;
  widthOf?: (node: FlowNode) => number;
  heightOf?: (node: FlowNode) => number;
}

export const FLOW_LAYERS: readonly FlowNodeType[] = [
  'file',
  'structure',
  'asset',
  'element',
  'handler',
  'request',
  'route',
  'function',
  'query',
  'table',
  'database',
];

const HIERARCHY_TYPE_ORDER: Record<FlowNodeType, number> = {
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

const PARENT_PRIORITY: Partial<Record<FlowEdgeType, number>> = {
  CONTAINS: 100,
  TRIGGERS: 95,
  SENDS: 90,
  MATCHES: 85,
  HANDLES: 80,
  QUERIES: 75,
  READS: 70,
  WRITES: 70,
  USES: 65,
  SUBMITS: 60,
  NAVIGATES: 60,
  RENDERS: 55,
  PROVENANCE: 50,
};

export interface FlowPlacedNode {
  node: FlowNode;
  x: number;
  y: number;
  layer: number;
  width: number;
  height: number;
}

export interface FlowLayerInfo {
  type: FlowNodeType;
  x: number;
  count: number;
  width?: number;
  label?: string;
  y?: number;
}

export interface FlowLayout {
  mode: FlowLayoutMode;
  nodes: FlowPlacedNode[];
  positions: Map<string, FlowPlacedNode>;
  layers: FlowLayerInfo[];
  width: number;
  height: number;
}

interface ParentCandidate {
  parentId: string;
  priority: number;
  lastSeen: number;
}

function timeKey(node: FlowNode): number {
  return node.firstSeen > 0 ? node.firstSeen : Number.POSITIVE_INFINITY;
}

function chronological(left: FlowNode, right: FlowNode): number {
  const leftTime = timeKey(left);
  const rightTime = timeKey(right);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  if (left.lastSeen !== right.lastSeen) return left.lastSeen - right.lastSeen;
  return left.title.localeCompare(right.title, 'es') || left.id.localeCompare(right.id);
}

function domOrderKey(selector: string): string {
  return selector.replace(
    /:nth-of-type\((\d+)\)/g,
    (_match, value: string) => `:nth-of-type(${value.padStart(6, '0')})`,
  );
}

function padded(value: number): string {
  return String(Math.max(0, value)).padStart(9, '0');
}

function structuralKey(node: FlowNode): string {
  if (node.type === 'file') return `0\u0000${node.file ?? node.title}`;
  if (node.type === 'element' || node.type === 'structure' || node.type === 'asset') {
    return `1\u0000${node.pageUrl ?? ''}\u0000${domOrderKey(node.selector ?? '')}\u0000${node.title}`;
  }
  if (node.file !== null) {
    return `2\u0000${node.file}\u0000${padded(node.line ?? 0)}\u0000${padded(
      node.endLine ?? 0,
    )}\u0000${node.title}`;
  }
  if (node.type === 'request') {
    return `3\u0000${node.method ?? ''}\u0000${node.path ?? node.url ?? ''}\u0000${node.title}`;
  }
  return `4\u0000${node.title}`;
}

function structuralOrder(left: FlowNode, right: FlowNode): number {
  const leftKey = structuralKey(left);
  const rightKey = structuralKey(right);
  if (leftKey !== rightKey) return leftKey.localeCompare(rightKey, 'es');
  return chronological(left, right);
}

function hierarchyOrder(left: FlowNode, right: FlowNode): number {
  const typeDiff = HIERARCHY_TYPE_ORDER[left.type] - HIERARCHY_TYPE_ORDER[right.type];
  if (typeDiff !== 0) return typeDiff;
  return structuralOrder(left, right);
}

function rootOrder(left: FlowNode, right: FlowNode): number {
  const leftPage = left.type === 'element' && left.kind === 'page' ? 0 : 1;
  const rightPage = right.type === 'element' && right.kind === 'page' ? 0 : 1;
  if (leftPage !== rightPage) return leftPage - rightPage;
  return hierarchyOrder(left, right);
}

function dominantType(nodes: readonly FlowNode[]): FlowNodeType {
  const counts = new Map<FlowNodeType, number>();
  for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  let best: FlowNodeType = 'element';
  let bestCount = -1;
  for (const [type, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && HIERARCHY_TYPE_ORDER[type] < HIERARCHY_TYPE_ORDER[best])
    ) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

function layoutColumns(
  snapshot: FlowSnapshot,
  mode: 'chronological' | 'structural',
  compare: (left: FlowNode, right: FlowNode) => number,
  compact: boolean,
  widthOf: (node: FlowNode) => number,
  heightOf: (node: FlowNode) => number,
): FlowLayout {
  const rowGap = compact ? COMPACT_ROW_GAP : ROW_GAP;
  const buckets = new Map<FlowNodeType, FlowNode[]>();
  for (const type of FLOW_LAYERS) {
    buckets.set(type, []);
  }
  for (const node of snapshot.nodes) {
    buckets.get(node.type)?.push(node);
  }

  const active = FLOW_LAYERS.filter((type) => (buckets.get(type)?.length ?? 0) > 0);
  const columns = active.map((type) => {
    const list = [...(buckets.get(type) ?? [])].sort(compare);
    const columnWidth = list.reduce((widest, node) => Math.max(widest, widthOf(node)), 0);
    const blockHeight =
      list.reduce((total, node) => total + heightOf(node), 0) +
      Math.max(0, list.length - 1) * rowGap;
    return { type, list, columnWidth: Math.max(1, columnWidth), blockHeight };
  });

  const columnsWidth = columns.reduce((total, column) => total + column.columnWidth, 0);
  let gapsWidth = 0;
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1];
    const current = active[index];
    if (previous === undefined || current === undefined) continue;
    gapsWidth += layerGap(previous, current);
  }
  const width = MARGIN * 2 + columnsWidth + gapsWidth;
  const tallest = Math.max(1, ...columns.map((column) => column.blockHeight));
  const height = MARGIN * 2 + tallest;

  const placed: FlowPlacedNode[] = [];
  const positions = new Map<string, FlowPlacedNode>();
  const layers: FlowLayerInfo[] = [];
  let cursor = MARGIN;

  columns.forEach(({ type, list, columnWidth, blockHeight }, layer) => {
    layers.push({ type, x: cursor, count: list.length, width: columnWidth });
    let y = MARGIN + (tallest - blockHeight) / 2;
    for (const node of list) {
      const nodeH = heightOf(node);
      const entry: FlowPlacedNode = {
        node,
        x: cursor,
        y,
        layer,
        width: columnWidth,
        height: nodeH,
      };
      placed.push(entry);
      positions.set(node.id, entry);
      y += nodeH + rowGap;
    }
    const next = columns[layer + 1];
    cursor += columnWidth + (next === undefined ? 0 : layerGap(type, next.type));
  });

  return { mode, nodes: placed, positions, layers, width, height };
}

function layoutChronological(
  snapshot: FlowSnapshot,
  compact: boolean,
  widthOf: (node: FlowNode) => number,
  heightOf: (node: FlowNode) => number,
): FlowLayout {
  return layoutColumns(snapshot, 'chronological', chronological, compact, widthOf, heightOf);
}

function layoutStructural(
  snapshot: FlowSnapshot,
  compact: boolean,
  widthOf: (node: FlowNode) => number,
  heightOf: (node: FlowNode) => number,
): FlowLayout {
  return layoutColumns(snapshot, 'structural', structuralOrder, compact, widthOf, heightOf);
}

function layoutHierarchical(
  snapshot: FlowSnapshot,
  compact: boolean,
  nodeWidthOf: (node: FlowNode) => number,
  nodeHeightOf: (node: FlowNode) => number,
): FlowLayout {
  const verticalGap = compact ? COMPACT_HIERARCHY_V_GAP : HIERARCHY_V_GAP;
  const nodes = snapshot.nodes;
  const byId = new Map<string, FlowNode>();
  for (const node of nodes) byId.set(node.id, node);

  const candidates = new Map<string, ParentCandidate[]>();
  for (const edge of snapshot.edges) {
    const priority = PARENT_PRIORITY[edge.type];
    if (priority === undefined) continue;
    if (edge.from === edge.to) continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const list = candidates.get(edge.to);
    const candidate: ParentCandidate = {
      parentId: edge.from,
      priority,
      lastSeen: edge.lastSeen,
    };
    if (list === undefined) {
      candidates.set(edge.to, [candidate]);
    } else {
      list.push(candidate);
    }
  }
  for (const list of candidates.values()) {
    list.sort(
      (left, right) =>
        right.priority - left.priority ||
        right.lastSeen - left.lastSeen ||
        left.parentId.localeCompare(right.parentId),
    );
  }

  const parents = new Map<string, string>();
  const ordered = [...nodes].sort(hierarchyOrder);

  const ancestorHas = (start: string, target: string): boolean => {
    let current: string | undefined = parents.get(start);
    let guard = 0;
    while (current !== undefined && guard < 10000) {
      if (current === target) return true;
      current = parents.get(current);
      guard += 1;
    }
    return false;
  };

  for (const node of ordered) {
    const list = candidates.get(node.id);
    if (list === undefined) continue;
    for (const candidate of list) {
      if (candidate.parentId === node.id) continue;
      if (ancestorHas(candidate.parentId, node.id)) continue;
      parents.set(node.id, candidate.parentId);
      break;
    }
  }

  for (const node of nodes) {
    let current = node.id;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(current)) {
        parents.delete(current);
        break;
      }
      seen.add(current);
      const parent = parents.get(current);
      if (parent === undefined) break;
      current = parent;
    }
  }

  const children = new Map<string, string[]>();
  for (const node of ordered) {
    const parent = parents.get(node.id);
    if (parent === undefined) continue;
    const list = children.get(parent);
    if (list === undefined) {
      children.set(parent, [node.id]);
    } else {
      list.push(node.id);
    }
  }
  for (const list of children.values()) {
    list.sort((left, right) => {
      const leftNode = byId.get(left);
      const rightNode = byId.get(right);
      if (leftNode === undefined || rightNode === undefined) return left.localeCompare(right);
      return hierarchyOrder(leftNode, rightNode);
    });
  }

  const roots = ordered.filter((node) => !parents.has(node.id)).sort(rootOrder);

  const ownWidth = (id: string): number => {
    const node = byId.get(id);
    return node === undefined ? FLOW_NODE_WIDTH : nodeWidthOf(node);
  };

  const widthCache = new Map<string, number>();
  const widthOf = (id: string): number => {
    const cached = widthCache.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id) ?? [];
    let total = 0;
    for (const kid of kids) total += widthOf(kid);
    total += HIERARCHY_H_GAP * Math.max(0, kids.length - 1);
    const width = Math.max(ownWidth(id), total);
    widthCache.set(id, width);
    return width;
  };

  const placed: FlowPlacedNode[] = [];
  const positions = new Map<string, FlowPlacedNode>();
  const depthGroups = new Map<number, FlowNode[]>();
  const visited = new Set<string>();

  const depthById = new Map<string, number>();
  const maxHeightByDepth: number[] = [];
  const collectDepth = (id: string, depth: number): void => {
    if (depthById.has(id)) return;
    depthById.set(id, depth);
    const node = byId.get(id);
    if (node !== undefined) {
      maxHeightByDepth[depth] = Math.max(maxHeightByDepth[depth] ?? 0, nodeHeightOf(node));
    }
    for (const kid of children.get(id) ?? []) collectDepth(kid, depth + 1);
  };
  for (const root of roots) collectDepth(root.id, 0);
  const depthY: number[] = [];
  let depthCursor = MARGIN;
  for (let depth = 0; depth < maxHeightByDepth.length; depth += 1) {
    depthY[depth] = depthCursor;
    depthCursor += (maxHeightByDepth[depth] ?? FLOW_NODE_HEIGHT) + verticalGap;
  }

  const place = (id: string, left: number, depth: number): void => {
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (node === undefined) return;
    visited.add(id);
    const width = widthOf(id);
    const own = ownWidth(id);
    const ownHeight = nodeHeightOf(node);
    const x = left + (width - own) / 2;
    const y = depthY[depth] ?? MARGIN;
    const entry: FlowPlacedNode = { node, x, y, layer: depth, width: own, height: ownHeight };
    placed.push(entry);
    positions.set(id, entry);
    const group = depthGroups.get(depth);
    if (group === undefined) {
      depthGroups.set(depth, [node]);
    } else {
      group.push(node);
    }

    const kids = children.get(id) ?? [];
    let total = 0;
    for (const kid of kids) total += widthOf(kid);
    total += HIERARCHY_H_GAP * Math.max(0, kids.length - 1);
    let childLeft = left + (width - total) / 2;
    for (const kid of kids) {
      place(kid, childLeft, depth + 1);
      childLeft += widthOf(kid) + HIERARCHY_H_GAP;
    }
  };

  let cursor = MARGIN;
  for (const root of roots) {
    place(root.id, cursor, 0);
    cursor += widthOf(root.id) + HIERARCHY_ROOT_GAP;
  }

  const width =
    roots.length === 0 ? MARGIN * 2 : Math.max(MARGIN * 2, cursor - HIERARCHY_ROOT_GAP + MARGIN);
  const height =
    placed.length === 0 || maxHeightByDepth.length === 0
      ? MARGIN * 2
      : depthCursor - verticalGap + MARGIN;

  const layers: FlowLayerInfo[] = [...depthGroups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([depth, group]) => ({
      type: dominantType(group),
      x: MARGIN,
      count: group.length,
      label: `NIVEL ${String(depth)}`,
      y: (depthY[depth] ?? MARGIN) - 18,
    }));

  return { mode: 'hierarchical', nodes: placed, positions, layers, width, height };
}

export function layoutFlow(
  snapshot: FlowSnapshot,
  mode: FlowLayoutMode = 'chronological',
  options: FlowLayoutOptions = {},
): FlowLayout {
  const compact = options.compact === true;
  const widthOf = options.widthOf ?? ((): number => FLOW_NODE_WIDTH);
  const heightOf =
    options.heightOf ?? ((): number => (compact ? FLOW_NODE_COMPACT_HEIGHT : FLOW_NODE_HEIGHT));
  if (mode === 'hierarchical') {
    return layoutHierarchical(snapshot, compact, widthOf, heightOf);
  }
  if (mode === 'structural') {
    return layoutStructural(snapshot, compact, widthOf, heightOf);
  }
  return layoutChronological(snapshot, compact, widthOf, heightOf);
}
