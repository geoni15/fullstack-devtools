import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  InspectionBreakpoint,
  InspectionCodeBlock,
  InspectionExecution,
  InspectionRuntime,
} from '@bdt/protocol';
import type { StaticRoute, StaticSqlSite } from '@bdt/routes-index';
import type { Logger } from '../logger';
import { isLoopbackHost } from './endpoints';
import {
  JSON_CAPTURE_DRAIN_EXPRESSION,
  JSON_CAPTURE_SOURCE,
  parseCapturedJson,
  parseJsonCaptureInfo,
  type CapturedJsonExecution,
  type JsonCaptureInfo,
} from './json-capture';
import {
  SQL_CAPTURE_DRAIN_EXPRESSION,
  SQL_CAPTURE_SOURCE,
  parseCapturedSql,
  parseSqlCaptureInfo,
  type CapturedSqlExecution,
  type SqlCaptureInfo,
} from './sql-capture';
import { readCodeBlock } from './source-snippet';

const CONNECT_TIMEOUT_MS = 4000;
const COMMAND_TIMEOUT_MS = 5000;
const SQL_POLL_MS = 400;
const JSON_POLL_MS = 400;
const MAX_BREAKPOINTS = 200;
const EXECUTION_CONTEXT_BEFORE = 2;
const EXECUTION_CONTEXT_AFTER = 6;
const JAVASCRIPT_SOURCE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i;

interface CdpRequest {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
}

interface CdpCallFrame {
  functionName: string;
  url: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
}

interface CdpPaused {
  reason: string;
  callFrames: CdpCallFrame[];
  hitBreakpoints?: string[];
}

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

