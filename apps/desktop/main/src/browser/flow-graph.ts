import type {
  CapturedRequest,
  FlowCorrelation,
  FlowEdge,
  FlowEdgeType,
  FlowElementKind,
  FlowEvidenceKind,
  FlowInteractionEvent,
  FlowNode,
  FlowNodeType,
  FlowSnapshot,
  FlowStack,
  FlowStats,
  InspectionSqlOperation,
  InspectionSqlQuery,
  RequestOutcome,
} from '@bdt/protocol';
import { requestStatusView } from '@bdt/protocol';
import { matchRoute, type StaticRoute } from '@bdt/routes-index';
import { pickDatabaseHint } from './database-hints';
import type { FlowTrace, FlowTraceHandler, FlowTraceQuery } from './flow-ledger';
import type { FlowInteractionOccurrence, FlowInteractionSummary } from './interaction-ledger';
import type { PageControl, PageElementRef, PageHandlerHint } from './page-inventory';
import type { RuntimeHandlerLink } from './runtime-handler-ledger';
import type { RuntimeProvenanceLink } from './runtime-link-ledger';
import { normalizeSqlText, staticQueriesForRoute } from './sql-queries';
import type { DatabaseHint } from './routes';

export interface FlowGraphInput {
  traces: FlowTrace[];
  requests: CapturedRequest[];
  routes: readonly StaticRoute[];
  databases: readonly DatabaseHint[];
  revision: number;
  frontend: string | null;
  workspaceOpen: boolean;
  inventory: PageControl[];
  interactions: FlowInteractionSummary[];
  references: PageElementRef[];
  occurrences: readonly FlowInteractionOccurrence[];
  runtimeLinks: RuntimeProvenanceLink[];
  runtimeHandlers: RuntimeHandlerLink[];
}

const EVIDENCE_ORDER: readonly FlowEvidenceKind[] = ['STATIC', 'RUNTIME'];

const SQL_LABELS: Record<InspectionSqlOperation, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  other: 'SQL',
};

const DIALECT_ENGINE: Record<string, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
};

const FRAMEWORK_LABEL: Record<string, string> = {
  express: 'Express',
  fastify: 'Fastify',
  fastapi: 'FastAPI',
  flask: 'Flask',
};

const SUFFIX_NOTE = 'coincidencia por sufijo';

const KIND_LABEL: Record<FlowElementKind, string> = {
  button: 'botón',
  link: 'enlace',
  input: 'campo',
  select: 'selector',
  textarea: 'área de texto',
  form: 'formulario',
  details: 'desplegable',
  summary: 'resumen',
  contenteditable: 'editable',
  interactive: 'interactivo',
  page: 'página',
};

function asElementKind(value: string | null | undefined): FlowElementKind | null {
  if (value === null || value === undefined) return null;
  return Object.prototype.hasOwnProperty.call(KIND_LABEL, value)
    ? (value as FlowElementKind)
    : null;
}

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

const EVENT_PRIORITY: Record<FlowInteractionEvent, number> = {
  submit: 9,
  click: 8,
  dblclick: 7,
  keydown: 6,
  change: 5,
  input: 4,
  contextmenu: 3,
  scroll: 2,
  focus: 1,
  blur: 1,
  hover: 0,
};

const COUNT_LABEL: Partial<Record<FlowNodeType, string>> = {
  element: 'Interacciones',
  handler: 'Ejecuciones',
  route: 'Peticiones recibidas',
  function: 'Peticiones manejadas',
  query: 'Ejecuciones',
  table: 'Consultas ejecutadas',
  database: 'Consultas ejecutadas',
};

const CORRELATION_BEFORE_MS = 3000;
const CORRELATION_AFTER_MS = 500;

const queryCache = new WeakMap<StaticRoute, InspectionSqlQuery[]>();

