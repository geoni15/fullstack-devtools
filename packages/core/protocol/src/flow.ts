import type { InspectionSqlOperation, RequestOrigin, RequestOutcome } from './browser';

export type FlowNodeType =
  'element' | 'handler' | 'request' | 'route' | 'function' | 'query' | 'table' | 'database';

export type FlowEdgeType =
  | 'TRIGGERS'
  | 'SENDS'
  | 'MATCHES'
  | 'HANDLES'
  | 'QUERIES'
  | 'READS'
  | 'WRITES'
  | 'USES'
  | 'SUBMITS'
  | 'NAVIGATES'
  | 'PROVENANCE'
  | 'RENDERS'
  | 'CONTAINS';

export type FlowEvidenceKind = 'STATIC' | 'RUNTIME';

export type FlowCorrelation = 'direct' | 'heuristic';

export type FlowElementKind =
  | 'button'
  | 'link'
  | 'input'
  | 'select'
  | 'textarea'
  | 'form'
  | 'details'
  | 'summary'
  | 'contenteditable'
  | 'interactive'
  | 'page';

export const FLOW_INTERACTION_EVENTS = [
  'click',
  'dblclick',
  'contextmenu',
  'submit',
  'input',
  'change',
  'focus',
  'blur',
  'keydown',
  'hover',
  'scroll',
] as const;

export type FlowInteractionEvent = (typeof FLOW_INTERACTION_EVENTS)[number];

export interface FlowHandlerHint {
  event: string;
  name: string | null;
  source: string;
}

export interface FlowNodeEvent {
  event: FlowInteractionEvent;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  title: string;
  subtitle: string | null;
  file: string | null;
  line: number | null;
  endLine: number | null;
  method: string | null;
  path: string | null;
  url: string | null;
  requestIds: string[];
  traceIds: string[];
  evidence: FlowEvidenceKind[];
  occurrences: number;
  countLabel?: string | null;
  firstSeen: number;
  lastSeen: number;
  note: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  outcome?: RequestOutcome | null;
  backendObserved?: boolean | null;
  origin?: RequestOrigin | null;
  initiatorFunction?: string | null;
  operation?: InspectionSqlOperation | null;
  dialect?: string | null;
  parse?: 'ast' | 'fallback' | null;
  sql?: string | null;
  tablesRead?: string[];
  tablesWritten?: string[];
  engine?: string | null;
  database?: string | null;
  kind?: FlowElementKind | null;
  selector?: string | null;
  href?: string | null;
  formAction?: string | null;
  formMethod?: string | null;
  formKey?: string | null;
  disabled?: boolean | null;
  visible?: boolean | null;
  handlers?: FlowHandlerHint[];
  events?: FlowNodeEvent[];
}

export interface FlowEdge {
  id: string;
  type: FlowEdgeType;
  from: string;
  to: string;
  evidence: FlowEvidenceKind[];
  correlation: FlowCorrelation;
  occurrences: number;
  lastSeen: number;
  traceIds: string[];
  note: string | null;
}

export interface FlowStats {
  clicks: number;
  requests: number;
  externalRequests: number;
  preflightRequests: number;
  routes: number;
  functions: number;
  queries: number;
  tables: number;
  databases: number;
  controls: number;
  forms: number;
  interactions: number;
}

export interface FlowStackTech {
  label: string;
  detail: string;
  evidence: FlowEvidenceKind;
}

export interface FlowStack {
  frontend: FlowStackTech | null;
  backend: FlowStackTech | null;
  database: FlowStackTech | null;
  workspaceOpen: boolean;
}

export interface FlowSnapshot {
  revision: number;
  builtAt: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  stats: FlowStats;
  stack: FlowStack;
}

export interface FlowMapState {
  open: boolean;
  building: boolean;
  error: string | null;
  snapshot: FlowSnapshot | null;
}

export interface FlowHighlightTarget {
  key: string | null;
  selector: string;
}