interface ScriptParsed {
  scriptId: string;
  url: string;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SqlObservation {
  siteIds: string[];
  breakpoints: InspectionBreakpoint[];
  functionName: string | null;
  file: string;
  line: number;
  column: number;
  observedAt: number;
}

interface BreakpointSite {
  route: StaticRoute;
  site: StaticSqlSite;
}

interface BreakpointGroup {
  file: string;
  line: number;
  routes: StaticRoute[];
  sql: BreakpointSite[];
}

export interface NodeInspectorOptions {
  getRootPath(): string | null;
  onRuntime(runtime: InspectionRuntime): void;
  onExecution(execution: InspectionExecution): void;
  onSqlExecuted(observation: SqlObservation): void;
  onSqlCaptured(execution: CapturedSqlExecution): void;
  onSqlCapture(info: SqlCaptureInfo): void;
  onJsonCaptured(execution: CapturedJsonExecution): void;
  onJsonCapture(info: JsonCaptureInfo): void;
  log: Logger;
}

function messageText(data: unknown): string | null {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as Uint8Array);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function uniqueBreakpoints(items: readonly InspectionBreakpoint[]): InspectionBreakpoint[] {
  const seen = new Set<string>();
  const result: InspectionBreakpoint[] = [];
  for (const item of items) {
    const key = `${item.method.toUpperCase()} ${item.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export class NodeInspector {
  private socket: WebSocket | null = null;
  private connected = false;
  private port: number | null = null;
  private generation = 0;
  private nextCommandId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly scripts = new Map<string, string>();
  private readonly breakpoints = new Map<string, BreakpointGroup>();
  private readonly recent: InspectionExecution[] = [];
  private readonly recentSql: SqlObservation[] = [];
  private routes: StaticRoute[] = [];
  private runtime: InspectionRuntime = { status: 'off', port: null, message: null };
  private queue: Promise<void> = Promise.resolve();
  private sqlTimer: ReturnType<typeof setTimeout> | null = null;
  private jsonTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: NodeInspectorOptions) {}

  getRuntime(): InspectionRuntime {
    return { ...this.runtime };
  }

  recentSince(since: number): InspectionExecution[] {
    return this.recent.filter((execution) => execution.observedAt >= since);
  }

  recentSqlSince(since: number): SqlObservation[] {
    return this.recentSql.filter((observation) => observation.observedAt >= since);
  }

  async connect(port: number): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.closeSocket();
    this.port = port;
    this.connected = false;
    this.setRuntime({
      status: 'connecting',
      port,
      message: `Conectando al inspector de Node en 127.0.0.1:${String(port)}…`,
    });

    try {
      const socketUrl = await this.resolveSocketUrl(port);
      if (!this.isCurrent(generation)) return;
      const socket = await this.openSocket(socketUrl);
      if (!this.isCurrent(generation)) {
        socket.close();
        return;
      }
      this.socket = socket;
      this.attachSocket(socket, generation);
      await this.send('Debugger.enable');
      await this.send('Runtime.enable').catch(() => undefined);
      await this.send('Debugger.setPauseOnExceptions', { state: 'none' }).catch(() => undefined);
      await this.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
      if (!this.isCurrent(generation)) return;
      this.connected = true;
      await this.setRoutes(this.routes);
      await this.startSqlCapture(generation);
      await this.startJsonCapture(generation);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.closeSocket();
      this.connected = false;
      this.options.log.warn('No se pudo conectar al inspector de Node', {
        port,
        message: error instanceof Error ? error.message : String(error),
      });
      this.setRuntime({
        status: 'unavailable',
        port,
        message: `No se pudo conectar al inspector de Node en 127.0.0.1:${String(port)}. Arranca el backend con «node --inspect=${String(port)}» y vuelve a conectar; el análisis estático sigue disponible.`,
      });
    }
  }

  async setRoutes(routes: readonly StaticRoute[]): Promise<void> {
    this.routes = routes.filter(
      (route) =>
        route.resolved &&
        route.line > 0 &&
        JAVASCRIPT_SOURCE.test(route.file) &&
        !/\.(?:min|d)\.(?:js|ts)$/i.test(route.file),
    );
    if (!this.connected) return;
    this.queue = this.queue
      .then(() => this.applyBreakpoints())
      .catch((error: unknown) => {
        this.options.log.warn('No se pudieron actualizar los puntos de parada', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    await this.queue;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.connected = false;
    this.routes = [];
    this.recent.length = 0;
    this.recentSql.length = 0;
    this.breakpoints.clear();
    this.scripts.clear();
    this.stopSqlPolling();
    this.stopJsonPolling();
    this.closeSocket();
    this.setRuntime({ status: 'off', port: null, message: null });
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private setRuntime(runtime: InspectionRuntime): void {
    this.runtime = runtime;
    this.options.onRuntime({ ...runtime });
  }

  private async resolveSocketUrl(port: number): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`El puerto respondió con estado ${String(response.status)}.`);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('La respuesta del inspector no es una lista de destinos.');
    }
    for (const item of payload) {
      if (!isRecord(item) || typeof item.webSocketDebuggerUrl !== 'string') {
        continue;
      }
      let url: URL;
      try {
        url = new URL(item.webSocketDebuggerUrl);
      } catch {
        continue;
      }
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        continue;
      }
      if (!isLoopbackHost(url.hostname) || Number(url.port) !== port) {
        continue;
      }
      return url.toString();
    }
    throw new Error('El inspector no publicó un WebSocket local utilizable.');
  }

  private openSocket(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // El socket pudo fallar antes de abrirse.
        }
        reject(new Error('Tiempo de espera al abrir el WebSocket del inspector.'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('No se pudo abrir el WebSocket del inspector.'));
      });
    });
  }

  private attachSocket(socket: WebSocket, generation: number): void {
    socket.addEventListener('message', (event: MessageEvent) => {
      if (!this.isCurrent(generation)) return;
      const text = messageText(event.data);
      if (text !== null) {
        this.handleMessage(text);
      }
    });
    socket.addEventListener('close', () => {
      if (!this.isCurrent(generation)) return;
      this.socket = null;
      this.connected = false;
      this.breakpoints.clear();
      this.stopSqlPolling();
      this.stopJsonPolling();
      this.rejectPending(new Error('La conexión con el inspector se cerró.'));
      this.setRuntime({
        status: 'unavailable',
        port: this.port,
        message:
          'La conexión con el inspector de Node se cerró. Vuelve a conectar para seguir viendo la ejecución.',
      });
    });
    socket.addEventListener('error', () => {
      if (!this.isCurrent(generation)) return;
      this.options.log.warn('Error del WebSocket del inspector de Node');
    });
  }

  private send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== 1) {
      return Promise.reject(new Error('El inspector de Node no está conectado.'));
    }
    const id = this.nextCommandId;
    this.nextCommandId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`El inspector no respondió a ${method}.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(text: string): void {
    let payload: CdpRequest;
    try {
      payload = JSON.parse(text) as CdpRequest;
    } catch {
      this.options.log.debug('Mensaje no JSON del inspector de Node');
      return;
    }

    if (typeof payload.id === 'number') {
      const pending = this.pending.get(payload.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      if (payload.error !== undefined) {
        pending.reject(new Error(payload.error.message ?? 'Orden CDP rechazada.'));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    if (payload.method === 'Debugger.scriptParsed') {
      const parsed = payload.params as ScriptParsed | undefined;
      if (parsed !== undefined && typeof parsed.scriptId === 'string') {
        this.scripts.set(parsed.scriptId, parsed.url);
      }
      return;
    }

    if (payload.method === 'Debugger.paused') {
      if (isRecord(payload.params) && Array.isArray(payload.params.callFrames)) {
        this.handlePaused(payload.params as unknown as CdpPaused);
      }
      return;
    }
  }

  private handlePaused(params: CdpPaused): void {
    const hit = (params.hitBreakpoints ?? []).find((id) => this.breakpoints.has(id));
    if (hit === undefined) {
      this.options.log.debug('Pausa de Node ajena al panel', {
        reason: params.reason,
        breakpoints: params.hitBreakpoints ?? [],
      });
      return;
    }
    const group = this.breakpoints.get(hit);
    if (group === undefined) {
      return;
    }
    const route = group.routes[0];

    const frames = params.callFrames.map((frame) => {
      const url = frame.url !== '' ? frame.url : (this.scripts.get(frame.location.scriptId) ?? '');
      return { frame, url, relative: this.relativeFile(url) };
    });
    const targetFile = route?.file ?? group.file;
    const chosen =
      frames.find((candidate) => candidate.relative === targetFile) ??
      frames.find(
        (candidate) =>
          candidate.relative !== null && !candidate.relative.split('/').includes('node_modules'),
      ) ??
      frames[0];

    void this.send('Debugger.resume').catch(() => undefined);

    if (chosen === undefined) {
      return;
    }

    const line = chosen.frame.location.lineNumber + 1;
    const column = chosen.frame.location.columnNumber + 1;
    const root = this.options.getRootPath();
    const functionName =
      chosen.frame.functionName !== '' ? chosen.frame.functionName : (route?.handlerName ?? null);
    const file = chosen.relative ?? (chosen.url !== '' ? chosen.url : targetFile);

    if (route !== undefined) {
      let code: InspectionCodeBlock | null = null;
      let codeNote: string | null = null;
      if (root === null) {
        codeNote = 'Abre la carpeta del proyecto para leer el código ejecutado.';
      } else if (chosen.relative === null) {
        codeNote = 'El código ejecutado está fuera de la carpeta abierta.';
      } else {
        try {
          code = readCodeBlock(
            root,
            chosen.relative,
            Math.max(1, line - EXECUTION_CONTEXT_BEFORE),
            line + EXECUTION_CONTEXT_AFTER,
            { maxLines: EXECUTION_CONTEXT_BEFORE + EXECUTION_CONTEXT_AFTER + 1 },
          );
        } catch (error) {
          codeNote =
            error instanceof Error ? error.message : 'No se pudo leer el código ejecutado.';
        }
      }

      const breakpoints: InspectionBreakpoint[] = group.routes.map((item) => ({
        method: item.method,
        path: item.path,
      }));
      const execution: InspectionExecution = {
        functionName,
        file,
        line,
        column,
        observedAt: Date.now(),
        breakpoints,
        code,
        codeNote,
      };

      this.recent.push(execution);
      this.options.log.info('Ejecución del backend observada', {
        file: execution.file,
        line,
        function: execution.functionName,
        routes: breakpoints,
      });
      this.options.onExecution(execution);
    }

    if (group.sql.length > 0) {
      const observation: SqlObservation = {
        siteIds: [...new Set(group.sql.map((item) => item.site.id))],
        breakpoints: uniqueBreakpoints(
          group.sql.map((item) => ({ method: item.route.method, path: item.route.path })),
        ),
        functionName,
        file,
        line,
        column,
        observedAt: Date.now(),
      };
      this.recentSql.push(observation);
      this.options.log.info('Ejecución de consulta SQL observada', {
        file: observation.file,
        line: observation.line,
        sites: observation.siteIds,
        routes: observation.breakpoints,
      });
      this.options.onSqlExecuted(observation);
    }
  }

  private relativeFile(url: string): string | null {
    const root = this.options.getRootPath();
    if (root === null || url === '') {
      return null;
    }
    let absolute: string;
    if (url.startsWith('file:')) {
      try {
        absolute = fileURLToPath(url);
      } catch {
        return null;
      }
    } else if (path.isAbsolute(url)) {
      absolute = url;
    } else {
      return null;
    }
    if (!isWithinRoot(root, absolute)) {
      return null;
    }
    return path.relative(root, absolute).split(path.sep).join('/');
  }

  private async applyBreakpoints(): Promise<void> {
    await this.removeBreakpoints();
    if (!this.connected) return;

    const root = this.options.getRootPath();
    if (root === null) {
      this.setRuntime({
        status: 'connected',
        port: this.port,
        message:
          'Inspector de Node conectado. Abre la carpeta del proyecto para marcar los manejadores de las rutas.',
      });
      return;
    }

    const groups = new Map<string, BreakpointGroup>();
    const siteLines = new Map<string, Set<string>>();
    for (const route of this.routes) {
      if (route.line > 0) {
        const key = `${route.file}:${String(route.line)}`;
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, { file: route.file, line: route.line, routes: [route], sql: [] });
        } else {
          group.routes.push(route);
        }
      }
      for (const site of route.sqlSites) {
        if (site.line <= 0) {
          continue;
        }
        const key = `${route.file}:${String(site.line)}`;
        const ids = siteLines.get(key);
        if (ids === undefined) {
          siteLines.set(key, new Set([site.id]));
        } else {
          ids.add(site.id);
        }
      }
    }

    for (const route of this.routes) {
      for (const site of route.sqlSites) {
        if (site.line <= 0) {
          continue;
        }
        const key = `${route.file}:${String(site.line)}`;
        const ids = siteLines.get(key);
        if (ids === undefined || ids.size !== 1) {
          continue;
        }
        if (!groups.has(key) && groups.size >= MAX_BREAKPOINTS) {
          continue;
        }
        const group = groups.get(key) ?? {
          file: route.file,
          line: site.line,
          routes: [],
          sql: [],
        };
        groups.set(key, group);
        if (!group.sql.some((item) => item.site.id === site.id)) {
          group.sql.push({ route, site });
        }
      }
    }

    const limited = [...groups.values()].slice(0, MAX_BREAKPOINTS);
    const sqlTotal = limited.reduce((sum, group) => sum + group.sql.length, 0);
    let located = 0;
    let failed = 0;
    for (const group of limited) {
      try {
        const url = pathToFileURL(path.resolve(root, group.file)).href;
        const result = await this.send<{ breakpointId: string; locations?: unknown[] }>(
          'Debugger.setBreakpointByUrl',
          { url, lineNumber: group.line - 1, columnNumber: 0 },
        );
        this.breakpoints.set(result.breakpointId, group);
        if (Array.isArray(result.locations) && result.locations.length > 0) {
          located += 1;
        }
      } catch (error) {
        failed += 1;
        this.options.log.debug('No se pudo marcar un punto de parada', {
          file: group.file,
          line: group.line,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const routeTotal = limited.filter((group) => group.routes.length > 0).length;
    const parts = [
      `Inspector de Node conectado · ${String(routeTotal)} ${routeTotal === 1 ? 'ruta marcada' : 'rutas marcadas'}`,
    ];
    if (sqlTotal > 0) {
      parts.push(
        `${String(sqlTotal)} ${sqlTotal === 1 ? 'consulta SQL vigilada' : 'consultas SQL vigiladas'}`,
      );
    }
    if (located > 0) {
      parts.push(`${String(located)} con ubicación resuelta`);
    }
    if (failed > 0) {
      parts.push(`${String(failed)} rechazadas`);
    }
    if (routeTotal === 0) {
      parts.push('sin rutas estáticas de Node para marcar');
    }
    this.setRuntime({ status: 'connected', port: this.port, message: parts.join(' · ') });
  }

  private async removeBreakpoints(): Promise<void> {
    const ids = [...this.breakpoints.keys()];
    this.breakpoints.clear();
    if (!this.connected) return;
    for (const breakpointId of ids) {
      await this.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => undefined);
    }
  }

  private async startSqlCapture(generation: number): Promise<void> {
    this.stopSqlPolling();
    try {
      const response = await this.send<EvaluateResult>('Runtime.evaluate', {
        expression: SQL_CAPTURE_SOURCE,
        awaitPromise: true,
        returnByValue: true,
        silent: true,
        includeCommandLineAPI: false,
      });
      if (!this.isCurrent(generation)) return;
      const raw = response.result?.value;
      let info: SqlCaptureInfo | null = null;
      if (typeof raw === 'string') {
        try {
          info = parseSqlCaptureInfo(JSON.parse(raw) as unknown);
        } catch {
          info = null;
        }
      }
      if (info !== null) {
        this.options.log.info('Captura SQL en runtime', {
          drivers: info.drivers,
          prisma: info.prisma,
          ok: info.ok,
        });
        this.options.onSqlCapture(info);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.options.log.debug('No se pudo activar la captura SQL en runtime', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.scheduleSqlPoll(generation);
  }

  private scheduleSqlPoll(generation: number): void {
    if (this.sqlTimer !== null || !this.connected) return;
    this.sqlTimer = setTimeout(() => {
      void this.pollSql(generation);
    }, SQL_POLL_MS);
  }

  private async pollSql(generation: number): Promise<void> {
    this.sqlTimer = null;
    if (!this.isCurrent(generation) || !this.connected) return;
    try {
      const response = await this.send<EvaluateResult>('Runtime.evaluate', {
        expression: SQL_CAPTURE_DRAIN_EXPRESSION,
        returnByValue: true,
        silent: true,
        includeCommandLineAPI: false,
      });
      if (!this.isCurrent(generation)) return;
      const raw = response.result?.value;
      if (typeof raw === 'string') {
        for (const execution of parseCapturedSql(raw)) {
          this.options.onSqlCaptured(execution);
        }
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.options.log.debug('No se pudo drenar la captura SQL', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.isCurrent(generation) && this.connected) {
      this.scheduleSqlPoll(generation);
    }
  }

  private stopSqlPolling(): void {
    if (this.sqlTimer !== null) {
      clearTimeout(this.sqlTimer);
      this.sqlTimer = null;
    }
  }

  private async startJsonCapture(generation: number): Promise<void> {
    this.stopJsonPolling();
    try {
      const response = await this.send<EvaluateResult>('Runtime.evaluate', {
        expression: JSON_CAPTURE_SOURCE,
        awaitPromise: true,
        returnByValue: true,
        silent: true,
        includeCommandLineAPI: false,
      });
      if (!this.isCurrent(generation)) return;
      const raw = response.result?.value;
      let info: JsonCaptureInfo | null = null;
      if (typeof raw === 'string') {
        try {
          info = parseJsonCaptureInfo(JSON.parse(raw) as unknown);
        } catch {
          info = null;
        }
      }
      if (info !== null) {
        this.options.log.info('Captura JSON en runtime', {
          hooks: info.hooks,
          ok: info.ok,
        });
        this.options.onJsonCapture(info);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.options.log.debug('No se pudo activar la captura JSON en runtime', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.scheduleJsonPoll(generation);
  }

  private scheduleJsonPoll(generation: number): void {
    if (this.jsonTimer !== null || !this.connected) return;
    this.jsonTimer = setTimeout(() => {
      void this.pollJson(generation);
    }, JSON_POLL_MS);
  }

  private async pollJson(generation: number): Promise<void> {
    this.jsonTimer = null;
    if (!this.isCurrent(generation) || !this.connected) return;
    try {
      const response = await this.send<EvaluateResult>('Runtime.evaluate', {
        expression: JSON_CAPTURE_DRAIN_EXPRESSION,
        returnByValue: true,
        silent: true,
        includeCommandLineAPI: false,
      });
      if (!this.isCurrent(generation)) return;
      const raw = response.result?.value;
      if (typeof raw === 'string') {
        for (const execution of parseCapturedJson(raw)) {
          this.options.onJsonCaptured(execution);
        }
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.options.log.debug('No se pudo drenar la captura JSON', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.isCurrent(generation) && this.connected) {
      this.scheduleJsonPoll(generation);
    }
  }

  private stopJsonPolling(): void {
    if (this.jsonTimer !== null) {
      clearTimeout(this.jsonTimer);
      this.jsonTimer = null;
    }
  }

  private closeSocket(): void {
    this.stopSqlPolling();
    this.stopJsonPolling();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.breakpoints.clear();
    this.rejectPending(new Error('La conexión con el inspector se cerró.'));
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // El socket pudo estar ya cerrado.
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
