import type { FlowNode, FlowNodeType, FlowSnapshot } from '@bdt/protocol';

export const FLOW_NODE_WIDTH = 210;
export const FLOW_NODE_HEIGHT = 48;
const ROW_GAP = 10;
const LAYER_GAP = 88;
const MARGIN = 48;

export const FLOW_LAYERS: readonly FlowNodeType[] = [
  'element',
  'handler',
  'request',
  'route',
  'function',
  'query',
  'table',
  'database',
];

export interface FlowPlacedNode {
  node: FlowNode;
  x: number;
  y: number;
  layer: number;
}

export interface FlowLayerInfo {
  type: FlowNodeType;
  x: number;
  count: number;
}

export interface FlowLayout {
  nodes: FlowPlacedNode[];
  positions: Map<string, FlowPlacedNode>;
  layers: FlowLayerInfo[];
  width: number;
  height: number;
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

export function layoutFlow(snapshot: FlowSnapshot): FlowLayout {
  const buckets = new Map<FlowNodeType, FlowNode[]>();
  for (const type of FLOW_LAYERS) {
    buckets.set(type, []);
  }
  for (const node of snapshot.nodes) {
    buckets.get(node.type)?.push(node);
  }

  const active = FLOW_LAYERS.filter((type) => (buckets.get(type)?.length ?? 0) > 0);
  const order = active.map((type) => [...(buckets.get(type) ?? [])].sort(chronological));

  const rowCount = Math.max(1, ...order.map((list) => list.length));
  const width =
    MARGIN * 2 + active.length * FLOW_NODE_WIDTH + Math.max(0, active.length - 1) * LAYER_GAP;
  const height = MARGIN * 2 + rowCount * FLOW_NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP;

  const placed: FlowPlacedNode[] = [];
  const positions = new Map<string, FlowPlacedNode>();
  const layers: FlowLayerInfo[] = [];

  order.forEach((list, layer) => {
    const type = active[layer];
    if (type === undefined) return;
    const x = MARGIN + layer * (FLOW_NODE_WIDTH + LAYER_GAP);
    layers.push({ type, x, count: list.length });
    const blockHeight = list.length * FLOW_NODE_HEIGHT + Math.max(0, list.length - 1) * ROW_GAP;
    const top = MARGIN + (height - MARGIN * 2 - blockHeight) / 2;
    list.forEach((node, row) => {
      const entry: FlowPlacedNode = {
        node,
        x,
        y: top + row * (FLOW_NODE_HEIGHT + ROW_GAP),
        layer,
      };
      placed.push(entry);
      positions.set(node.id, entry);
    });
  });

  return { nodes: placed, positions, layers, width, height };
}