function queriesFor(route: StaticRoute): InspectionSqlQuery[] {
  const cached = queryCache.get(route);
  if (cached !== undefined) return cached;
  const queries = staticQueriesForRoute(route);
  queryCache.set(route, queries);
  return queries;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function mergeStrings(target: string[], incoming: readonly string[]): void {
  for (const value of incoming) {
    if (!target.includes(value)) target.push(value);
  }
}

function mergeEvidence(target: FlowEvidenceKind[], incoming: readonly FlowEvidenceKind[]): void {
  for (const value of incoming) {
    if (!target.includes(value)) target.push(value);
  }
  target.sort((left, right) => EVIDENCE_ORDER.indexOf(left) - EVIDENCE_ORDER.indexOf(right));
}

function canonicalEvidence(evidence: readonly FlowEvidenceKind[]): FlowEvidenceKind[] {
  return EVIDENCE_ORDER.filter((value) => evidence.includes(value));
}

function appendNote(current: string | null, incoming: string | null): string | null {
  if (incoming === null || incoming === '') return current;
  if (current === null || current === '') return incoming;
  if (current.includes(incoming)) return current;
  return `${current} · ${incoming}`;
}

function earliest(first: number, second: number): number {
  if (first === 0) return second;
  if (second === 0) return first;
  return Math.min(first, second);
}

function latest(first: number, second: number): number {
  return Math.max(first, second);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clipText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

export function routeNodeId(
  route: Pick<StaticRoute, 'method' | 'path' | 'file' | 'routeLine'>,
): string {
  return `route:${route.method.toUpperCase()}:${route.path}@${route.file}:${String(route.routeLine)}`;
}

function functionNodeId(route: StaticRoute): string {
  return `function:${route.file}:${String(route.line)}:${String(route.endLine)}`;
}

function backendKey(method: string, routePath: string, file: string, routeLine: number): string {
  return `${method.toUpperCase()}|${routePath}|${file}:${String(routeLine)}`;
}

function databaseNodeId(engine: string | null, database: string | null): string {
  return `database:${engine ?? ''}:${database ?? ''}`;
}

function tableNodeId(table: string): string {
  return `table:${table.toLowerCase()}`;
}

function dialectEngine(dialect: string | null): string | null {
  if (dialect === null) return null;
  return DIALECT_ENGINE[dialect.toLowerCase()] ?? null;
}

function stripQuery(value: string): string {
  const index = value.indexOf('?');
  return index === -1 ? value : value.slice(0, index);
}

function isPreflight(request: CapturedRequest): boolean {
  return (
    request.method === 'OPTIONS' &&
    Object.keys(request.headers).some(
      (header) => header.toLowerCase() === 'access-control-request-method',
    )
  );
}

interface ElementLabel {
  tag: string;
  text: string | null;
  ariaLabel: string | null;
}

interface ElementDetail extends ElementLabel {
  role: string | null;
  inputType: string | null;
}

function elementNodeId(
  element: FlowTrace['element'],
  handler: FlowTraceHandler | null,
  traceId: string,
): string {
  const key = element.key;
  if (key !== undefined && key !== null && key !== '') return `element:${key}`;
  const descriptor = [
    element.tag,
    element.text ?? '',
    element.role ?? '',
    element.ariaLabel ?? '',
    element.inputType ?? '',
  ].join('\u0000');
  if (descriptor === '' && handler === null) return `element:trace:${traceId}`;
  const handlerKey =
    handler === null
      ? 'none'
      : [
          handler.source,
          handler.event,
          handler.name ?? '',
          handler.url ?? '',
          handler.line ?? '',
          handler.column ?? '',
        ].join('\u0000');
  return `element:${hashText(`${descriptor}\u0001${handlerKey}`)}`;
}

function elementTitle(element: ElementLabel): string {
  const text = element.text?.trim() ?? '';
  if (text !== '') return text;
  const label = element.ariaLabel?.trim() ?? '';
  if (label !== '') return label;
  return `<${element.tag}>`;
}

function elementSubtitle(element: ElementDetail): string {
  const parts = [`<${element.tag}>`];
  if (element.role !== null && element.role !== '') parts.push(element.role);
  if (element.inputType !== null && element.inputType !== '') parts.push(element.inputType);
  if (
    element.ariaLabel !== null &&
    element.ariaLabel !== '' &&
    element.ariaLabel !== element.text
  ) {
    parts.push(`aria: ${element.ariaLabel}`);
  }
  return parts.join(' · ');
}

function refNodeId(ref: PageElementRef): string {
  return `element:${ref.key}`;
}

function controlSubtitle(control: PageControl): string {
  const parts = [KIND_LABEL[control.kind], `<${control.tag}>`];
  if (control.inputType !== null && control.inputType !== '') parts.push(control.inputType);
  if (control.role !== null && control.role !== '') parts.push(control.role);
  if (control.handlers.length > 0) {
    parts.push(`${String(control.handlers.length)} manejador(es) declarado(s)`);
  }
  if (control.kind === 'form' && control.formAction !== null) {
    parts.push(`${control.formMethod ?? 'GET'} ${control.formAction}`);
  }
  if (control.disabled) parts.push('deshabilitado');
  if (!control.visible) parts.push('oculto');
  return parts.join(' · ');
}

function declaredHandlerId(control: PageControl, hint: PageHandlerHint): string {
  const name = hint.name ?? 'anónimo';
  return `handler:declared:${hint.source}:${hint.event}:${name}:${control.key}`;
}

function handlerHintLabel(hint: PageHandlerHint): string {
  const name = hint.name ?? 'función anónima';
  return `${name} · ${hint.source} · ${hint.event}`;
}

function isSubmitControl(control: PageElementRef): boolean {
  const type = (control.inputType ?? '').toLowerCase();
  if (control.tag === 'input') return type === 'submit' || type === 'image';
  if (control.tag === 'button') return type === '' || type === 'submit';
  return false;
}

function handlerNodeIdFor(handler: FlowTraceHandler, traceId: string): string {
  if (handler.url !== null) {
    const line = handler.line === null ? '' : String(handler.line);
    const column = handler.column === null ? '' : String(handler.column);
    return `handler:${handler.url}:${line}:${column}`;
  }
  if (handler.name !== null) {
    return `handler:${handler.source}:${handler.event}:${handler.name}`;
  }
  return `handler:trace:${traceId}`;
}

function handlerTitle(handler: FlowTraceHandler): string {
  if (handler.name !== null && handler.name !== '') return handler.name;
  return `Listener ${handler.event} sin nombre`;
}

function handlerSubtitle(handler: FlowTraceHandler): string {
  const parts: string[] = [handler.source, handler.event];
  if (handler.url !== null) {
    parts.push(handler.line === null ? handler.url : `${handler.url}:${String(handler.line)}`);
  }
  return parts.join(' · ');
}

function requestSubtitle(
  statusCode: number | null,
  durationMs: number | null,
  outcome: RequestOutcome,
  backendObserved: boolean | null = null,
): string {
  const status = requestStatusView({ statusCode, outcome, backendObserved });
  return durationMs === null
    ? status.label
    : `${status.label} · ${String(Math.round(durationMs))} ms`;
}

interface QueryShape {
  operation: InspectionSqlOperation;
  tablesRead: string[];
  tablesWritten: string[];
  dialect: string | null;
  line: number;
  parse: 'ast' | 'fallback';
}

function querySubtitle(query: QueryShape, file: string | null): string {
  const parts = [query.dialect ?? 'SQL'];
  const tables = unique([...query.tablesRead, ...query.tablesWritten]);
  if (tables.length > 0) parts.push(tables.join(', '));
  parts.push(file === null ? `línea ${String(query.line)}` : `${file}:${String(query.line)}`);
  return parts.join(' · ');
}

function requestSendNote(
  handler: FlowTraceHandler,
  request: { initiatorFunction: string | null },
): string {
  if (handler.name === null || handler.name === '') {
    return 'El manejador no tiene nombre; asociación por ventana del clic.';
  }
  if (request.initiatorFunction === null) {
    return 'La petición no expone una función iniciadora; asociación por ventana del clic.';
  }
  return `La petición la inició ${request.initiatorFunction}, no ${handler.name}.`;
}

interface FunctionEntry {
  id: string;
  file: string;
  line: number;
  endLine: number;
}

interface EdgeOptions {
  increment?: number;
  note?: string | null;
  lastSeen?: number;
  traceIds?: string[];
}

function baseNode(
  id: string,
  type: FlowNodeType,
  title: string,
  evidence: FlowEvidenceKind[],
): FlowNode {
  return {
    id,
    type,
    title,
    subtitle: null,
    file: null,
    line: null,
    endLine: null,
    method: null,
    path: null,
    url: null,
    requestIds: [],
    traceIds: [],
    evidence,
    occurrences: 1,
    countLabel: COUNT_LABEL[type] ?? null,
    firstSeen: 0,
    lastSeen: 0,
    note: null,
  };
}

class FlowGraphBuilder {
  private readonly nodes = new Map<string, FlowNode>();
  private readonly edges = new Map<string, FlowEdge>();
  private readonly routeNodes = new Set<string>();
  private readonly routeByBackend = new Map<string, string>();
  private readonly routeFunction = new Map<string, string>();
  private readonly functions: FunctionEntry[] = [];
  private readonly functionIds = new Set<string>();
  private readonly matchCache = new Map<string, StaticRoute | null>();
  private readonly requestRoute = new Map<string, string | null>();
  private readonly runtimeLinkedRequests = new Set<string>();
  private readonly executedRequests = new Set<string>();
  private readonly executedEndpoints = new Set<string>();
  private externalRequests = 0;
  private preflightRequests = 0;

  constructor(private readonly input: FlowGraphInput) {}

  build(): FlowSnapshot {
    for (const link of this.input.runtimeLinks) {
      if (link.requestId !== null) this.runtimeLinkedRequests.add(link.requestId);
    }
    for (const trace of this.input.traces) {
      if (trace.execution === null) continue;
      for (const request of trace.requests) this.executedRequests.add(request.id);
      for (const breakpoint of trace.execution.breakpoints) {
        this.executedEndpoints.add(
          `${breakpoint.method.toUpperCase()} ${stripQuery(breakpoint.path)}`,
        );
      }
    }
    const resolved = new Set<string>();
    for (const trace of this.input.traces) {
      const key = trace.element.key;
      if (key === undefined || key === null || key === '') continue;
      if (trace.handler === null) continue;
      resolved.add(`${key}|${trace.handler.event}`);
    }
    for (const link of this.input.runtimeHandlers) {
      resolved.add(`${link.element.key}|${link.event}`);
    }
    this.projectRoutes();
    this.projectInventory(resolved);
    this.projectTraffic();
    for (const trace of this.input.traces) {
      this.projectTrace(trace);
    }
    this.projectInteractions();
    this.projectRuntimeLinks();
    this.projectRuntimeHandlers();
    this.projectHandlerInitiators();
    this.projectContainment();
    this.finalizeNodeNotes();
    return {
      revision: this.input.revision,
      builtAt: Date.now(),
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      stats: this.stats(),
      stack: this.stack(),
    };
  }

  private stack(): FlowStack {
    const frontend =
      this.input.frontend === null || this.input.frontend === ''
        ? null
        : {
            label: this.input.frontend,
            detail: 'detectado en la página',
            evidence: 'RUNTIME' as const,
          };

    const frameworks = unique(this.input.routes.map((route) => route.framework));
    const backend =
      frameworks.length === 0
        ? null
        : {
            label: frameworks
              .map((framework) => FRAMEWORK_LABEL[framework] ?? framework)
              .join(' + '),
            detail: `${String(this.input.routes.length)} rutas indexadas`,
            evidence: 'STATIC' as const,
          };

    const engines: string[] = [];
    const addEngine = (engine: string | null): void => {
      if (engine === null || engine === '' || engines.includes(engine)) return;
      engines.push(engine);
    };
    for (const hint of this.input.databases) addEngine(hint.engine);
    for (const node of this.nodes.values()) {
      if (node.type !== 'query' || node.dialect === null || node.dialect === undefined) continue;
      addEngine(DIALECT_ENGINE[node.dialect.toLowerCase()] ?? null);
    }
    const database =
      engines.length === 0
        ? null
        : {
            label: engines.join(' + '),
            detail: 'inferida del código; no verificada',
            evidence: 'STATIC' as const,
          };

    return {
      frontend,
      backend,
      database,
      workspaceOpen: this.input.workspaceOpen,
    };
  }

  private projectRoutes(): void {
    for (const route of this.input.routes) {
      const routeId = routeNodeId(route);
      this.routeNodes.add(routeId);
      this.routeByBackend.set(
        backendKey(route.method, route.path, route.file, route.routeLine),
        routeId,
      );

      const routeNode = baseNode(routeId, 'route', `${route.method.toUpperCase()} ${route.path}`, [
        'STATIC',
      ]);
      routeNode.subtitle = `${route.framework} · ${route.handlerName ?? 'sin nombre'} · ${route.file}:${String(route.line)}`;
      routeNode.file = route.file;
      routeNode.line = route.line;
      routeNode.endLine = route.endLine;
      routeNode.method = route.method.toUpperCase();
      routeNode.path = route.path;
      routeNode.occurrences = 0;
      routeNode.note = route.resolved
        ? route.note
        : appendNote(route.note, 'Función no resuelta; sin nodo de función.');
      this.addNode(routeNode);

      if (!route.resolved) continue;

      const functionId = functionNodeId(route);
      this.routeFunction.set(routeId, functionId);
      if (!this.functionIds.has(functionId)) {
        this.functionIds.add(functionId);
        this.functions.push({
          id: functionId,
          file: route.file,
          line: route.line,
          endLine: route.endLine,
        });
        const functionNode = baseNode(
          functionId,
          'function',
          route.handlerName ?? 'Función anónima',
          ['STATIC'],
        );
        functionNode.subtitle = `${route.file}:${String(route.line)}-${String(route.endLine)}`;
        functionNode.file = route.file;
        functionNode.line = route.line;
        functionNode.endLine = route.endLine;
        functionNode.occurrences = 0;
        this.addNode(functionNode);
      }

      this.addEdge('HANDLES', routeId, functionId, ['STATIC'], 'direct');

      for (const query of queriesFor(route)) {
        this.projectStaticQuery(route, functionId, query);
      }
    }
  }

  private projectInventory(resolved: ReadonlySet<string>): void {
    for (const control of this.input.inventory) {
      const id = refNodeId(control);
      const node = baseNode(id, 'element', elementTitle(control), ['STATIC']);
      node.subtitle = controlSubtitle(control);
      node.kind = control.kind;
      node.selector = control.selector;
      node.href = control.href;
      node.formAction = control.formAction;
      node.formMethod = control.formMethod;
      node.formKey = control.formKey;
      node.disabled = control.disabled;
      node.visible = control.visible;
      node.occurrences = 0;
      node.handlers = control.handlers.map((hint) => ({
        event: hint.event,
        name: hint.name,
        source: hint.source,
      }));
      if (control.kind === 'form' && control.formAction === null && control.handlers.length === 0) {
        node.note = 'Formulario sin action ni manejador declarado.';
      }
      this.addNode(node);

      for (const hint of control.handlers) {
        if (resolved.has(`${control.key}|${hint.event}`)) continue;
        const handlerId = declaredHandlerId(control, hint);
        const handlerNode = baseNode(
          handlerId,
          'handler',
          hint.name ?? `Listener ${hint.event} sin nombre`,
          ['STATIC'],
        );
        handlerNode.subtitle = handlerHintLabel(hint);
        handlerNode.note = 'Declarado en el DOM; sin ubicación resuelta hasta interactuar.';
        handlerNode.occurrences = 0;
        this.addNode(handlerNode);
        this.addEdge(
          'TRIGGERS',
          id,
          handlerId,
          ['STATIC'],
          hint.source === 'react' ? 'heuristic' : 'direct',
          {
            note:
              hint.source === 'react'
                ? 'Manejador hallado en props React del elemento o de un componente ancestro.'
                : null,
          },
        );
      }

      this.projectDeclaredTarget(control, node);
    }
  }

  private projectDeclaredTarget(control: PageControl, node: FlowNode): void {
    if (control.kind === 'link' && control.href !== null) {
      const route = this.matchUrl('GET', control.href);
      if (route !== null) {
        this.addEdge('NAVIGATES', node.id, routeNodeId(route), ['STATIC'], 'heuristic', {
          note: 'Destino declarado en el enlace (href); sin tráfico observado.',
        });
      } else {
        node.note = appendNote(
          node.note,
          'El destino declarado del enlace no coincide con el índice de rutas.',
        );
      }
    }
    if (control.kind === 'form') {
      if (control.formAction !== null) {
        const method = control.formMethod ?? 'GET';
        const route = this.matchUrl(method, control.formAction);
        if (route !== null) {
          this.addEdge('SUBMITS', node.id, routeNodeId(route), ['STATIC'], 'heuristic', {
            note: 'Destino declarado en el formulario (action/method); sin tráfico observado.',
          });
        } else {
          node.note = appendNote(
            node.note,
            'La acción declarada no coincide con el índice de rutas.',
          );
        }
      }
      return;
    }
    if (isSubmitControl(control)) {
      if (control.formKey !== null) {
        const formId = `element:${control.formKey}`;
        if (this.nodes.has(formId)) {
          this.addEdge('SUBMITS', node.id, formId, ['STATIC'], 'direct', {
            note: 'Botón de envío declarado del formulario.',
          });
        }
      }
      if (control.formAction !== null) {
        const method = control.formMethod ?? 'GET';
        const route = this.matchUrl(method, control.formAction);
        if (route !== null) {
          this.addEdge('SUBMITS', node.id, routeNodeId(route), ['STATIC'], 'heuristic', {
            note: 'Destino declarado del botón de envío (formaction/action); sin tráfico observado.',
          });
        }
      }
    }
  }

  private projectInteractions(): void {
    for (const ref of this.input.references) {
      this.addNode(this.runtimeRefNode(ref));
    }
    for (const summary of this.input.interactions) {
      const node = this.runtimeRefNode(summary.ref);
      node.occurrences = summary.count;
      node.firstSeen = summary.firstSeen;
      node.lastSeen = summary.lastSeen;
      node.events = [
        {
          event: summary.event,
          count: summary.count,
          firstSeen: summary.firstSeen,
          lastSeen: summary.lastSeen,
        },
      ];
      this.addNode(node, true);
    }
    for (const request of this.input.requests) {
      if (isPreflight(request) || request.origin === 'external') continue;
      const requestId = `request:${request.id}`;
      const requestNode = this.nodes.get(requestId);
      if (requestNode === undefined) continue;
      const occurrence = this.bestOccurrence(request.wallStartedAt);
      if (occurrence === null) {
        if (!this.runtimeLinkedRequests.has(request.id)) {
          requestNode.note = appendNote(
            requestNode.note,
            'Sin interacción correlacionada en la ventana de 3 s.',
          );
        }
        continue;
      }
      this.projectInteractionEdge(occurrence, requestId, request.wallStartedAt);
    }
  }

  private runtimeRefNode(ref: PageElementRef): FlowNode {
    const node = baseNode(refNodeId(ref), 'element', elementTitle(ref), ['RUNTIME']);
    node.subtitle = elementSubtitle(ref);
    node.kind = ref.kind;
    node.selector = ref.selector;
    node.href = ref.href;
    node.formAction = ref.formAction;
    node.formMethod = ref.formMethod;
    node.formKey = ref.formKey;
    node.disabled = ref.disabled;
    node.visible = ref.visible;
    node.occurrences = 0;
    return node;
  }

  private bestOccurrence(requestAt: number): FlowInteractionOccurrence | null {
    let best: FlowInteractionOccurrence | null = null;
    let bestPriority = 0;
    for (const occurrence of this.input.occurrences) {
      if (occurrence.at < requestAt - CORRELATION_BEFORE_MS) continue;
      if (occurrence.at > requestAt + CORRELATION_AFTER_MS) continue;
      const priority = EVENT_PRIORITY[occurrence.event];
      if (priority <= 0) continue;
      if (
        best === null ||
        priority > bestPriority ||
        (priority === bestPriority && occurrence.at > best.at)
      ) {
        best = occurrence;
        bestPriority = priority;
      }
    }
    return best;
  }

  private projectInteractionEdge(
    occurrence: FlowInteractionOccurrence,
    requestId: string,
    requestAt: number,
  ): void {
    const elementId = `element:${occurrence.key}`;
    const element = this.nodes.get(elementId);
    if (element === undefined) return;
    const submit = occurrence.event === 'submit';
    const navigate = occurrence.event === 'click' && element.kind === 'link';
    const type: FlowEdgeType = submit ? 'SUBMITS' : navigate ? 'NAVIGATES' : 'SENDS';
    this.addEdge(type, elementId, requestId, ['RUNTIME'], 'heuristic', {
      lastSeen: requestAt,
      note: `${EVENT_LABEL[occurrence.event]} registrado antes de la petición; asociación por tiempo, no causalidad probada.`,
    });
    if (submit && occurrence.submitterKey !== null) {
      const submitterId = `element:${occurrence.submitterKey}`;
      if (this.nodes.has(submitterId)) {
        this.addEdge('SUBMITS', submitterId, requestId, ['RUNTIME'], 'heuristic', {
          lastSeen: requestAt,
          note: 'Botón que envió el formulario; asociación por tiempo.',
        });
      }
    }
  }

  private projectRuntimeLinks(): void {
    for (const link of this.input.runtimeLinks) {
      const elementId = refNodeId(link.element);
      const elementNode = this.runtimeRefNode(link.element);
      elementNode.firstSeen = link.at;
      elementNode.lastSeen = link.at;
      this.addNode(elementNode);

      const requestTargetId = link.requestId === null ? null : `request:${link.requestId}`;
      const requestId =
        requestTargetId !== null && this.nodes.has(requestTargetId) ? requestTargetId : null;
      const routeCandidate = link.route === null ? null : routeNodeId(link.route);
      const routeId =
        routeCandidate !== null && this.routeNodes.has(routeCandidate) ? routeCandidate : null;

      const identity = link.basis === 'identity';
      const parts = [
        identity
          ? 'El dato de este elemento proviene de esta respuesta (identidad en ejecución)'
          : link.basis === 'content'
            ? 'El texto del elemento coincide con un campo de la respuesta capturada (contenido, no identidad)'
            : 'La petición ejecutada que alimenta este elemento coincide con esta ruta del índice',
      ];
      if (link.dataPath !== null) {
        parts.push(
          `campo ${link.dataPath}${link.value === null ? '' : ` = «${clipText(link.value, 60)}»`}`,
        );
      }
      if (link.component !== null) {
        const location =
          link.file === null
            ? ''
            : ` (${link.file}${link.line === null ? '' : `:${String(link.line)}`})`;
        parts.push(`renderizado por ${link.component}${location}`);
      }
      const note = `${parts.join('; ')}.`;

      if (requestId !== null) {
        this.addEdge(
          'PROVENANCE',
          elementId,
          requestId,
          ['RUNTIME'],
          identity ? 'direct' : 'heuristic',
          { lastSeen: link.at, note },
        );
      } else if (routeId !== null) {
        this.addEdge(
          'PROVENANCE',
          elementId,
          routeId,
          identity ? ['STATIC', 'RUNTIME'] : ['STATIC'],
          identity ? 'direct' : 'heuristic',
          {
            lastSeen: link.at,
            note: `${note} Sin respuesta capturada en esta sesión para enlazar la petición.`,
          },
        );
      }

      if (link.component === null) continue;
      const handlerId = `handler:render:${link.component}:${link.file ?? ''}:${String(
        link.line ?? '',
      )}`;
      const handlerNode = baseNode(handlerId, 'handler', link.component, ['RUNTIME']);
      handlerNode.subtitle = `render · ${link.file ?? 'componente'}${
        link.line === null ? '' : `:${String(link.line)}`
      }`;
      handlerNode.file = link.file;
      handlerNode.line = link.line;
      handlerNode.note =
        link.code !== null
          ? `Código que devolvió el elemento al HTML: ${clipText(link.code, 160)}`
          : link.file === null
            ? 'Componente identificado en la fibra; sin archivo ni línea en ejecución.'
            : null;
      handlerNode.firstSeen = link.at;
      handlerNode.lastSeen = link.at;
      this.addNode(handlerNode);
      this.addEdge('RENDERS', handlerId, elementId, ['RUNTIME'], 'direct', {
        lastSeen: link.at,
      });
    }
  }

  private projectRuntimeHandlers(): void {
    for (const link of this.input.runtimeHandlers) {
      const elementId = refNodeId(link.element);
      const elementNode = this.runtimeRefNode(link.element);
      elementNode.firstSeen = link.at;
      elementNode.lastSeen = link.at;
      this.addNode(elementNode);

      const handlerId = handlerNodeIdFor(link, `runtime:${link.element.key}`);
      const handlerNode = baseNode(handlerId, 'handler', handlerTitle(link), ['RUNTIME']);
      handlerNode.subtitle = handlerSubtitle(link);
      handlerNode.file = link.url;
      handlerNode.line = link.line;
      handlerNode.firstSeen = link.at;
      handlerNode.lastSeen = link.at;
      handlerNode.note =
        link.note ?? 'Manejador resuelto en el DOM sin interacción; ubicación en ejecución.';
      this.addNode(handlerNode);
      this.addEdge('TRIGGERS', elementId, handlerId, ['RUNTIME'], 'direct', {
        lastSeen: link.at,
        note: 'Oyente o manejador asociado al elemento en el DOM, resuelto sin esperar interacción.',
      });
    }
  }

  private projectHandlerInitiators(): void {
    if (this.input.requests.length === 0) return;
    for (const link of this.input.runtimeHandlers) {
      if (link.name === null || link.name === '') continue;
      const handlerId = handlerNodeIdFor(link, `runtime:${link.element.key}`);
      if (!this.nodes.has(handlerId)) continue;
      for (const request of this.input.requests) {
        if (isPreflight(request) || request.origin === 'external') continue;
        const initiator = request.initiator?.frames[0]?.functionName ?? null;
        if (initiator === null || initiator !== link.name) continue;
        const requestId = `request:${request.id}`;
        if (!this.nodes.has(requestId)) continue;
        const edgeId = `SENDS|${handlerId}|${requestId}`;
        if (this.edges.has(edgeId)) continue;
        this.addEdge('SENDS', handlerId, requestId, ['RUNTIME'], 'heuristic', {
          lastSeen: request.wallStartedAt,
          note: `La petición la inició ${initiator}, el mismo nombre del manejador resuelto en el DOM; asociación por nombre, sin evento registrado.`,
        });
      }
    }
  }

  private selectorAncestor(parent: FlowNode, child: FlowNode): boolean {
    const parentSelector = parent.selector;
    const childSelector = child.selector;
    if (parentSelector === undefined || parentSelector === null || parentSelector === '') {
      return false;
    }
    if (childSelector === undefined || childSelector === null || childSelector === '') {
      return false;
    }
    if (parentSelector === childSelector) return false;
    if (parentSelector === 'document') return childSelector !== 'document';
    return childSelector.startsWith(`${parentSelector}>`);
  }

  private projectContainment(): void {
    const elements: FlowNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'element') continue;
      if (node.selector === undefined || node.selector === null || node.selector === '') continue;
      elements.push(node);
    }
    if (elements.length < 2) return;
    const connected = new Set<string>();
    for (const edge of this.edges.values()) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    const isolated = elements.filter((node) => !connected.has(node.id));
    for (const node of isolated) {
      let ancestor: FlowNode | null = null;
      let descendant: FlowNode | null = null;
      for (const other of elements) {
        if (other.id === node.id || !connected.has(other.id)) continue;
        if (this.selectorAncestor(other, node)) {
          if (
            ancestor === null ||
            (other.selector?.length ?? 0) > (ancestor.selector?.length ?? 0)
          ) {
            ancestor = other;
          }
          continue;
        }
        if (!this.selectorAncestor(node, other)) continue;
        if (
          descendant === null ||
          (other.selector?.length ?? 0) < (descendant.selector?.length ?? 0)
        ) {
          descendant = other;
        }
      }
      const parent = ancestor ?? node;
      const child = ancestor === null ? descendant : node;
      if (child === null) continue;
      this.addEdge('CONTAINS', parent.id, child.id, ['RUNTIME'], 'direct', {
        note: 'Contención en el DOM; no implica flujo de datos.',
      });
      connected.add(node.id);
    }
  }

  private matchUrl(method: string, url: string): StaticRoute | null {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = stripQuery(url);
    }
    return this.match(method, pathname);
  }

  private projectStaticQuery(
    route: StaticRoute,
    functionId: string,
    query: InspectionSqlQuery,
  ): void {
    const queryId = `query:${query.id}`;
    const node = baseNode(queryId, 'query', SQL_LABELS[query.operation], ['STATIC']);
    node.subtitle = querySubtitle(query, route.file);
    node.file = route.file;
    node.line = query.line;
    node.operation = query.operation;
    node.dialect = query.dialect;
    node.parse = query.parse;
    node.sql = query.sql;
    node.tablesRead = [...query.tablesRead];
    node.tablesWritten = [...query.tablesWritten];
    node.note = query.note;
    node.occurrences = 0;
    this.addNode(node);

    this.addEdge('QUERIES', functionId, queryId, ['STATIC'], 'direct');
    this.projectTables(queryId, query);
    this.projectDatabase(queryId, route.file, query, 0, []);
  }

  private projectTables(queryId: string, query: QueryShape): void {
    const correlation: FlowCorrelation = query.parse === 'fallback' ? 'heuristic' : 'direct';
    const note =
      correlation === 'heuristic' ? 'Tabla deducida de SQL sin AST; puede ser parcial.' : null;
    for (const table of unique(query.tablesRead)) {
      this.addTableNode(table);
      this.addEdge('READS', queryId, tableNodeId(table), ['STATIC'], correlation, { note });
    }
    for (const table of unique(query.tablesWritten)) {
      this.addTableNode(table);
      this.addEdge('WRITES', queryId, tableNodeId(table), ['STATIC'], correlation, { note });
    }
  }

  private addTableNode(table: string): void {
    const id = tableNodeId(table);
    if (this.nodes.has(id)) return;
    const node = baseNode(id, 'table', table, ['STATIC']);
    node.subtitle = 'tabla';
    node.occurrences = 0;
    this.addNode(node);
  }

  private projectDatabase(
    queryId: string,
    file: string | null,
    query: QueryShape,
    lastSeen: number,
    traceIds: string[],
  ): void {
    const hint = pickDatabaseHint(this.input.databases, file);
    const engine = hint?.engine ?? dialectEngine(query.dialect);
    const database = hint?.database ?? null;
    if (engine === null && database === null) return;

    const id = databaseNodeId(engine, database);
    const node = baseNode(id, 'database', engine ?? 'Base de datos', ['STATIC']);
    node.subtitle = database ?? 'nombre no declarado';
    node.engine = engine;
    node.database = database;
    node.note = `Inferida del código; no verificada.${hint === null ? '' : ` · ${hint.file}`}`;
    node.firstSeen = lastSeen;
    node.lastSeen = lastSeen;
    node.traceIds = [...traceIds];
    node.occurrences = 0;
    this.addNode(node);

    this.addEdge('USES', queryId, id, ['STATIC'], 'heuristic', {
      note: 'Motor y base inferidos del código; no verificados.',
      lastSeen,
      traceIds,
    });
  }

  private projectTraffic(): void {
    for (const request of this.input.requests) {
      if (isPreflight(request)) {
        this.preflightRequests += 1;
        continue;
      }
      if (request.origin === 'external') {
        this.externalRequests += 1;
        continue;
      }
      const route = this.match(request.method, request.path);
      if (request.origin !== 'backend' && route === null) continue;

      const backendObserved =
        request.origin === 'backend' ? this.capturedBackendObserved(request, route !== null) : null;
      const node = this.capturedRequestNode(request, route === null, backendObserved);
      this.addNode(node);
      const routeId = route === null ? null : routeNodeId(route);
      this.requestRoute.set(request.id, routeId);
      if (route !== null) {
        this.attachMatch(node.id, route, 1, null, request.wallStartedAt);
      }
    }
  }

  private capturedBackendObserved(request: CapturedRequest, backendRoute: boolean): boolean | null {
    if (this.executedRequests.has(request.id)) return true;
    if (this.executedEndpoints.has(`${request.method.toUpperCase()} ${stripQuery(request.path)}`)) {
      return true;
    }
    return backendRoute ? false : null;
  }

  private capturedRequestNode(
    request: CapturedRequest,
    isolated: boolean,
    backendObserved: boolean | null,
  ): FlowNode {
    const node = baseNode(`request:${request.id}`, 'request', `${request.method} ${request.path}`, [
      'RUNTIME',
    ]);
    node.subtitle = requestSubtitle(
      request.statusCode,
      request.durationMs,
      request.outcome,
      backendObserved,
    );
    node.method = request.method;
    node.path = request.path;
    node.url = request.url;
    node.requestIds = [request.id];
    node.statusCode = request.statusCode;
    node.durationMs = request.durationMs;
    node.outcome = request.outcome;
    node.backendObserved = backendObserved;
    node.origin = request.origin;
    node.initiatorFunction = request.initiator?.frames[0]?.functionName ?? null;
    node.firstSeen = request.wallStartedAt;
    node.lastSeen = request.wallStartedAt;
    node.note = isolated ? 'Sin ruta estática en el índice.' : null;
    return node;
  }

  private traceRequestNode(trace: FlowTrace, request: FlowTrace['requests'][number]): FlowNode {
    const node = baseNode(`request:${request.id}`, 'request', `${request.method} ${request.path}`, [
      'RUNTIME',
    ]);
    const backendObserved = this.traceBackendObserved(trace, request);
    node.subtitle = requestSubtitle(
      request.statusCode,
      request.durationMs,
      request.outcome,
      backendObserved,
    );
    node.method = request.method;
    node.path = request.path;
    node.requestIds = [request.id];
    node.traceIds = [trace.id];
    node.statusCode = request.statusCode;
    node.durationMs = request.durationMs;
    node.outcome = request.outcome;
    node.backendObserved = backendObserved;
    node.origin = null;
    node.initiatorFunction = request.initiatorFunction;
    node.firstSeen = request.wallStartedAt;
    node.lastSeen = request.wallStartedAt;
    return node;
  }

  private traceBackendObserved(
    trace: FlowTrace,
    request: FlowTrace['requests'][number],
  ): boolean | null {
    if (trace.execution !== null) {
      const key = `${request.method.toUpperCase()} ${stripQuery(request.path)}`;
      if (this.executedEndpoints.has(key) || this.executedRequests.has(request.id)) return true;
    }
    return request.backend === null ? null : false;
  }

  private projectTrace(trace: FlowTrace): void {
    const elementId = elementNodeId(trace.element, trace.handler, trace.id);
    const elementNode = baseNode(elementId, 'element', elementTitle(trace.element), ['RUNTIME']);
    elementNode.subtitle = elementSubtitle(trace.element);
    const kind = asElementKind(trace.element.kind);
    if (kind !== null) elementNode.kind = kind;
    if (trace.element.selector !== undefined) elementNode.selector = trace.element.selector;
    if (trace.element.href !== undefined) elementNode.href = trace.element.href;
    if (trace.element.formAction !== undefined) elementNode.formAction = trace.element.formAction;
    if (trace.element.formMethod !== undefined) elementNode.formMethod = trace.element.formMethod;
    if (trace.element.formKey !== undefined) elementNode.formKey = trace.element.formKey;
    elementNode.traceIds = [trace.id];
    elementNode.firstSeen = trace.createdAt;
    elementNode.lastSeen = trace.createdAt;
    const keyed = trace.element.key !== undefined && trace.element.key !== null;
    this.addNode(elementNode, !keyed);

    let handlerId: string | null = null;
    if (trace.handler !== null) {
      handlerId = handlerNodeIdFor(trace.handler, trace.id);
      const handlerNode = baseNode(handlerId, 'handler', handlerTitle(trace.handler), ['RUNTIME']);
      handlerNode.subtitle = handlerSubtitle(trace.handler);
      handlerNode.file = trace.handler.url;
      handlerNode.line = trace.handler.line;
      handlerNode.traceIds = [trace.id];
      handlerNode.firstSeen = trace.createdAt;
      handlerNode.lastSeen = trace.createdAt;
      handlerNode.note = trace.handler.note;
      this.addNode(handlerNode, true);
      this.addEdge('TRIGGERS', elementId, handlerId, ['RUNTIME'], 'direct', {
        lastSeen: trace.createdAt,
        traceIds: [trace.id],
      });
    }

    const routeId = this.routeForTrace(trace);
    const functionId = routeId === null ? null : (this.routeFunction.get(routeId) ?? null);

    for (const request of trace.requests) {
      const requestNode = this.traceRequestNode(trace, request);
      this.addNode(requestNode);

      let routeForRequest = this.requestRoute.get(request.id);
      if (routeForRequest === undefined) {
        const matched = this.match(request.method, request.path);
        routeForRequest = matched === null ? null : routeNodeId(matched);
        this.requestRoute.set(request.id, routeForRequest);
        if (matched !== null) {
          this.attachMatch(requestNode.id, matched, 1, trace.id, request.wallStartedAt);
        }
      } else if (routeForRequest !== null) {
        const matched = this.match(request.method, request.path);
        if (matched !== null) {
          this.attachMatch(requestNode.id, matched, 0, trace.id, request.wallStartedAt);
        }
      }
      if (routeForRequest === null && trace.backend !== null) {
        const backendRouteId = this.routeByBackend.get(
          backendKey(
            trace.backend.method,
            trace.backend.routePath,
            trace.backend.file,
            trace.backend.routeLine,
          ),
        );
        if (backendRouteId !== undefined) {
          this.requestRoute.set(request.id, backendRouteId);
          this.addEdge(
            'MATCHES',
            requestNode.id,
            backendRouteId,
            ['STATIC', 'RUNTIME'],
            'heuristic',
            {
              note: 'Ruta tomada de la tarjeta; el índice actual no confirma el camino.',
              lastSeen: request.wallStartedAt,
              traceIds: [trace.id],
            },
          );
          this.addTraceToNode(backendRouteId, trace.id, request.wallStartedAt);
          const routeNode = this.nodes.get(backendRouteId);
          if (routeNode !== undefined) routeNode.occurrences += 1;
          const backendFunctionId = this.routeFunction.get(backendRouteId);
          if (backendFunctionId !== undefined) {
            const functionNode = this.nodes.get(backendFunctionId);
            if (functionNode !== undefined) functionNode.occurrences += 1;
          }
        }
      }

      if (handlerId !== null && trace.handler !== null) {
        const direct =
          trace.handler.name !== null &&
          request.initiatorFunction !== null &&
          request.initiatorFunction === trace.handler.name;
        this.addEdge(
          'SENDS',
          handlerId,
          requestNode.id,
          ['RUNTIME'],
          direct ? 'direct' : 'heuristic',
          {
            lastSeen: request.wallStartedAt,
            traceIds: [trace.id],
            note: direct ? null : requestSendNote(trace.handler, request),
          },
        );
      } else {
        this.addEdge('SENDS', elementId, requestNode.id, ['RUNTIME'], 'heuristic', {
          lastSeen: request.wallStartedAt,
          traceIds: [trace.id],
          note: 'Clic sin manejador resuelto; la petición se observó después del clic.',
        });
      }
    }

    this.projectTraceQueries(trace, functionId);
    this.projectExecution(trace, routeId, functionId);
  }

  private routeForTrace(trace: FlowTrace): string | null {
    for (const request of trace.requests) {
      const known = this.requestRoute.get(request.id);
      if (known !== undefined && known !== null) return known;
    }
    if (trace.backend !== null) {
      const byBackend = this.routeByBackend.get(
        backendKey(
          trace.backend.method,
          trace.backend.routePath,
          trace.backend.file,
          trace.backend.routeLine,
        ),
      );
      if (byBackend !== undefined) return byBackend;
    }
    for (const request of trace.requests) {
      const matched = this.match(request.method, request.path);
      if (matched !== null) return routeNodeId(matched);
    }
    return null;
  }

  private projectTraceQueries(trace: FlowTrace, functionId: string | null): void {
    for (const query of trace.queries) {
      const existingId = `query:${query.id}`;
      if (this.nodes.has(existingId)) {
        if (query.status === 'observed') {
          this.markQueryObserved(trace, query, existingId, functionId);
        }
        continue;
      }
      if (query.status === 'possible') {
        this.projectCardStaticQuery(trace, query, functionId);
      } else {
        this.projectRuntimeQuery(trace, query, functionId);
      }
    }
  }

  private projectCardStaticQuery(
    trace: FlowTrace,
    query: FlowTraceQuery,
    functionId: string | null,
  ): void {
    const file = trace.backend?.file ?? null;
    const queryId = `query:${query.id}`;
    const node = baseNode(queryId, 'query', SQL_LABELS[query.operation], ['STATIC']);
    node.subtitle = querySubtitle(query, file);
    node.file = file;
    node.line = query.line;
    node.operation = query.operation;
    node.dialect = query.dialect;
    node.parse = query.parse;
    node.sql = query.sql;
    node.tablesRead = [...query.tablesRead];
    node.tablesWritten = [...query.tablesWritten];
    node.note = query.note;
    node.traceIds = [trace.id];
    node.occurrences = 0;
    this.addNode(node);

    const target = functionId ?? this.findFunctionNode(file, query.line);
    if (target !== null) {
      this.addEdge('QUERIES', target, queryId, ['STATIC'], 'direct');
      this.addTraceToNode(target, trace.id, trace.createdAt);
    } else {
      node.note = appendNote(node.note, 'Sin función asociada.');
    }
    this.projectTables(queryId, query);
    this.projectDatabase(queryId, file, query, 0, []);
  }

  private markQueryObserved(
    trace: FlowTrace,
    query: FlowTraceQuery,
    queryId: string,
    functionId: string | null,
  ): void {
    const node = this.nodes.get(queryId);
    if (node === undefined) return;
    const at = query.observedAt ?? trace.createdAt;
    mergeEvidence(node.evidence, ['RUNTIME']);
    node.note = appendNote(node.note, 'Observada en ejecución.');
    node.lastSeen = latest(node.lastSeen, at);
    node.occurrences += 1;
    mergeStrings(node.traceIds, [trace.id]);

    const target = functionId ?? this.findFunctionNode(node.file, node.line);
    if (target !== null) {
      this.addEdge('QUERIES', target, queryId, ['STATIC', 'RUNTIME'], 'direct', {
        increment: 0,
        note: 'Consulta ejecutada durante la traza.',
        lastSeen: at,
        traceIds: [trace.id],
      });
      this.addTraceToNode(target, trace.id, at);
    }
  }

  private projectRuntimeQuery(
    trace: FlowTrace,
    query: FlowTraceQuery,
    functionId: string | null,
  ): void {
    const file = trace.backend?.file ?? trace.execution?.file ?? null;
    const at = query.observedAt ?? trace.createdAt;
    const normalized = normalizeSqlText(query.sql ?? '');
    const queryId = `query:runtime:${file ?? ''}:${String(query.line)}:${hashText(normalized)}`;
    const node = baseNode(queryId, 'query', SQL_LABELS[query.operation], ['RUNTIME']);
    node.subtitle = querySubtitle(query, file);
    node.file = file;
    node.line = query.line > 0 ? query.line : null;
    node.operation = query.operation;
    node.dialect = query.dialect;
    node.parse = query.parse;
    node.sql = query.sql;
    node.tablesRead = [...query.tablesRead];
    node.tablesWritten = [...query.tablesWritten];
    node.note = appendNote(
      query.note,
      'Consulta observada en ejecución; sin sitio estático equivalente.',
    );
    node.traceIds = [trace.id];
    node.firstSeen = at;
    node.lastSeen = at;
    this.addNode(node, true);

    const target =
      functionId ??
      this.findFunctionNode(file, query.line) ??
      this.ensureRuntimeFunction(trace, file, query.line, query.column, at);
    if (target === null) {
      node.note = appendNote(node.note, 'Sin función asociada.');
    } else {
      this.addEdge('QUERIES', target, queryId, ['RUNTIME'], 'heuristic', {
        note: 'Consulta capturada del driver; asociación por ruta y ventana de 3 s.',
        lastSeen: at,
        traceIds: [trace.id],
      });
      this.addTraceToNode(target, trace.id, at);
    }
    this.projectTables(queryId, query);
    this.projectDatabase(queryId, file, query, at, [trace.id]);
  }

  private projectExecution(
    trace: FlowTrace,
    routeId: string | null,
    functionId: string | null,
  ): void {
    const execution = trace.execution;
    if (execution === null) return;
    const existingFunction = functionId ?? this.findFunctionNode(execution.file, execution.line);
    const target =
      existingFunction ??
      this.ensureRuntimeFunction(
        trace,
        execution.file,
        execution.line,
        execution.column,
        execution.observedAt,
      );
    if (target === null) return;
    if (routeId === null) {
      const targetNode = this.nodes.get(target);
      if (targetNode !== undefined && existingFunction !== null) targetNode.occurrences += 1;
    }
    if (routeId !== null && functionId !== null) {
      this.addEdge('HANDLES', routeId, functionId, ['STATIC', 'RUNTIME'], 'heuristic', {
        increment: 0,
        note: `Ejecución observada con Node Inspector en ${execution.file}:${String(execution.line)}; asociación por ruta y ventana de 3 s.`,
        lastSeen: execution.observedAt,
        traceIds: [trace.id],
      });
    }
    this.addTraceToNode(target, trace.id, execution.observedAt);
  }

  private ensureRuntimeFunction(
    trace: FlowTrace,
    file: string | null,
    line: number,
    column: number,
    at: number,
  ): string | null {
    if (file === null || line <= 0) return null;
    const existing = this.findFunctionNode(file, line);
    if (existing !== null) return existing;
    const id = `function:${file}:${String(line)}:${String(line)}`;
    if (this.functionIds.has(id)) return id;
    this.functionIds.add(id);
    this.functions.push({ id, file, line, endLine: line });
    const node = baseNode(id, 'function', trace.execution?.functionName ?? 'Función en ejecución', [
      'RUNTIME',
    ]);
    node.subtitle = `${file}:${String(line)}:${String(column)}`;
    node.file = file;
    node.line = line;
    node.endLine = line;
    node.note = 'Función observada en ejecución; sin rango estático.';
    node.traceIds = [trace.id];
    node.firstSeen = at;
    node.lastSeen = at;
    this.addNode(node);
    return id;
  }

  private findFunctionNode(file: string | null, line: number | null): string | null {
    if (file === null || line === null || line <= 0) return null;
    let best: FunctionEntry | null = null;
    for (const entry of this.functions) {
      if (entry.file !== file) continue;
      if (line < entry.line || line > entry.endLine) continue;
      if (best === null || entry.endLine - entry.line < best.endLine - best.line) {
        best = entry;
      }
    }
    return best?.id ?? null;
  }

  private attachMatch(
    requestId: string,
    route: StaticRoute,
    increment: number,
    traceId: string | null,
    lastSeen: number,
  ): void {
    const routeId = routeNodeId(route);
    if (!this.routeNodes.has(routeId)) return;
    const suffix = route.note !== null && route.note.includes(SUFFIX_NOTE);
    this.addEdge(
      'MATCHES',
      requestId,
      routeId,
      ['STATIC', 'RUNTIME'],
      suffix ? 'heuristic' : 'direct',
      {
        increment,
        note: suffix ? route.note : null,
        lastSeen,
        traceIds: traceId === null ? [] : [traceId],
      },
    );
    if (traceId !== null) {
      this.addTraceToNode(routeId, traceId, lastSeen);
      const functionId = this.routeFunction.get(routeId);
      if (functionId !== undefined) this.addTraceToNode(functionId, traceId, lastSeen);
    }
    if (increment > 0) {
      const routeNode = this.nodes.get(routeId);
      if (routeNode !== undefined) routeNode.occurrences += increment;
      const functionId = this.routeFunction.get(routeId);
      if (functionId !== undefined) {
        const functionNode = this.nodes.get(functionId);
        if (functionNode !== undefined) functionNode.occurrences += increment;
      }
    }
  }

  private addTraceToNode(id: string, traceId: string, at: number): void {
    const node = this.nodes.get(id);
    if (node === undefined) return;
    mergeStrings(node.traceIds, [traceId]);
    if (at > 0) {
      node.firstSeen = earliest(node.firstSeen, at);
      node.lastSeen = latest(node.lastSeen, at);
    }
  }

  private match(method: string, path: string): StaticRoute | null {
    const key = `${method.toUpperCase()} ${stripQuery(path)}`;
    if (this.matchCache.has(key)) return this.matchCache.get(key) ?? null;
    const matched = matchRoute(this.input.routes, method, path);
    this.matchCache.set(key, matched);
    return matched;
  }

  private addNode(node: FlowNode, increment = false): FlowNode {
    const existing = this.nodes.get(node.id);
    if (existing === undefined) {
      this.nodes.set(node.id, node);
      return node;
    }
    const newer = node.lastSeen >= existing.lastSeen;
    mergeEvidence(existing.evidence, node.evidence);
    mergeStrings(existing.traceIds, node.traceIds);
    mergeStrings(existing.requestIds, node.requestIds);
    if (increment) existing.occurrences += node.occurrences;
    existing.firstSeen = earliest(existing.firstSeen, node.firstSeen);
    existing.lastSeen = latest(existing.lastSeen, node.lastSeen);
    existing.note = appendNote(existing.note, node.note);
    if (existing.subtitle === null) existing.subtitle = node.subtitle;
    if (existing.url === null && node.url !== null) existing.url = node.url;
    if (node.statusCode !== undefined && node.statusCode !== null) {
      existing.statusCode = node.statusCode;
    }
    if (node.durationMs !== undefined && node.durationMs !== null) {
      existing.durationMs = node.durationMs;
    }
    if (node.outcome !== undefined && node.outcome !== null) existing.outcome = node.outcome;
    if (node.backendObserved === true) {
      existing.backendObserved = true;
    } else if (node.backendObserved === false && existing.backendObserved !== true) {
      existing.backendObserved = false;
    }
    if (node.origin !== undefined && node.origin !== null) existing.origin = node.origin;
    if (node.initiatorFunction !== undefined && node.initiatorFunction !== null) {
      existing.initiatorFunction = node.initiatorFunction;
    }
    if (node.kind !== undefined && node.kind !== null) {
      if (existing.kind === undefined || existing.kind === null) existing.kind = node.kind;
    }
    if (existing.selector === undefined || existing.selector === null) {
      existing.selector = node.selector ?? existing.selector;
    }
    if (existing.href === undefined || existing.href === null) {
      existing.href = node.href ?? existing.href;
    }
    if (existing.formAction === undefined || existing.formAction === null) {
      existing.formAction = node.formAction ?? existing.formAction;
    }
    if (existing.formMethod === undefined || existing.formMethod === null) {
      existing.formMethod = node.formMethod ?? existing.formMethod;
    }
    if (existing.formKey === undefined || existing.formKey === null) {
      existing.formKey = node.formKey ?? existing.formKey;
    }
    if (existing.disabled === undefined || existing.disabled === null) {
      existing.disabled = node.disabled ?? existing.disabled;
    }
    if (newer && node.visible !== undefined) existing.visible = node.visible;
    if (node.handlers !== undefined) {
      const handlers = existing.handlers ?? [];
      for (const hint of node.handlers) {
        if (
          !handlers.some(
            (entry) =>
              entry.event === hint.event &&
              entry.source === hint.source &&
              entry.name === hint.name,
          )
        ) {
          handlers.push(hint);
        }
      }
      existing.handlers = handlers;
    }
    if (node.events !== undefined) {
      const events = existing.events ?? [];
      for (const event of node.events) {
        const current = events.find((entry) => entry.event === event.event);
        if (current === undefined) {
          events.push({ ...event });
        } else {
          current.count += event.count;
          current.firstSeen = earliest(current.firstSeen, event.firstSeen);
          current.lastSeen = latest(current.lastSeen, event.lastSeen);
        }
      }
      existing.events = events;
    }
    return existing;
  }

  private addEdge(
    type: FlowEdgeType,
    from: string,
    to: string,
    evidence: FlowEvidenceKind[],
    correlation: FlowCorrelation,
    options: EdgeOptions = {},
  ): void {
    const id = `${type}|${from}|${to}`;
    const existing = this.edges.get(id);
    if (existing === undefined) {
      this.edges.set(id, {
        id,
        type,
        from,
        to,
        evidence: canonicalEvidence(evidence),
        correlation,
        occurrences: 1,
        lastSeen: options.lastSeen ?? 0,
        traceIds: unique(options.traceIds ?? []),
        note: options.note ?? null,
      });
      return;
    }
    mergeEvidence(existing.evidence, evidence);
    if (correlation === 'heuristic') existing.correlation = 'heuristic';
    existing.occurrences += options.increment ?? 1;
    existing.lastSeen = latest(existing.lastSeen, options.lastSeen ?? 0);
    mergeStrings(existing.traceIds, options.traceIds ?? []);
    existing.note = appendNote(existing.note, options.note ?? null);
  }

  private finalizeNodeNotes(): void {
    for (const edge of this.edges.values()) {
      if (edge.type !== 'READS' && edge.type !== 'WRITES' && edge.type !== 'USES') continue;
      const source = this.nodes.get(edge.from);
      if (source === undefined || source.type !== 'query' || source.occurrences <= 0) continue;
      const target = this.nodes.get(edge.to);
      if (target === undefined) continue;
      if (target.type !== 'table' && target.type !== 'database') continue;
      target.occurrences += source.occurrences;
    }
    for (const node of this.nodes.values()) {
      if (node.occurrences <= 1) continue;
      const label = node.countLabel ?? 'Repeticiones';
      if (node.type === 'element') {
        node.note = appendNote(
          node.note,
          `Se usó en ${String(node.occurrences)} interacciones de la sesión.`,
        );
      } else if (node.type === 'handler') {
        node.note = appendNote(
          node.note,
          `Se ejecutó en ${String(node.occurrences)} interacciones de la sesión.`,
        );
      } else if (node.type === 'route' || node.type === 'function') {
        node.note = appendNote(node.note, `${label}: ${String(node.occurrences)} en la sesión.`);
      } else if (node.type === 'query' || node.type === 'table' || node.type === 'database') {
        node.note = appendNote(node.note, `${label}: ${String(node.occurrences)}.`);
      }
    }
  }

  private stats(): FlowStats {
    let clicks = 0;
    let interactions = 0;
    for (const summary of this.input.interactions) {
      interactions += summary.count;
      if (summary.event === 'click') clicks += summary.count;
    }
    if (clicks === 0) clicks = this.input.traces.length;
    const stats: FlowStats = {
      clicks,
      interactions,
      controls: 0,
      forms: 0,
      requests: 0,
      externalRequests: this.externalRequests,
      preflightRequests: this.preflightRequests,
      routes: 0,
      functions: 0,
      queries: 0,
      tables: 0,
      databases: 0,
    };
    for (const node of this.nodes.values()) {
      switch (node.type) {
        case 'request':
          stats.requests += 1;
          break;
        case 'route':
          stats.routes += 1;
          break;
        case 'function':
          stats.functions += 1;
          break;
        case 'query':
          stats.queries += 1;
          break;
        case 'table':
          stats.tables += 1;
          break;
        case 'database':
          stats.databases += 1;
          break;
        case 'element':
          if (node.kind === 'page') break;
          stats.controls += 1;
          if (node.kind === 'form') stats.forms += 1;
          break;
        case 'handler':
          break;
        default:
          break;
      }
    }
    return stats;
  }
}

export function buildFlowSnapshot(input: FlowGraphInput): FlowSnapshot {
  return new FlowGraphBuilder(input).build();
}
