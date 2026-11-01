import type {
  HandlerSource,
  InspectionBackend,
  InspectionBreakpoint,
  InspectionCard,
  InspectionCorrelation,
  InspectionElement,
  InspectionEndpoint,
  InspectionExecution,
  InspectionHandler,
  InspectionLevel,
  InspectionRequest,
  InspectionRequestBackend,
  InspectionSqlOperation,
  InspectionSqlQuery,
  InspectionStatus,
  RequestOutcome,
} from '@bdt/protocol';

export interface FlowTraceHandler {
  event: 'click' | 'submit';
  name: string | null;
  url: string | null;
  line: number | null;
  column: number | null;
  source: HandlerSource;
  note: string | null;
}

export interface FlowTraceRequest {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  wallStartedAt: number;
  statusCode: number | null;
  durationMs: number | null;
  outcome: RequestOutcome;
  correlation: InspectionCorrelation;
  initiatorFunction: string | null;
  phase: 'after-click';
  backend: InspectionRequestBackend | null;
}

export interface FlowTraceBackend {
  method: string;
  routePath: string;
  handlerName: string | null;
  file: string;
  line: number;
  routeLine: number;
  endLine: number;
  framework: string;
  resolved: boolean;
  note: string | null;
}

export interface FlowTraceQuery {
  id: string;
  status: 'possible' | 'observed';
  operation: InspectionSqlOperation;
  tablesRead: string[];
  tablesWritten: string[];
  dialect: string | null;
  parse: 'ast' | 'fallback';
  selectStar: boolean;
  sql: string | null;
  dynamic: boolean;
  line: number;
  column: number;
  callMethod: string | null;
  callObject: string | null;
  note: string | null;
  observedAt: number | null;
}

export interface FlowTraceExecution {
  functionName: string | null;
  file: string;
  line: number;
  column: number;
  observedAt: number;
  breakpoints: InspectionBreakpoint[];
}

export interface FlowTrace {
  id: string;
  status: InspectionStatus;
  createdAt: number;
  element: InspectionElement;
  handler: FlowTraceHandler | null;
  requests: FlowTraceRequest[];
  endpoint: InspectionEndpoint | null;
  backend: FlowTraceBackend | null;
  queries: FlowTraceQuery[];
  execution: FlowTraceExecution | null;
  evidence: Array<'RUNTIME' | 'STATIC'>;
  level: InspectionLevel;
  note: string | null;
}

function projectHandler(handler: InspectionHandler | null): FlowTraceHandler | null {
  if (handler === null) return null;
  return {
    event: handler.event,
    name: handler.name,
    url: handler.url,
    line: handler.line,
    column: handler.column,
    source: handler.source,
    note: handler.note,
  };
}

function projectBackend(backend: InspectionBackend | null): FlowTraceBackend | null {
  if (backend === null) return null;
  return {
    method: backend.method,
    routePath: backend.routePath,
    handlerName: backend.handlerName,
    file: backend.file,
    line: backend.line,
    routeLine: backend.routeLine,
    endLine: backend.endLine,
    framework: backend.framework,
    resolved: backend.resolved,
    note: backend.note,
  };
}

function projectRequest(request: InspectionRequest): FlowTraceRequest {
  return {
    id: request.id,
    method: request.method,
    path: request.path,
    startedAt: request.startedAt,
    wallStartedAt: request.wallStartedAt,
    statusCode: request.statusCode,
    durationMs: request.durationMs,
    outcome: request.outcome,
    correlation: request.correlation,
    initiatorFunction: request.initiatorFunction,
    phase: 'after-click',
    backend: request.backend === null ? null : { ...request.backend },
  };
}

function projectQuery(query: InspectionSqlQuery): FlowTraceQuery {
  return {
    id: query.id,
    status: query.status,
    operation: query.operation,
    tablesRead: [...query.tablesRead],
    tablesWritten: [...query.tablesWritten],
    dialect: query.dialect,
    parse: query.parse,
    selectStar: query.selectStar,
    sql: query.sql,
    dynamic: query.dynamic,
    line: query.line,
    column: query.column,
    callMethod: query.callMethod,
    callObject: query.callObject,
    note: query.note,
    observedAt: query.observedAt,
  };
}

function projectExecution(execution: InspectionExecution | null): FlowTraceExecution | null {
  if (execution === null) return null;
  return {
    functionName: execution.functionName,
    file: execution.file,
    line: execution.line,
    column: execution.column,
    observedAt: execution.observedAt,
    breakpoints: execution.breakpoints.map((breakpoint) => ({ ...breakpoint })),
  };
}

export function projectTrace(card: InspectionCard): FlowTrace {
  return {
    id: card.id,
    status: card.status,
    createdAt: card.createdAt,
    element: { ...card.element },
    handler: projectHandler(card.handler),
    requests: card.requests
      .filter((request) => request.phase === 'after-click')
      .map(projectRequest),
    endpoint: card.endpoint === null ? null : { ...card.endpoint },
    backend: projectBackend(card.backend),
    queries: card.queries.map(projectQuery),
    execution: projectExecution(card.execution),
    evidence: [...card.evidence],
    level: card.level,
    note: card.note,
  };
}

export class FlowLedger {
  private readonly traces = new Map<string, FlowTrace>();

  upsert(card: InspectionCard): void {
    this.traces.set(card.id, projectTrace(card));
  }

  all(): FlowTrace[] {
    return [...this.traces.values()];
  }

  clear(): void {
    this.traces.clear();
  }
}
