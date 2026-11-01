import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import {
  BdtError,
  BROWSER_CHROME_CHANNELS,
  ERROR_CODES,
  IPC_CHANNELS,
  INSPECTION_MODES,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityTone,
  type BrowserBounds,
  type BrowserChromeState,
  type BrowserConfig,
  type BrowserEvent,
  type BrowserSnapshot,
  type BrowserState,
  type BrowserTargetsRequest,
  type CapturedRequest,
  type FlowMapState,
  type InspectionBackend,
  type InspectionCard,
  type InspectionCodeBlock,
  type InspectionElement,
  type InspectionExecution,
  type InspectionHandler,
  type InspectionMode,
  type InspectionRequest,
  type InspectionRequestBackend,
  type InspectionRequestPhase,
  type InspectionRuntime,
  type InspectionSqlQuery,
} from '@bdt/protocol';
import {
  RequestBuffer,
  findJsonTextMatches,
  maskUrl,
  sanitizeJsonBody,
  type JsonTextMatch,
  type RawInitiator,
} from '@bdt/network-capture';
import type { StaticRoute } from '@bdt/routes-index';
import { analyzeSql } from '@bdt/sql-analyzer';
import { createRootScope, type RootScope } from '../fs/root-guard';
import type { Logger } from '../logger';
import { AppLauncher, findFreeLoopbackPort, isUrlReachable } from '../process/app-launcher';
import { parseAppLaunch, type LaunchProgram } from '../process/launch-command';
import { hardenSession } from '../security';
import {
  ClickInspector,
  type HoverElementInfo,
  type HoverResolution,
  type HoverTipCode,
  type HoverTipData,
  type HoverTipRow,
  type InspectorClickSignal,
  type InspectorHoverSignal,
  type InspectorSignal,
} from './click-inspector';
import { databaseHintLabel, pickDatabaseHint } from './database-hints';
import { parseBrowserTargets } from './endpoints';
import { buildFlowSnapshot } from './flow-graph';
import { FlowLedger } from './flow-ledger';
import { FlowMapWindow } from './flow-map-window';
import { InspectionPanel } from './inspection-panel';
import { InteractionLedger } from './interaction-ledger';
import { NodeInspector, type SqlObservation } from './node-inspector';
import {
  INVENTORY_SCRIPT,
  parseInventory,
  type PageControl,
  type PageElementRef,
} from './page-inventory';
import { BackendRouteIndex, type DatabaseHint } from './routes';
import { readCodeBlock } from './source-snippet';
import type { CapturedSqlExecution, SqlCaptureInfo } from './sql-capture';
import type {
  RuntimeDataInfo,
  RuntimeFunctionInfo,
  RuntimeProvenance,
  RuntimeRenderInfo,
  RuntimeRequestInfo,
} from './runtime-provenance';
import { RuntimeHandlerLedger } from './runtime-handler-ledger';
import { RuntimeLinkLedger, type RuntimeLinkBasis } from './runtime-link-ledger';
import { normalizeSqlText, staticQueriesForRoute } from './sql-queries';
import { FRONTEND_FRAMEWORK_SCRIPT } from './stack-detection';
import { BROWSER_CHROME_HTML } from './ui-html';
import { WorkspaceSymbols, type ComponentSymbol } from './workspace-symbols';

interface CdpRequestWillBeSent {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    postData?: string;
  };
  type?: string;
  timestamp: number;
  wallTime?: number;
  initiator?: RawInitiator | null;
  redirectResponse?: { status: number; mimeType?: string };
}

interface CdpResponseReceived {
  requestId: string;
  response: { status: number; mimeType?: string };
}

interface CdpLoadingFinished {
  requestId: string;
  timestamp: number;
}

interface CdpLoadingFailed {
  requestId: string;
  timestamp: number;
  errorText?: string;
  canceled?: boolean;
}

interface PendingRequest {
  storeId: string;
  startedAt: number;
  statusCode: number | null;
  mimeType: string | null;
}

interface InspectionSession {
  id: string;
  clickedAt: number;
  handlerName: string | null;
  card: InspectionCard;
  requests: Map<string, InspectionRequest>;
  selectedByUser: boolean;
  executions: InspectionExecution[];
  sqlObservations: SqlObservation[];
  timer: ReturnType<typeof setTimeout> | null;
  routeLookupPending: boolean;
}

interface BackendSource {
  code: InspectionBackend['code'];
  note: string | null;
}

export interface BrowserControllerOptions {
  getWorkspaceRoot(): string | null;
  chromePreloadPath: string;
  panelPreloadPath: string;
  mapPreloadPath: string;
}

const PARTITION = 'bdt-inspector';
const FLUSH_INTERVAL_MS = 150;
const CDP_COMMAND_TIMEOUT_MS = 5000;
const CHROME_HEIGHT = 64;
const PANEL_WIDTH = 430;
const MIN_PANEL_WIDTH = 300;
const MIN_HOST_WIDTH_FOR_PANEL = 640;
const INSPECTION_WINDOW_MS = 3000;
const INSPECTION_LEEWAY_MS = 150;
const FLOW_REFRESH_MS = 1000;
const MAX_BACKEND_CODE_LINES = 80;
const MAX_ACTIVITY_DETAIL = 600;
const MAX_BODY_CHARS = 16000;
const CHROME_URL = `data:text/html;charset=utf-8,${encodeURIComponent(BROWSER_CHROME_HTML)}`;

function withTimeout<T>(command: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`El comando CDP ${label} no respondió a tiempo.`));
    }, CDP_COMMAND_TIMEOUT_MS);
    command.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function inventorySignature(controls: readonly PageControl[]): string {
  let hash = 0x811c9dc5;
  for (const control of controls) {
    const text = [
      control.key,
      control.kind,
      control.visible ? '1' : '0',
      control.disabled ? '1' : '0',
      control.text ?? '',
      control.ariaLabel ?? '',
      control.href ?? '',
      control.formAction ?? '',
      control.formMethod ?? '',
      control.formKey ?? '',
      control.handlers.map((hint) => `${hint.event}:${hint.source}:${hint.name ?? ''}`).join(','),
    ].join('\u0000');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${String(controls.length)}:${(hash >>> 0).toString(16)}`;
}

function idleState(config: BrowserConfig | null = null, inspectionEnabled = true): BrowserState {
  return {
    config,
    connected: false,
    currentUrl: null,
    title: null,
    loading: false,
    captureActive: false,
    inspectionEnabled,
    requestCount: 0,
    error: null,
  };
}

function shorten(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function stripQuery(value: string): string {
  const index = value.indexOf('?');
  return index === -1 ? value : value.slice(0, index);
}

function normalizedSourceText(value: string | null): string {
  return value === null ? '' : value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function hasJsonContentType(headers: Record<string, string> | undefined): boolean {
  if (headers === undefined) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type' && value.toLowerCase().includes('json')) {
      return true;
    }
  }
  return false;
}

function addEvidence(card: InspectionCard, evidence: 'RUNTIME' | 'STATIC'): void {
  if (!card.evidence.includes(evidence)) {
    card.evidence.push(evidence);
  }
}

const REQUEST_ORIGIN_LABEL: Record<CapturedRequest['origin'], string> = {
  backend: 'backend',
  frontend: 'frontend',
  external: 'externa',
};

function durationLabel(durationMs: number | null): string {
  if (durationMs === null) return '—';
  if (durationMs < 1000) return `${String(Math.round(durationMs))} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function sameProgram(first: LaunchProgram, second: LaunchProgram): boolean {
  if (first.kind === 'node' && second.kind === 'node') {
    return (
      first.node.entryPath === second.node.entryPath &&
      first.node.cwdPath === second.node.cwdPath &&
      first.node.args.join('\0') === second.node.args.join('\0')
    );
  }
  if (first.kind === 'npm' && second.kind === 'npm') {
    return first.npm.script === second.npm.script && first.npm.cwdPath === second.npm.cwdPath;
  }
  return false;
}

function sqlOperationFromText(sql: string): InspectionSqlQuery['operation'] {
  const match = /\b(select|insert|update|delete|replace)\b/i.exec(sql);
  const keyword = match?.[1]?.toLowerCase();
  if (keyword === 'select' || keyword === 'insert' || keyword === 'update') return keyword;
  if (keyword === 'delete' || keyword === 'replace') return keyword;
  return 'other';
}

const SQL_OPERATION_LABEL: Record<InspectionSqlQuery['operation'], string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  other: 'SQL',
};

const DIALECT_ENGINE: Record<string, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
};

const INSPECTION_MODE_LABEL: Record<InspectionMode, string> = {
  html: 'HTML/CSS',
  frontend: 'FRONTEND',
  backend: 'BACKEND',
  request: 'JSON',
  database: 'BASE DE DATOS',
};

const HANDLER_SOURCE_LABEL: Record<InspectionHandler['source'], string> = {
  listener: 'listener',
  react: 'React',
  vue: 'Vue',
};

interface StaticRequestCandidate {
  method: string;
  path: string;
  url: string;
  source: string;
  detail: string | null;
}

interface ExtractedRequest {
  method: string;
  url: string;
  source: string;
}

interface RuntimeLink {
  framework: 'react' | 'vue' | null;
  render: RuntimeRenderInfo | null;
  renderFile: string | null;
  renderLine: string | null;
  renderSymbol: ComponentSymbol | null;
  functions: RuntimeFunctionInfo[];
  data: RuntimeDataInfo | null;
  entries: RuntimeDataInfo[];
  requestInfo: RuntimeRequestInfo | null;
  request: CapturedRequest | null;
  route: StaticRoute | null;
  database: DatabaseHint | null;
  note: string | null;
}

interface HoverTextProvenance {
  query: string | null;
  matches: JsonTextMatch[];
  request: CapturedRequest | null;
  route: StaticRoute | null;
  database: DatabaseHint | null;
  runtime: RuntimeLink | null;
}

function shortFunctionSource(url: string): string {
  if (url === '') return '(inline)';
  const clean = url.replace(/^https?:\/\/[^/]+/i, '');
  return clean.length > 90 ? `…${clean.slice(-90)}` : clean;
}

const RUNTIME_SOURCE_DIRS = [
  'frontend',
  'client',
  'web',
  'app',
  'ui',
  'renderer',
  'desktop',
  'apps/frontend',
  'apps/client',
  'apps/web',
  'apps/app',
  'packages/frontend',
  'packages/client',
  'packages/web',
  'packages/ui',
  'packages/app',
];

function runtimeSourcePrefixes(): string[] {
  const prefixes: string[] = ['', 'src/'];
  for (const dir of RUNTIME_SOURCE_DIRS) {
    prefixes.push(`${dir}/`, `${dir}/src/`);
  }
  return prefixes;
}

function jsonMatchNote(match: JsonTextMatch): string {
  const notes: string[] = [];
  if (match.basis === 'data') notes.push('por datos');
  if (match.approximate && match.basis !== 'data') notes.push('aprox.');
  if (match.partial && match.basis !== 'data') notes.push('parcial');
  if (match.bodyTruncated) notes.push('cuerpo recortado');
  return notes.length === 0 ? '' : ` (${notes.join(', ')})`;
}

function displayNumbers(value: string): number[] {
  const cleaned = value.replace(/[^\d.,-]/g, '');
  if (cleaned === '' || !/\d/.test(cleaned)) return [];
  const variants = new Set<string>([
    cleaned.replace(/,/g, ''),
    cleaned.replace(/\./g, '').replace(/,/g, '.'),
    cleaned.replace(/[.,]/g, ''),
  ]);
  const result: number[] = [];
  for (const variant of variants) {
    const number = Number(variant);
    if (Number.isFinite(number)) result.push(number);
  }
  return result;
}

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function observedStatusLabel(request: CapturedRequest): string {
  const code =
    request.outcome === 'failed'
      ? 'ERR'
      : request.statusCode !== null
        ? String(request.statusCode)
        : request.outcome === 'pending'
          ? '…'
          : '—';
  const duration =
    request.durationMs !== null ? ` · ${String(Math.round(request.durationMs))} ms` : '';
  return `${formatClock(request.wallStartedAt)} · ${code}${duration}`;
}

function formatHoverSelector(element: HoverElementInfo): string {
  const id = element.id !== null ? `#${element.id}` : '';
  const classes = element.classes.map((name) => `.${name}`).join('');
  return `${element.tag}${id}${classes}`;
}

function hoverStyleValue(element: HoverElementInfo, name: string): string | null {
  const style = element.styles.find((entry) => entry.name === name);
  return style === undefined || style.value === '' ? null : style.value;
}

function hoverStyleGroup(element: HoverElementInfo, names: readonly string[]): string | null {
  const parts: string[] = [];
  for (const name of names) {
    const value = hoverStyleValue(element, name);
    if (value !== null) parts.push(`${name}: ${value}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function jsonParentCode(match: JsonTextMatch, request: CapturedRequest | null): HoverTipCode {
  const parentLines = match.parent.split('\n');
  return {
    file: `${match.origin === 'response' ? 'respuesta' : 'enviado'} JSON${
      request !== null ? ` · ${request.method} ${request.path}` : ''
    }`,
    range: `${match.parentPath}${match.parentTruncated ? ' · recortado' : ''}`,
    lines: parentLines.map((text, index) => ({ line: index + 1, text })),
  };
}

function toHoverCode(block: InspectionCodeBlock | null): HoverTipCode | null {
  if (block === null || block.lines.length === 0) return null;
  const range =
    block.startLine === block.endLine
      ? `línea ${String(block.startLine)}`
      : `líneas ${String(block.startLine)}–${String(block.endLine)}`;
  return {
    file: block.file,
    range: block.truncated ? `${range} · recortado` : range,
    lines: block.lines.map((line) => ({ line: line.line, text: line.text })),
  };
}

function looksLikeRequestUrl(value: string): boolean {
  if (value.length === 0 || value.length > 300 || value.includes('${')) return false;
  if (/^(?:#|javascript:|mailto:|tel:|data:|blob:)/i.test(value)) return false;
  return /^(?:https?:\/\/|\/)/i.test(value);
}

function extractRequestsFromCode(code: string): ExtractedRequest[] {
  const text = code;
  const results: ExtractedRequest[] = [];
  const add = (method: string, url: string, source: string): void => {
    const normalizedMethod = method.trim().toUpperCase().slice(0, 10);
    const normalizedUrl = url.trim();
    if (!/^[A-Z]+$/.test(normalizedMethod) || !looksLikeRequestUrl(normalizedUrl)) return;
    if (results.some((entry) => entry.method === normalizedMethod && entry.url === normalizedUrl)) {
      return;
    }
    results.push({ method: normalizedMethod, url: normalizedUrl, source });
  };

  for (const match of text.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`\n]{1,300})\1/g)) {
    const url = match[2];
    if (url === undefined) continue;
    const offset = (match.index ?? 0) + match[0].length;
    const tail = text.slice(offset, offset + 320);
    const method = /\bmethod\s*:\s*(['"`])([A-Za-z]{1,10})\1/.exec(tail);
    add(method?.[2] ?? 'GET', url, 'fetch');
  }
  for (const match of text.matchAll(
    /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\n]{1,300})\3/gi,
  )) {
    const object = match[1];
    const method = match[2];
    const url = match[4];
    if (object === undefined || method === undefined || url === undefined) continue;
    add(method, url, object);
  }
  for (const match of text.matchAll(/\baxios\s*\(\s*\{/g)) {
    const offset = match.index ?? 0;
    const scope = text.slice(offset, offset + 500);
    const url = /\burl\s*:\s*(['"`])([^'"`\n]{1,300})\1/.exec(scope);
    if (url === null || url[2] === undefined) continue;
    const method = /\bmethod\s*:\s*(['"`])([A-Za-z]{1,10})\1/.exec(scope);
    add(method?.[2] ?? 'GET', url[2], 'axios');
  }
  for (const match of text.matchAll(
    /\.open\s*\(\s*(['"`])([A-Za-z]{1,10})\1\s*,\s*(['"`])([^'"`\n]{1,300})\3/g,
  )) {
    const method = match[2];
    const url = match[4];
    if (method === undefined || url === undefined) continue;
    add(method, url, 'XMLHttpRequest');
  }
  return results;
}

function describeElement(element: InspectionElement): string | null {
  const parts: string[] = [];
  if (element.role !== null) parts.push(`role=${element.role}`);
  if (element.ariaLabel !== null) parts.push(`aria-label=${element.ariaLabel}`);
  if (element.inputType !== null) parts.push(`input[type=${element.inputType}]`);
  return parts.length === 0 ? null : parts.join(' · ');
}

interface ActivityInput {
  category: ActivityCategory;
  tone?: ActivityTone;
  title: string;
  detail?: string | null;
  method?: string | null;
  path?: string | null;
  file?: string | null;
  line?: number | null;
}

interface RelativeFrame {
  file: string;
  line: number;
  column: number;
}

const OFF_RUNTIME: InspectionRuntime = { status: 'off', port: null, message: null };

export class BrowserController {
  private window: BrowserWindow | null = null;
  private chromeWindow: BrowserWindow | null = null;
  private chromeReady = false;
  private view: WebContentsView | null = null;
  private buffer: RequestBuffer | null = null;
  private state: BrowserState;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private readonly pending = new Map<string, PendingRequest>();
  private readonly redirects = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionHardened = false;
  private inspector: ClickInspector | null = null;
  private inspectionEnabled = true;
  private inspectionMode: InspectionMode = 'html';
  private inspectionSession: InspectionSession | null = null;
  private inspectionSequence = 0;
  private hoverSequence = 0;
  private hoverPending: InspectorHoverSignal | null = null;
  private hoverResolving = false;
  private hoverProvenanceCache: { key: string; at: number; value: HoverTextProvenance } | null =
    null;
  private readonly hoverBackendCodeCache = new Map<string, { at: number; value: BackendSource }>();
  private readonly runtimeFileCache = new Map<string, string | null>();
  private readonly symbols = new WorkspaceSymbols(() => this.options.getWorkspaceRoot());
  private readonly runtimeSourceCache = new Map<
    string,
    { at: number; value: { file: string | null; line: string | null; snippet: string | null } }
  >();
  private cdpClockOffsetMs: number | null = null;
  private panelView: WebContentsView | null = null;
  private readonly mapWindow: FlowMapWindow;
  private panelRuntime: InspectionRuntime = { ...OFF_RUNTIME };
  private runtime: NodeInspector | null = null;
  private frontendLauncher: AppLauncher | null = null;
  private backendLauncher: AppLauncher | null = null;
  private readonly panel: InspectionPanel;
  private readonly routes: BackendRouteIndex;
  private activity: ActivityEvent[] = [];
  private pendingActivity: ActivityEvent[] = [];
  private activitySequence = 0;
  private lastRuntimeStatus: string | null = null;
  private readonly runtimeSqlActivitySeen = new Set<string>();
  private sqlRuntimeSequence = 0;
  private readonly flowLedger = new FlowLedger();
  private readonly flowInteractions = new InteractionLedger();
  private readonly runtimeLinks = new RuntimeLinkLedger();
  private readonly runtimeHandlers = new RuntimeHandlerLedger();
  private readonly autoResolved = new Set<string>();
  private autoResolveTimer: ReturnType<typeof setTimeout> | null = null;
  private autoResolveRunning = false;
  private autoResolveWanted = false;
  private autoResolveGeneration = 0;
  private inventory: PageControl[] = [];
  private inventoryKey = '';
  private inventoryTimer: ReturnType<typeof setTimeout> | null = null;
  private flowState: FlowMapState = { open: false, building: false, error: null, snapshot: null };
  private mapOpen = false;
  private flowRevision = 0;
  private flowDirty = false;
  private flowTimer: ReturnType<typeof setTimeout> | null = null;
  private flowBuilding = false;
  private flowGeneration = 0;
  private frontendFramework: string | null = null;
  private frontendFrameworkUrl: string | null = null;
  private frontendDetection: Promise<string | null> | null = null;
  private frontendDetectionUrl: string | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly log: Logger,
    private readonly options: BrowserControllerOptions,
  ) {
    this.state = idleState();
    this.panel = new InspectionPanel(options.panelPreloadPath, log);
    this.mapWindow = new FlowMapWindow(options.mapPreloadPath, log, () => {
      this.handleMapWindowClosed();
    });
    this.routes = new BackendRouteIndex(() => this.options.getWorkspaceRoot(), log);
  }

  getState(): BrowserState {
    this.syncCount();
    return { ...this.state };
  }

  getSnapshot(): BrowserSnapshot {
    this.syncCount();
    return {
      state: { ...this.state },
      requests: this.buffer?.all() ?? [],
      activity: [...this.activity],
    };
  }

  async configure(request: BrowserTargetsRequest): Promise<BrowserSnapshot> {
    const config = parseBrowserTargets(request);
    const frontendProgram = this.prepareLaunch('frontend', config.frontendLaunch);
    const backendProgram = this.prepareLaunch('backend', config.backendLaunch);
    const window = this.getWindow();
    if (window === null || window.isDestroyed()) {
      throw new BdtError(ERROR_CODES.INTERNAL, 'La ventana principal no está disponible.');
    }

    this.teardownConnection();
    this.window = window;
    this.state = {
      ...idleState(config, this.inspectionEnabled),
      loading: true,
    };
    this.buffer = new RequestBuffer({
      frontendOrigin: config.frontend.origin,
      backendOrigin: config.backend.origin,
    });
    this.panelRuntime = { ...OFF_RUNTIME };

    const sharedProgram =
      frontendProgram !== null &&
      backendProgram !== null &&
      sameProgram(frontendProgram, backendProgram);
    try {
      if (backendProgram !== null && !sharedProgram) {
        if (await isUrlReachable(config.backend.url)) {
          this.recordActivity({
            category: 'backend',
            title: 'El backend ya estaba en marcha',
            detail: `No se lanzó el proceso detectado (${config.backend.url}).`,
          });
        } else {
          await this.launchBackend(config, backendProgram);
        }
      }
      if (frontendProgram !== null) {
        if (await isUrlReachable(config.frontend.url)) {
          this.recordActivity({
            category: 'frontend',
            title: 'El frontend ya estaba en marcha',
            detail: `No se lanzó el proceso detectado (${config.frontend.url}).`,
          });
        } else {
          await this.launchFrontend(config, frontendProgram);
          if (sharedProgram && config.frontendLaunch !== null && config.backendLaunch !== null) {
            config.backendLaunch = { ...config.backendLaunch, pid: config.frontendLaunch.pid };
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo arrancar el proyecto.';
      this.teardownConnection();
      this.state = { ...idleState(config, this.inspectionEnabled), error: message };
      this.emitState();
      throw new BdtError(ERROR_CODES.BROWSER_CONNECT_FAILED, message, { cause: error });
    }

    if (config.nodeInspectorPort !== null) {
      this.runtime = new NodeInspector({
        getRootPath: () => this.options.getWorkspaceRoot(),
        onRuntime: (runtime) => {
          this.onRuntimeChanged(runtime);
        },
        onExecution: (execution) => {
          this.onNodeExecution(execution);
        },
        onSqlExecuted: (observation) => {
          this.onSqlObserved(observation);
        },
        onSqlCaptured: (execution) => {
          this.onSqlCaptured(execution);
        },
        onSqlCapture: (info) => {
          this.onSqlCaptureChanged(info);
        },
        log: this.log,
      });
    }

    const hostWindow = config.mode === 'window' ? this.createChromeWindow() : window;
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(config.mode === 'embedded' ? false : true);
    this.view = view;
    hostWindow.contentView.addChildView(view);

    const panelView = this.panel.create();
    this.panelView = panelView;
    hostWindow.contentView.addChildView(panelView);
    if (config.nodeInspectorPort !== null) {
      void this.runtime?.connect(config.nodeInspectorPort);
    }
    this.updatePanel(null);

    if (config.mode === 'embedded') {
      this.applyBounds();
    } else {
      this.layoutChrome();
    }
    this.hardenView(view);
    this.wireView(view);

    try {
      await view.webContents.loadURL('about:blank');
      await this.attachCapture(view);
      await this.installInspector(view);
    } catch (error) {
      this.teardownConnection();
      this.state = {
        ...idleState(config, this.inspectionEnabled),
        error: 'No se pudo activar la captura de red en la página.',
      };
      this.emitState();
      this.log.error('Fallo al adjuntar el depurador CDP', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw new BdtError(
        ERROR_CODES.BROWSER_CONNECT_FAILED,
        'No se pudo activar la captura de red en la página.',
      );
    }

    this.state = { ...this.state, connected: true, captureActive: true, loading: true };
    this.emitState();

    this.routes.invalidate();
    void this.routes
      .refresh()
      .then(() => {
        this.syncInspectorRoutes();
      })
      .catch(() => undefined);

    void view.webContents.loadURL(config.frontend.url).catch((error: unknown) => {
      if (this.view !== view) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('No se pudo cargar el frontend', { message });
      this.state = {
        ...this.state,
        loading: false,
        error: 'No se pudo cargar la página del frontend. Comprueba la URL y el puerto.',
      };
      this.emitState();
    });

    return this.getSnapshot();
  }

  private prepareLaunch(
    role: 'frontend' | 'backend',
    launch: BrowserConfig['frontendLaunch'],
  ): LaunchProgram | null {
    if (launch === null) {
      return null;
    }
    const root = this.options.getWorkspaceRoot();
    if (root === null) {
      throw new BdtError(
        ERROR_CODES.WORKSPACE_NONE,
        `Abre la carpeta del proyecto para arrancar el ${role}.`,
      );
    }
    return parseAppLaunch(launch.command, launch.cwd, root, role);
  }

  private async launchBackend(
    config: BrowserConfig,
    program: LaunchProgram,
  ): Promise<NonNullable<BrowserConfig['backendLaunch']>> {
    const base = config.backendLaunch;
    if (base === null) {
      throw new BdtError(ERROR_CODES.INTERNAL, 'No hay comando de backend que lanzar.');
    }
    const wantsInspector = program.kind === 'node';
    let inspectorPort: number | null = null;
    if (wantsInspector) {
      inspectorPort = config.nodeInspectorPort ?? (await findFreeLoopbackPort());
      config.nodeInspectorPort = inspectorPort;
    }
    const launcher = new AppLauncher(this.log);
    this.backendLauncher = launcher;
    const info = await launcher.start(program, {
      label: 'backend',
      port: config.backend.port,
      inspectorPort,
      readyUrl: config.backend.url,
      onUnexpectedExit: (code) => {
        this.onLaunchedExit('backend', launcher, code);
      },
    });
    if (wantsInspector) {
      this.panelRuntime = {
        status: 'connecting',
        port: inspectorPort,
        message: `Backend lanzado por la app (PID ${String(info.pid)}). Conectando al inspector de Node…`,
      };
      this.recordActivity({
        category: 'backend',
        title: 'Backend lanzado por la app',
        detail: `PID ${String(info.pid)} · inspector en 127.0.0.1:${String(info.inspectorPort ?? 0)}`,
      });
    } else {
      this.recordActivity({
        category: 'backend',
        title: 'Backend lanzado por la app',
        detail: `PID ${String(info.pid)} · script npm (sin inspector de Node)`,
      });
    }
    return { ...base, pid: info.pid, inspectorPort };
  }

  private async launchFrontend(
    config: BrowserConfig,
    program: LaunchProgram,
  ): Promise<NonNullable<BrowserConfig['frontendLaunch']>> {
    const base = config.frontendLaunch;
    if (base === null) {
      throw new BdtError(ERROR_CODES.INTERNAL, 'No hay comando de frontend que lanzar.');
    }
    const launcher = new AppLauncher(this.log);
    this.frontendLauncher = launcher;
    const info = await launcher.start(program, {
      label: 'frontend',
      port: config.frontend.port,
      inspectorPort: null,
      readyUrl: config.frontend.url,
      onUnexpectedExit: (code) => {
        this.onLaunchedExit('frontend', launcher, code);
      },
    });
    this.recordActivity({
      category: 'frontend',
      title: 'Frontend lanzado por la app',
      detail: `PID ${String(info.pid)} · ${config.frontend.url}`,
    });
    return { ...base, pid: info.pid };
  }

  private onLaunchedExit(
    role: 'frontend' | 'backend',
    launcher: AppLauncher,
    code: number | null,
  ): void {
    const current = role === 'frontend' ? this.frontendLauncher : this.backendLauncher;
    if (current !== launcher) return;
    const label = role === 'frontend' ? 'El frontend lanzado' : 'El backend lanzado';
    const detail =
      code === null ? 'se detuvo de forma inesperada' : `terminó con código ${String(code)}`;
    this.log.warn(`${label} se detuvo`, { code });
    this.recordActivity({
      category: role,
      tone: 'error',
      title: `${label} se detuvo`,
      detail: `${detail}.`,
    });
    this.state = { ...this.state, error: `${label} ${detail}.` };
    this.emitState();
  }

  disconnect(): BrowserState {
    this.teardownConnection();
    this.state = idleState(null, this.inspectionEnabled);
    this.emitState();
    return { ...this.state };
  }

  reload(): void {
    const view = this.view;
    if (view === null) {
      throw new BdtError(ERROR_CODES.BROWSER_NOT_CONFIGURED, 'No hay una página conectada.');
    }
    this.dismissCard();
    this.state = { ...this.state, error: null };
    this.recordActivity({
      category: 'frontend',
      title: 'Recarga solicitada',
      detail: this.state.currentUrl,
    });
    this.emitState();
    view.webContents.reload();
  }

  clearRequests(): BrowserState {
    if (this.buffer === null) {
      throw new BdtError(ERROR_CODES.BROWSER_NOT_CONFIGURED, 'No hay una página conectada.');
    }
    this.dismissCard();
    this.buffer.clear();
    this.pending.clear();
    this.redirects.clear();
    this.dirty.clear();
    this.state = { ...this.state, requestCount: 0 };
    this.send({ type: 'requests-cleared' });
    this.clearActivity();
    this.flowLedger.clear();
    this.flowInteractions.clear();
    this.runtimeLinks.clear();
    this.runtimeHandlers.clear();
    this.resetAutoResolve();
    this.markFlowDirty();
    this.scheduleAutoResolve();
    this.emitState();
    return { ...this.state };
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = bounds;
    if (this.state.config?.mode === 'embedded') {
      this.applyBounds();
    }
  }

  setInspection(enabled: boolean): BrowserState {
    this.inspectionEnabled = enabled;
    this.state = { ...this.state, inspectionEnabled: enabled };
    this.inspector?.setEnabled(enabled);
    if (!enabled) {
      this.setMapOpen(false);
      this.dismissCard();
    } else {
      this.updatePanel(this.inspectionSession?.card ?? null);
    }
    this.layoutHost();
    this.emitState();
    return { ...this.state };
  }

  private layoutHost(): void {
    if (this.state.config?.mode === 'embedded') {
      this.applyBounds();
    } else {
      this.layoutChrome();
    }
  }

  focusBrowserWindow(): void {
    const window = this.chromeWindow;
    if (window === null || window.isDestroyed()) {
      throw new BdtError(
        ERROR_CODES.BROWSER_NOT_CONFIGURED,
        'La ventana del navegador no está abierta.',
      );
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  handleWorkspaceChanged(): void {
    this.hoverProvenanceCache = null;
    this.runtimeFileCache.clear();
    this.runtimeSourceCache.clear();
    this.symbols.invalidate();
    this.routes.invalidate();
    void this.routes
      .refresh()
      .then(() => {
        this.syncInspectorRoutes();
        this.markFlowDirty();
      })
      .catch(() => undefined);
  }

  isChromeSender(sender: WebContents): boolean {
    const window = this.chromeWindow;
    return window !== null && !window.isDestroyed() && sender === window.webContents;
  }

  isPanelSender(sender: WebContents): boolean {
    return this.panel.isSender(sender);
  }

  isMapSender(sender: WebContents): boolean {
    return this.mapWindow.isSender(sender);
  }

  handleChromeReady(sender: WebContents): void {
    if (!this.isChromeSender(sender)) return;
    this.chromeReady = true;
    this.sendChromeState();
  }

  handlePanelReady(sender: WebContents): void {
    if (this.mapWindow.handleReady(sender)) {
      this.mapWindow.updateMap(this.flowState);
      return;
    }
    if (!this.panel.handleReady(sender)) return;
    this.updatePanel(this.inspectionSession?.card ?? null);
  }

  highlightFlowElement(key: string | null, selector: string): void {
    this.inspector?.highlightRef(key, selector);
  }

  private handleMapWindowClosed(): void {
    if (!this.mapOpen) return;
    this.setMapOpen(false);
  }

  setMapOpen(open: boolean): void {
    if (open === this.mapOpen) {
      if (open) this.mapWindow.focus();
      return;
    }
    if (open) {
      if (!this.state.inspectionEnabled || this.view === null) {
        return;
      }
      this.mapOpen = true;
      this.cancelHover();
      this.flowState = {
        open: true,
        building: true,
        error: null,
        snapshot: this.flowState.snapshot,
      };
      this.mapWindow.open();
      this.mapWindow.updateMap(this.flowState);
      void this.refreshMap(true).finally(() => {
        this.scheduleAutoResolve();
      });
      return;
    }
    this.mapOpen = false;
    this.mapWindow.close();
    this.stopAutoResolve();
    this.flowGeneration += 1;
    this.flowBuilding = false;
    this.flowDirty = false;
    if (this.flowTimer !== null) {
      clearTimeout(this.flowTimer);
      this.flowTimer = null;
    }
    if (this.inventoryTimer !== null) {
      clearTimeout(this.inventoryTimer);
      this.inventoryTimer = null;
    }
    this.flowState = {
      open: false,
      building: false,
      error: null,
      snapshot: this.flowState.snapshot,
    };
    this.updatePanel(this.inspectionSession?.card ?? null);
    this.inspector?.refreshHover();
  }

  private markFlowDirty(): void {
    if (!this.mapOpen) return;
    this.flowDirty = true;
    this.scheduleFlowRefresh();
  }

  private scheduleFlowRefresh(): void {
    if (!this.mapOpen || this.flowTimer !== null) return;
    this.flowTimer = setTimeout(() => {
      this.flowTimer = null;
      void this.refreshMap(false);
    }, FLOW_REFRESH_MS);
  }

  private async refreshMap(refreshRoutes: boolean): Promise<void> {
    if (!this.mapOpen) return;
    if (this.flowBuilding) {
      this.flowDirty = true;
      this.scheduleFlowRefresh();
      return;
    }
    const generation = ++this.flowGeneration;
    this.flowBuilding = true;
    this.flowDirty = false;
    this.flowState = { ...this.flowState, open: true, building: true, error: null };
    this.mapWindow.updateMap(this.flowState);
    try {
      if (refreshRoutes) {
        this.routes.invalidate();
        await Promise.all([
          this.routes.refresh(),
          this.ensureFrontendFramework(),
          this.refreshInventory(false),
        ]);
        this.syncInspectorRoutes();
      }
      if (generation !== this.flowGeneration || !this.mapOpen) return;
      const started = Date.now();
      const snapshot = buildFlowSnapshot({
        traces: this.flowLedger.all(),
        requests: this.buffer?.all() ?? [],
        routes: this.routes.all(),
        databases: this.routes.databases(),
        revision: ++this.flowRevision,
        frontend: this.frontendFramework,
        workspaceOpen: this.options.getWorkspaceRoot() !== null,
        inventory: this.inventory,
        interactions: this.flowInteractions.summariesAll(),
        references: this.flowInteractions.referencesAll(),
        occurrences: this.flowInteractions.occurrenceList(),
        runtimeLinks: this.runtimeLinks.all(),
        runtimeHandlers: this.runtimeHandlers.all(),
      });
      if (generation !== this.flowGeneration || !this.mapOpen) return;
      this.flowState = { open: true, building: false, error: null, snapshot };
      this.mapWindow.updateMap(this.flowState);
      this.log.info('Mapa de flujo construido', {
        ms: Date.now() - started,
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        clicks: snapshot.stats.clicks,
        interactions: snapshot.stats.interactions,
        controls: snapshot.stats.controls,
        requests: snapshot.stats.requests,
      });
    } catch (error) {
      if (generation !== this.flowGeneration || !this.mapOpen) return;
      this.flowState = {
        ...this.flowState,
        open: true,
        building: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.mapWindow.updateMap(this.flowState);
      this.log.warn('No se pudo construir el mapa de flujo', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (generation === this.flowGeneration) {
        this.flowBuilding = false;
        if (this.flowDirty && this.mapOpen) {
          this.flowDirty = false;
          this.scheduleFlowRefresh();
        }
      }
    }
  }

  private resetFlow(): void {
    this.mapOpen = false;
    this.flowGeneration += 1;
    this.flowBuilding = false;
    this.flowDirty = false;
    if (this.flowTimer !== null) {
      clearTimeout(this.flowTimer);
      this.flowTimer = null;
    }
    if (this.inventoryTimer !== null) {
      clearTimeout(this.inventoryTimer);
      this.inventoryTimer = null;
    }
    this.flowLedger.clear();
    this.flowInteractions.clear();
    this.runtimeLinks.clear();
    this.runtimeHandlers.clear();
    this.resetAutoResolve();
    this.inventory = [];
    this.inventoryKey = '';
    this.frontendFramework = null;
    this.frontendFrameworkUrl = null;
    this.frontendDetection = null;
    this.frontendDetectionUrl = null;
    this.flowState = { open: false, building: false, error: null, snapshot: null };
    this.mapWindow.updateMap(this.flowState);
  }

  private scheduleInventoryRefresh(delay = 800): void {
    if (!this.mapOpen || this.inventoryTimer !== null) return;
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = null;
      void this.refreshInventory();
    }, delay);
  }

  private async refreshInventory(schedule = true): Promise<void> {
    const view = this.view;
    if (view === null || view.webContents.isDestroyed()) return;
    if (!this.state.connected || !this.state.inspectionEnabled) return;
    const contents = view.webContents;
    let url: string;
    try {
      url = contents.getURL();
    } catch (error) {
      void error;
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    try {
      const result = await contents.executeJavaScript(INVENTORY_SCRIPT);
      if (this.view?.webContents !== contents) return;
      const controls = parseInventory(result);
      const signature = inventorySignature(controls);
      const changed = signature !== this.inventoryKey;
      this.inventory = controls;
      this.inventoryKey = signature;
      if (changed && schedule) {
        this.markFlowDirty();
        this.scheduleAutoResolve();
      }
    } catch (error) {
      this.log.debug('No se pudo inventariar los controles de la página', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resetAutoResolve(): void {
    this.autoResolved.clear();
    this.autoResolveWanted = false;
    this.stopAutoResolve();
  }

  private stopAutoResolve(): void {
    this.autoResolveGeneration += 1;
    this.autoResolveWanted = false;
    if (this.autoResolveTimer !== null) {
      clearTimeout(this.autoResolveTimer);
      this.autoResolveTimer = null;
    }
  }

  private scheduleAutoResolve(delay = 600): void {
    if (!this.mapOpen || !this.state.connected || !this.state.inspectionEnabled) return;
    if (this.autoResolveRunning) {
      this.autoResolveWanted = true;
      return;
    }
    if (this.autoResolveTimer !== null) return;
    const generation = this.autoResolveGeneration;
    this.autoResolveTimer = setTimeout(() => {
      this.autoResolveTimer = null;
      if (generation !== this.autoResolveGeneration) return;
      void this.runAutoResolve();
    }, delay);
  }

  private async runAutoResolve(): Promise<void> {
    if (this.autoResolveRunning || !this.mapOpen) return;
    const inspector = this.inspector;
    if (inspector === null) return;
    const generation = this.autoResolveGeneration;
    this.autoResolveRunning = true;
    try {
      while (this.mapOpen && generation === this.autoResolveGeneration) {
        const ref = this.nextAutoResolveRef();
        if (ref === null) break;
        this.autoResolved.add(ref.key);
        let resolution: HoverResolution | null = null;
        try {
          resolution = await inspector.resolveRef(ref, true);
        } catch (error) {
          this.log.debug('No se pudo resolver el control indexado', {
            message: error instanceof Error ? error.message : String(error),
            element: ref.selector,
          });
        }
        if (!this.mapOpen || generation !== this.autoResolveGeneration) break;
        if (resolution !== null) {
          this.recordRuntimeResolution(resolution.element, resolution.handler, true);
        }
      }
    } finally {
      this.autoResolveRunning = false;
      if (this.autoResolveWanted && this.mapOpen) {
        this.autoResolveWanted = false;
        this.scheduleAutoResolve(200);
      }
    }
  }

  private nextAutoResolveRef(): PageElementRef | null {
    for (const control of this.inventory) {
      if (this.autoResolved.has(control.key)) continue;
      if (control.kind === 'page' || control.selector === '' || control.selector === 'document') {
        continue;
      }
      return control;
    }
    for (const ref of this.flowInteractions.referencesAll()) {
      if (this.autoResolved.has(ref.key)) continue;
      if (ref.kind === 'page' || ref.selector === '' || ref.selector === 'document') continue;
      return ref;
    }
    return null;
  }

  private handlePageChanged(): void {
    this.inventory = [];
    this.inventoryKey = '';
    this.runtimeHandlers.clear();
    this.resetAutoResolve();
    this.markFlowDirty();
    if (this.mapOpen) this.scheduleInventoryRefresh(0);
  }

  private async ensureFrontendFramework(): Promise<string | null> {
    const contents = this.view?.webContents;
    if (contents === undefined || contents.isDestroyed()) return null;
    let url: string;
    try {
      url = contents.getURL();
    } catch (error) {
      this.log.debug('No se pudo leer la URL para detectar el frontend', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (url === '' || url === 'about:blank') return null;
    if (url === this.frontendFrameworkUrl) return this.frontendFramework;
    if (this.frontendDetection !== null && this.frontendDetectionUrl === url) {
      return this.frontendDetection;
    }
    const detection = this.detectFrontendFramework(contents, url);
    this.frontendDetection = detection;
    this.frontendDetectionUrl = url;
    try {
      return await detection;
    } finally {
      if (this.frontendDetection === detection) {
        this.frontendDetection = null;
        this.frontendDetectionUrl = null;
      }
    }
  }

  private async detectFrontendFramework(
    contents: WebContents,
    url: string,
  ): Promise<string | null> {
    try {
      const result = await Promise.race([
        contents.executeJavaScript(FRONTEND_FRAMEWORK_SCRIPT),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 1500);
        }),
      ]);
      if (this.view?.webContents !== contents) return this.frontendFramework;
      const label = typeof result === 'string' ? result.trim().slice(0, 40) : '';
      this.frontendFramework = label === '' ? null : label;
      this.frontendFrameworkUrl = url;
      this.markFlowDirty();
      return this.frontendFramework;
    } catch (error) {
      if (this.view?.webContents !== contents) return this.frontendFramework;
      this.frontendFramework = null;
      this.frontendFrameworkUrl = url;
      this.log.debug('No se pudo detectar el framework frontend', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  navigateFromChrome(sender: WebContents, rawInput: string): void {
    if (!this.isChromeSender(sender)) return;
    const view = this.view;
    if (view === null) {
      throw new BdtError(ERROR_CODES.BROWSER_NOT_CONFIGURED, 'No hay una página conectada.');
    }
    const trimmed = rawInput.trim();
    if (trimmed === '') {
      throw new BdtError(ERROR_CODES.BROWSER_CONFIG_INVALID, 'Escribe una dirección para navegar.');
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new BdtError(ERROR_CODES.BROWSER_CONFIG_INVALID, 'La dirección no es válida.');
    }
    if (!this.isAllowedNavigation(url.toString())) {
      throw new BdtError(
        ERROR_CODES.BROWSER_CONFIG_INVALID,
        'Solo se puede navegar al frontend o al backend configurados.',
      );
    }
    this.state = { ...this.state, loading: true, error: null };
    this.emitState();
    void view.webContents.loadURL(url.toString()).catch((error: unknown) => {
      if (this.view !== view) return;
      this.log.warn('No se pudo navegar desde la barra de direcciones', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  chromeBack(sender: WebContents): void {
    if (!this.isChromeSender(sender)) return;
    const contents = this.view?.webContents;
    if (contents === undefined || contents.isDestroyed()) return;
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
  }

  chromeForward(sender: WebContents): void {
    if (!this.isChromeSender(sender)) return;
    const contents = this.view?.webContents;
    if (contents === undefined || contents.isDestroyed()) return;
    if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  }

  chromeReload(sender: WebContents): void {
    if (!this.isChromeSender(sender)) return;
    this.reload();
  }

  chromeToggleInspection(sender: WebContents): void {
    if (!this.isChromeSender(sender)) return;
    this.setInspection(!this.state.inspectionEnabled);
  }

  selectPanelRequest(requestId: string): void {
    const session = this.inspectionSession;
    if (session === null) return;
    const request = session.requests.get(requestId);
    if (request === undefined) return;
    session.selectedByUser = true;
    this.selectRequest(session, request);
  }

  selectPanelMode(mode: InspectionMode): void {
    if (!INSPECTION_MODES.includes(mode) || mode === this.inspectionMode) return;
    this.inspectionMode = mode;
    this.cancelHover();
    this.updatePanel(this.inspectionSession?.card ?? null);
    this.inspector?.refreshHover();
  }

  dismissCard(): void {
    this.cancelHover();
    this.cancelInspection();
    this.updatePanel(null);
  }

  private cancelHover(): void {
    this.hoverSequence += 1;
    this.hoverPending = null;
    this.inspector?.hideTooltip();
  }

  private cancelInspection(): void {
    const session = this.inspectionSession;
    this.inspectionSession = null;
    if (session?.timer !== null && session?.timer !== undefined) {
      clearTimeout(session.timer);
    }
  }

  handleWindowClosed(): void {
    this.teardownConnection();
    this.state = idleState(null, this.inspectionEnabled);
    this.window = null;
  }

  dispose(): void {
    this.mapWindow.close();
    this.teardownConnection();
    this.window = null;
  }

  private createChromeWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 900,
      minHeight: 520,
      show: false,
      backgroundColor: '#0e1116',
      title: 'Navegador · Backend DevTools',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.options.chromePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
      },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    window.webContents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    window.once('ready-to-show', () => {
      if (this.chromeWindow === window) {
        window.show();
      }
    });
    window.on('resize', () => {
      if (this.chromeWindow === window) {
        this.layoutChrome();
      }
    });
    window.on('closed', () => {
      if (this.chromeWindow !== window) return;
      this.chromeWindow = null;
      this.chromeReady = false;
      this.teardownConnection();
      this.state = idleState(null, this.inspectionEnabled);
      this.emitState();
    });
    this.chromeWindow = window;
    this.chromeReady = false;
    void window.loadURL(CHROME_URL).catch((error: unknown) => {
      this.log.warn('No se pudo cargar la barra del navegador', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return window;
  }

  private layoutChrome(): void {
    const window = this.chromeWindow;
    if (window === null || window.isDestroyed() || this.view === null) return;
    const content = window.getContentBounds();
    const height = Math.max(0, content.height - CHROME_HEIGHT);
    this.applyHostLayout(0, CHROME_HEIGHT, content.width, height, height > 0);
  }

  private applyHostLayout(
    x: number,
    y: number,
    width: number,
    height: number,
    visible: boolean,
  ): void {
    const view = this.view;
    if (view === null) return;
    const panelView = this.panelView;
    const panelWidth = this.panelWidthFor(width);
    const pageWidth = Math.max(0, width - panelWidth);
    view.setBounds({ x, y, width: pageWidth, height });
    view.setVisible(visible && pageWidth > 0 && height > 0);
    if (panelView === null) return;
    if (panelWidth > 0) {
      panelView.setBounds({
        x: x + pageWidth,
        y,
        width: panelWidth,
        height,
      });
    }
    panelView.setVisible(visible && panelWidth > 0 && height > 0);
  }

  private panelWidthFor(width: number): number {
    if (!this.state.inspectionEnabled || width < MIN_HOST_WIDTH_FOR_PANEL) {
      return 0;
    }
    return Math.min(PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width * 0.36)));
  }

  private hardenView(view: WebContentsView): void {
    const session = view.webContents.session;
    if (!this.sessionHardened) {
      hardenSession(session);
      session.on('will-download', (event) => {
        event.preventDefault();
        this.log.warn('Descarga bloqueada en la página inspeccionada');
      });
      this.sessionHardened = true;
    }
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  private wireView(view: WebContentsView): void {
    const contents = view.webContents;
    const isCurrent = (): boolean => this.view === view;

    contents.on('will-navigate', (event, url) => {
      if (!isCurrent()) return;
      if (!this.isAllowedNavigation(url)) {
        event.preventDefault();
        this.log.warn('Navegación de la página bloqueada', { url: maskUrl(url) });
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!isCurrent()) return;
      if (!this.isAllowedNavigation(url)) {
        event.preventDefault();
        this.log.warn('Redirección de la página bloqueada', { url: maskUrl(url) });
      }
    });
    contents.on('did-start-loading', () => {
      if (!isCurrent()) return;
      this.state = { ...this.state, loading: true };
      this.emitState();
    });
    contents.on('did-stop-loading', () => {
      if (!isCurrent()) return;
      this.state = {
        ...this.state,
        loading: false,
        currentUrl: maskUrl(contents.getURL()),
        captureActive: contents.debugger.isAttached(),
      };
      this.emitState();
    });
    contents.on('did-finish-load', () => {
      if (!isCurrent()) return;
      this.handlePageChanged();
      void this.ensureFrontendFramework();
    });
    contents.on('did-navigate', (_event, url) => {
      if (!isCurrent()) return;
      const masked = maskUrl(url);
      this.state = { ...this.state, currentUrl: masked, error: null };
      this.handlePageChanged();
      this.recordActivity({
        category: 'frontend',
        title: 'Navegación de la página',
        detail: masked,
      });
      this.emitState();
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      if (!isCurrent()) return;
      const masked = maskUrl(url);
      this.state = { ...this.state, currentUrl: masked };
      this.recordActivity({
        category: 'frontend',
        title: 'Navegación interna',
        detail: masked,
      });
      this.emitState();
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!isCurrent()) return;
      const clean = shorten(title, 256);
      this.state = { ...this.state, title: clean };
      const window = this.chromeWindow;
      if (window !== null && !window.isDestroyed()) {
        window.setTitle(
          clean === '' ? 'Navegador · Backend DevTools' : `${clean} · Backend DevTools`,
        );
      }
      this.emitState();
    });
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isCurrent() || !isMainFrame || errorCode === -3) return;
        const target = maskUrl(validatedURL);
        const message = `No se pudo cargar ${shorten(target, 512)} (${shorten(errorDescription, 160)}).`;
        this.state = {
          ...this.state,
          loading: false,
          error: message,
        };
        this.recordActivity({
          category: 'frontend',
          tone: 'error',
          title: 'Fallo al cargar la página',
          detail: message,
        });
        this.emitState();
      },
    );
    contents.on('render-process-gone', (_event, details) => {
      if (!isCurrent()) return;
      this.state = {
        ...this.state,
        loading: false,
        captureActive: false,
        error: `El proceso de la página se detuvo (${details.reason}).`,
      };
      this.recordActivity({
        category: 'frontend',
        tone: 'error',
        title: 'El proceso de la página se detuvo',
        detail: details.reason,
      });
      this.emitState();
    });
  }

  private isAllowedNavigation(rawUrl: string): boolean {
    const config = this.state.config;
    if (config === null) return false;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return url.origin === config.frontend.origin || url.origin === config.backend.origin;
    } catch {
      return false;
    }
  }

  private async attachCapture(view: WebContentsView): Promise<void> {
    const target = view.webContents.debugger;
    target.attach('1.3');
    try {
      await withTimeout(target.sendCommand('Network.enable'), 'Network.enable');
      await withTimeout(target.sendCommand('Debugger.enable'), 'Debugger.enable');
      await target.sendCommand('Debugger.setSkipAllPauses', { skip: true });
      await target.sendCommand('Debugger.setAsyncCallStackDepth', { maxDepth: 2147483647 });
      this.log.debug('Captura CDP activa');
    } catch (error) {
      if (target.isAttached()) target.detach();
      throw error;
    }

    target.on('message', (_event, method, params) => {
      if (this.view !== view) return;
      this.inspector?.handleMessage(method, params);
      this.handleCdpMessage(method, params);
    });
    target.on('detach', (_event, reason) => {
      if (this.view !== view) return;
      this.log.warn('Depurador CDP desadjuntado', { reason });
      this.state = { ...this.state, captureActive: false };
      this.emitState();
    });
  }

  private async installInspector(view: WebContentsView): Promise<void> {
    const inspector = new ClickInspector((signal) => {
      this.onInspectorSignal(signal);
    }, this.log);
    this.inspector = inspector;
    try {
      await inspector.install(view.webContents.debugger);
      inspector.setEnabled(this.state.inspectionEnabled);
    } catch (error) {
      this.inspector = null;
      this.inspectionEnabled = false;
      this.state = { ...this.state, inspectionEnabled: false };
      this.log.warn('La inspección por clic no está disponible', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onInspectorSignal(signal: InspectorSignal): void {
    if (signal.kind === 'escape') {
      this.dismissCard();
      return;
    }
    if (signal.kind === 'hover') {
      this.onHoverSignal(signal);
      return;
    }
    if (signal.kind === 'hover-end') {
      this.cancelHover();
      return;
    }
    if (signal.kind === 'dom-changed') {
      this.scheduleInventoryRefresh();
      return;
    }
    if (signal.kind === 'interaction') {
      if (!this.state.connected || !this.state.inspectionEnabled) return;
      this.flowInteractions.record(signal.ref, signal.event, signal.at);
      this.markFlowDirty();
      return;
    }
    if (this.state.connected && this.state.inspectionEnabled && signal.ref !== null) {
      this.flowInteractions.record(signal.ref, signal.kind, signal.at, signal.submitter);
      this.markFlowDirty();
    }
    const element = signal.element;
    const label = element.text === null ? '' : ` «${shorten(element.text, 80)}»`;
    this.recordActivity({
      category: 'frontend',
      title:
        signal.kind === 'submit'
          ? `Envío de formulario ${element.tag}${label}`
          : `Clic en ${element.tag}${label}`,
      detail: describeElement(element),
    });
    if (!this.state.connected || !this.state.inspectionEnabled) return;
    void this.openInspection(signal);
  }

  private onHoverSignal(signal: InspectorHoverSignal): void {
    if (!this.state.connected || !this.state.inspectionEnabled) return;
    this.hoverPending = signal;
    if (this.hoverResolving) return;
    void this.drainHoverSignals();
  }

  private async drainHoverSignals(): Promise<void> {
    this.hoverResolving = true;
    try {
      while (this.hoverPending !== null) {
        const signal = this.hoverPending;
        this.hoverPending = null;
        await this.inspectHover(signal);
      }
    } finally {
      this.hoverResolving = false;
    }
  }

  private async openInspection(signal: InspectorClickSignal): Promise<void> {
    if (this.hostWindow() === null) return;
    this.cancelInspection();

    const sequence = ++this.inspectionSequence;
    const now = Date.now();
    const card: InspectionCard = {
      id: `inspection-${String(now)}-${String(sequence)}`,
      status: 'resolving',
      createdAt: now,
      element: signal.element,
      handler: null,
      requests: [],
      selectedRequestId: null,
      endpoint: null,
      backend: null,
      queries: [],
      execution: null,
      evidence: [],
      level: 'N0',
      note: null,
    };
    const session: InspectionSession = {
      id: card.id,
      clickedAt: now,
      handlerName: null,
      card,
      requests: new Map(),
      selectedByUser: false,
      executions: this.runtime?.recentSince(now - INSPECTION_LEEWAY_MS) ?? [],
      sqlObservations: this.runtime?.recentSqlSince(now - INSPECTION_LEEWAY_MS) ?? [],
      timer: null,
      routeLookupPending: false,
    };
    this.inspectionSession = session;
    this.seedBackgroundRequests(session);
    this.updatePanel(card);

    session.timer = setTimeout(() => {
      this.finalizeInspection(session);
    }, INSPECTION_WINDOW_MS);

    let handler: InspectionHandler | null = null;
    try {
      handler = (await this.inspector?.resolveHandler(signal)) ?? null;
    } catch (error) {
      this.log.debug('No se pudo resolver el manejador del clic', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.inspectionSession !== session) return;
    if (handler !== null) {
      card.handler = handler;
      session.handlerName = handler.name;
      for (const item of card.requests) {
        item.correlation =
          item.initiatorFunction !== null && item.initiatorFunction === handler.name
            ? 'direct'
            : 'heuristic';
      }
      addEvidence(card, 'RUNTIME');
      if (card.status !== 'done') {
        card.status = 'listening';
      }
      this.autoSelect(session);
    }
    this.tryAttachExecution(session);
    this.updatePanel(card);
  }

  private finalizeInspection(session: InspectionSession): void {
    session.timer = null;
    if (this.inspectionSession !== session) return;
    const card = session.card;
    card.status = 'done';
    this.autoSelect(session);
    this.tryAttachExecution(session);
    this.updatePanel(card);
  }

  private async inspectHover(signal: InspectorHoverSignal): Promise<void> {
    const inspector = this.inspector;
    if (inspector === null) return;
    const generation = this.hoverSequence;
    const mode = this.inspectionMode;
    const withHandler = mode !== 'html';
    let resolution: HoverResolution | null = null;
    try {
      resolution = await inspector.resolveHover(signal, withHandler);
    } catch (error) {
      this.log.debug('No se pudo inspeccionar el elemento bajo el mouse', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (generation !== this.hoverSequence) return;
    if (resolution === null) {
      inspector.showTooltip(this.fallbackHoverTip(signal, mode));
      return;
    }
    let tip: HoverTipData;
    let resolved = false;
    try {
      tip = this.buildHoverTip(mode, signal, resolution);
      resolved = true;
    } catch (error) {
      this.log.error('No se pudo construir la información del modo de inspección', {
        mode,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      });
      tip = this.fallbackHoverTip(signal, mode);
      tip.footer = 'No se pudo resolver la procedencia; revisa el registro.';
    }
    inspector.showTooltip(tip);
    if (resolved && mode !== 'html') {
      this.recordRuntimeResolution(resolution.element, resolution.handler, false);
    }
  }

  private recordRuntimeResolution(
    element: HoverElementInfo,
    handler: InspectionHandler | null,
    auto: boolean,
  ): void {
    const ref = element.ref;
    if (ref === null) return;
    try {
      if (!this.state.connected || !this.state.inspectionEnabled) return;
      const handlerChanged =
        handler === null
          ? false
          : this.runtimeHandlers.record({
              element: ref,
              event: handler.event,
              name: handler.name,
              url: handler.url,
              line: handler.line,
              column: handler.column,
              source: handler.source,
              note: handler.note,
              at: Date.now(),
            });
      const provenance = this.hoverProvenance(element);
      const runtime = provenance.runtime;
      const request = provenance.request;
      const route = provenance.route;
      if (runtime === null && request === null && route === null) {
        if (handlerChanged) {
          this.markFlowDirty();
          this.log.debug('Manejador resuelto registrado para el mapa', {
            element: ref.text === null ? ref.tag : ref.text.slice(0, 60),
            handler: handler?.name ?? null,
            auto,
          });
        }
        return;
      }
      const requestInfo = runtime?.requestInfo ?? null;
      const identity = (runtime !== null && runtime.request !== null) || requestInfo !== null;
      const render = runtime?.render ?? element.runtime?.renderSources[0] ?? null;
      const entry = runtime?.data ?? runtime?.entries[0] ?? null;
      const match = provenance.matches[0] ?? null;
      const basis: RuntimeLinkBasis = identity
        ? 'identity'
        : request !== null || match !== null
          ? 'content'
          : 'render';
      const method = request?.method ?? requestInfo?.method ?? route?.method ?? null;
      const requestPath = request?.path ?? requestInfo?.path ?? route?.path ?? null;
      const changed = this.runtimeLinks.record({
        element: ref,
        requestId: request?.id ?? null,
        method,
        path: requestPath,
        route:
          route === null
            ? null
            : {
                method: route.method,
                path: route.path,
                file: route.file,
                routeLine: route.routeLine,
              },
        basis,
        component: render?.component ?? element.runtime?.functions[0]?.name ?? null,
        file: runtime?.renderFile ?? render?.file ?? runtime?.renderSymbol?.file ?? null,
        line: render?.line ?? runtime?.renderSymbol?.line ?? null,
        code: render?.code ?? null,
        dataPath: entry?.path ?? match?.jsonPath ?? null,
        value: entry?.value ?? match?.value ?? null,
        at: Date.now(),
      });
      if (!changed && !handlerChanged) return;
      this.markFlowDirty();
      this.log.debug('Cadena de procedencia registrada para el mapa', {
        element: ref.text === null ? ref.tag : ref.text.slice(0, 60),
        auto,
        basis,
        request: method === null ? null : `${method} ${requestPath ?? ''}`.trim(),
        component: render?.component ?? null,
        handler: handler?.name ?? null,
      });
    } catch (error) {
      this.log.debug('No se pudo registrar la procedencia del hover para el mapa', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildHoverTip(
    mode: InspectionMode,
    signal: InspectorHoverSignal,
    resolution: HoverResolution,
  ): HoverTipData {
    const element = resolution.element;
    const selector = formatHoverSelector(element);
    const rect = element.rect.width > 0 || element.rect.height > 0 ? element.rect : signal.rect;
    const base: Pick<HoverTipData, 'mode' | 'modeLabel' | 'x' | 'y' | 'rect'> = {
      mode,
      modeLabel: INSPECTION_MODE_LABEL[mode],
      x: signal.x,
      y: signal.y,
      rect,
    };

    switch (mode) {
      case 'html':
        return this.buildHtmlHoverTip(base, element, selector);
      case 'frontend':
        return this.buildFrontendHoverTip(
          base,
          resolution,
          selector,
          this.hoverProvenance(element),
        );
      case 'backend':
        return this.buildBackendHoverTip(base, resolution, selector, this.hoverProvenance(element));
      case 'request':
        return this.buildRequestHoverTip(base, resolution, selector, this.hoverProvenance(element));
      case 'database':
        return this.buildDatabaseHoverTip(
          base,
          resolution,
          selector,
          this.hoverProvenance(element),
        );
      default:
        return this.fallbackHoverTip(signal, mode);
    }
  }

  private hoverProvenance(element: HoverElementInfo): HoverTextProvenance {
    const query = element.text;
    const count = this.buffer?.count ?? 0;
    const runtime = this.runtimeLink(element);
    const runtimeHasData = runtime !== null && runtime.entries.length > 0;
    const dataValues = runtimeHasData ? [] : element.dataValues.map((entry) => entry.value);
    const dataHints = runtimeHasData
      ? []
      : element.dataValues.map((entry) => ({
          value: entry.value,
          path: entry.path,
        }));
    const runtimeSignature =
      element.runtime === null
        ? ''
        : [
            element.runtime.render === null
              ? ''
              : `${element.runtime.render.file ?? ''}:${String(element.runtime.render.line ?? '')}`,
            element.runtime.data
              .map(
                (entry) =>
                  `${entry.requestKey}|${entry.path}|${entry.jsonPath}|${entry.value}|${entry.kind}`,
              )
              .join('\u0002'),
          ].join('\u0003');
    const key = `${query ?? ''}\u0000${String(count)}\u0000${runtimeSignature}\u0000${dataHints
      .map((hint) => `${hint.path}\u0002${hint.value}`)
      .join('\u0001')}`;
    const cached = this.hoverProvenanceCache;
    if (cached !== null && cached.key === key && Date.now() - cached.at < 1200) {
      return cached.value;
    }

    const matches = runtimeHasData
      ? []
      : query === null && dataValues.length === 0
        ? []
        : findJsonTextMatches(this.buffer?.all() ?? [], query ?? '', 5, dataValues, dataHints);
    const first = matches[0];
    const matchRequest = first === undefined ? null : (this.buffer?.get(first.requestId) ?? null);
    const request = runtime?.request ?? matchRequest;
    const route =
      runtime?.route ??
      (request === null ? null : this.routes.match(request.method, stripQuery(request.path)));
    const value: HoverTextProvenance = {
      query,
      matches,
      request,
      route,
      database: runtime?.database ?? pickDatabaseHint(this.routes.databases(), route?.file ?? null),
      runtime,
    };
    this.log.debug('Procedencia del texto bajo el mouse', {
      text: query === null ? null : query.slice(0, 80),
      runtimeRender: runtime === null || runtime.render === null ? null : runtime.render.component,
      runtimeData: runtime === null ? 0 : runtime.entries.length,
      dataValues: dataValues.length,
      matches: matches.length,
      basis: first?.basis ?? null,
      request: request === null ? null : `${request.method} ${request.path}`,
      route: route === null ? null : `${route.file}:${String(route.line)}`,
      database: value.database === null ? null : value.database.database,
    });
    this.hoverProvenanceCache = { key, at: Date.now(), value };
    return value;
  }

  private runtimeLink(element: HoverElementInfo): RuntimeLink | null {
    const runtime = element.runtime;
    if (runtime === null) return null;
    if (runtime.data.length === 0 && runtime.render === null && runtime.functions.length === 0) {
      return null;
    }
    const source = this.runtimeRenderContext(runtime.render, runtime.renderSources);
    const symbolBody = this.runtimeSymbolBody(runtime);
    const renderSymbol = this.runtimeRenderSymbol(runtime);
    const renderText = normalizedSourceText(source.snippet);
    const symbolText = normalizedSourceText(symbolBody);
    const scored = runtime.data
      .map((entry) => ({
        entry,
        score: this.runtimeDataScore(entry, element.text, renderText, symbolText),
      }))
      .sort((left, right) => right.score - left.score);
    const ranked = scored.map((item) => item.entry);
    const tied =
      scored.length > 1 &&
      scored[0] !== undefined &&
      scored[1] !== undefined &&
      scored[0].score === scored[1].score;
    const data = ranked[0] ?? null;
    const requestInfo =
      data === null
        ? null
        : (runtime.requests.find((entry) => entry.key === data.requestKey) ?? null);
    const request = requestInfo === null ? null : this.findRuntimeRequest(requestInfo);
    const method = request === null ? (requestInfo?.method ?? null) : request.method;
    const requestPath = request === null ? (requestInfo?.path ?? null) : stripQuery(request.path);
    const route =
      method === null || requestPath === null
        ? null
        : this.routes.match(method, stripQuery(requestPath));
    return {
      framework: runtime.framework,
      render: runtime.render,
      renderFile: source.file,
      renderLine: source.line,
      renderSymbol,
      functions: runtime.functions,
      data: data === null || data.kind === 'object' ? null : data,
      entries: ranked,
      requestInfo,
      request,
      route,
      database: pickDatabaseHint(this.routes.databases(), route?.file ?? null),
      note:
        runtime.note ??
        (tied
          ? 'Varios campos del componente coinciden con el texto; se muestran todas las alternativas.'
          : null),
    };
  }

  private runtimeSymbolBody(runtime: RuntimeProvenance): string | null {
    if (runtime.framework !== 'react') return null;
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const entry of runtime.functions) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const symbol = this.symbols.find(entry.name);
      if (symbol !== null) parts.push(symbol.body);
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  private runtimeRenderSymbol(runtime: RuntimeProvenance): ComponentSymbol | null {
    if (runtime.framework !== 'react') return null;
    const primary = runtime.render?.component ?? runtime.functions[0]?.name ?? null;
    if (primary === null) return null;
    return this.symbols.find(primary);
  }

  private runtimeDataScore(
    entry: RuntimeDataInfo,
    text: string | null,
    renderSource: string,
    symbolSource: string,
  ): number {
    let score = entry.kind === 'number' ? 6 : entry.kind === 'text' ? 5 : 0;
    const leaf = /([A-Za-z_$][\w$]*)\s*\]?\s*$/.exec(entry.path)?.[1] ?? '';
    const normalizedLeaf = leaf.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (normalizedLeaf.length >= 3) {
      if (renderSource.includes(normalizedLeaf)) score += 1000;
      if (symbolSource.includes(normalizedLeaf)) score += 100;
    }
    if (text === null || text === '') return score;
    if (entry.value !== '' && text.toLowerCase().includes(entry.value.toLowerCase())) score += 4;
    const normalizedText = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (normalizedLeaf.length >= 3 && normalizedText.includes(normalizedLeaf)) score += 3;
    return score;
  }

  private runtimeRenderContext(
    render: RuntimeRenderInfo | null,
    sources: RuntimeRenderInfo[],
  ): { file: string | null; line: string | null; snippet: string | null } {
    const primary = this.readRuntimeSource(render);
    if (sources.length === 0) return primary;
    const snippets: string[] = [];
    const seen = new Set<string>();
    if (primary.snippet !== null) {
      snippets.push(primary.snippet);
      seen.add(`${render?.file ?? ''}\u0000${String(render?.line ?? '')}`);
    }
    for (const source of sources) {
      const key = `${source.file ?? ''}\u0000${String(source.line ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const extra = this.readRuntimeSource(source);
      if (extra.snippet !== null) snippets.push(extra.snippet);
    }
    return {
      file: primary.file,
      line: primary.line,
      snippet: snippets.length > 0 ? snippets.join('\n') : null,
    };
  }

  private readRuntimeSource(render: RuntimeRenderInfo | null): {
    file: string | null;
    line: string | null;
    snippet: string | null;
  } {
    if (render === null) return { file: null, line: null, snippet: null };
    const code = render.code;
    if (render.file === null) {
      return { file: null, line: code, snippet: code };
    }
    const target = Math.max(1, render.line ?? 1);
    const key = `${render.file}\u0000${String(target)}\u0000${code ?? ''}`;
    const cached = this.runtimeSourceCache.get(key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 5000) {
      return cached.value;
    }
    let file = this.resolveRuntimeFile(render.file);
    let line = code;
    let snippet = code;
    const root = this.options.getWorkspaceRoot();
    if (file !== null && root !== null) {
      try {
        const block = readCodeBlock(root, file, Math.max(1, target - 1), target + 2, {
          maxLines: 4,
        });
        const parts = block.lines.map((entry) => entry.text);
        const targetIndex = block.lines.findIndex((entry) => entry.line === target);
        const targetLine =
          targetIndex === -1
            ? null
            : (block.lines[targetIndex]?.text.replace(/\s+/g, ' ').trim() ?? null);
        if (code !== null) {
          if (
            targetLine !== null &&
            normalizedSourceText(targetLine) === normalizedSourceText(code)
          ) {
            line = code;
            if (parts.length > 0) snippet = parts.join('\n');
          } else {
            // The workspace file is a different copy than the module that runs.
            file = null;
            line = code;
            snippet = code;
          }
        } else {
          line = targetLine;
          if (parts.length > 0) snippet = parts.join('\n');
        }
      } catch {
        if (code !== null) {
          file = null;
          line = code;
          snippet = code;
        } else {
          file = null;
          line = null;
          snippet = null;
        }
      }
    }
    const value = { file, line, snippet };
    this.runtimeSourceCache.set(key, { at: now, value });
    if (this.runtimeSourceCache.size > 64) {
      const oldest = this.runtimeSourceCache.keys().next().value;
      if (oldest !== undefined) this.runtimeSourceCache.delete(oldest);
    }
    return value;
  }

  private resolveRuntimeFile(url: string): string | null {
    const cached = this.runtimeFileCache.get(url);
    if (cached !== undefined) return cached;
    const root = this.options.getWorkspaceRoot();
    const result = root === null ? null : this.probeRuntimeFile(url, root);
    this.runtimeFileCache.set(url, result);
    return result;
  }

  private probeRuntimeFile(url: string, root: string): string | null {
    if (url.startsWith('file:')) {
      const direct = this.relativeFramePath(url);
      if (direct !== null) return direct;
    }
    let withoutQuery = url;
    const scheme = /^[a-z][a-z0-9+.-]*:\/\/+/i.exec(withoutQuery);
    if (scheme !== null && !/^https?:/i.test(withoutQuery)) {
      withoutQuery = withoutQuery.slice(scheme[0].length);
    }
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = withoutQuery.split(/[?#]/)[0] ?? withoutQuery;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    decoded = decoded.replace(/\\/g, '/');
    const fsMarker = decoded.indexOf('/@fs/');
    if (fsMarker !== -1) {
      let absolute = decoded.slice(fsMarker + 4);
      if (/^\/[a-zA-Z]:\//.test(absolute)) absolute = absolute.slice(1);
      const relative = this.relativeFilePath(absolute);
      if (relative !== null) return relative;
      decoded = absolute;
    }
    const segments = decoded.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) return null;
    if (segments.some((segment) => segment === '..')) return null;
    let scope: RootScope;
    try {
      scope = createRootScope(root);
    } catch {
      return null;
    }
    const prefixes = runtimeSourcePrefixes();
    for (let start = 0; start < segments.length; start += 1) {
      const suffix = segments.slice(start).join('/');
      for (const prefix of prefixes) {
        const candidate = `${prefix}${suffix}`;
        try {
          scope.resolve(candidate);
          return candidate;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private findRuntimeRequest(info: RuntimeRequestInfo): CapturedRequest | null {
    const requests = this.buffer?.all();
    if (requests === undefined) return null;
    const method = info.method.toUpperCase();
    const path = stripQuery(info.path);
    let best: CapturedRequest | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const request of requests) {
      if (request.method.toUpperCase() !== method) continue;
      if (stripQuery(request.path) !== path) continue;
      const delta = Math.abs(request.wallStartedAt - info.startedAt);
      if (delta < bestDelta) {
        best = request;
        bestDelta = delta;
      }
    }
    return best;
  }

  private hoverBackendSource(route: StaticRoute): BackendSource {
    const key = `${route.file}\u0000${String(route.line)}\u0000${String(route.endLine)}`;
    const cached = this.hoverBackendCodeCache.get(key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 5000) {
      return cached.value;
    }
    const value = this.readBackendSource(route);
    this.hoverBackendCodeCache.set(key, { at: now, value });
    if (this.hoverBackendCodeCache.size > 24) {
      const oldest = this.hoverBackendCodeCache.keys().next().value;
      if (oldest !== undefined) this.hoverBackendCodeCache.delete(oldest);
    }
    return value;
  }

  private buildHtmlHoverTip(
    base: Pick<HoverTipData, 'mode' | 'modeLabel' | 'x' | 'y' | 'rect'>,
    element: HoverElementInfo,
    selector: string,
  ): HoverTipData {
    const rows: HoverTipRow[] = [];
    const layout = hoverStyleGroup(element, ['display', 'position', 'z-index', 'box-sizing']);
    if (layout !== null) rows.push({ label: 'Layout', value: layout });
    const boxModel = hoverStyleGroup(element, ['width', 'height', 'margin', 'padding']);
    if (boxModel !== null) rows.push({ label: 'Caja', value: boxModel });
    const colors = hoverStyleGroup(element, ['color', 'background-color']);
    if (colors !== null) rows.push({ label: 'Color', value: colors });
    const font = hoverStyleGroup(element, [
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'text-align',
    ]);
    if (font !== null) rows.push({ label: 'Fuente', value: font });
    const flow = hoverStyleGroup(element, [
      'flex-direction',
      'gap',
      'grid-template-columns',
      'overflow-x',
      'overflow-y',
      'opacity',
    ]);
    if (flow !== null) rows.push({ label: 'Flujo', value: flow });
    const attributes = element.attributes
      .map((attribute) => `${attribute.name}="${attribute.value}"`)
      .join(' ');
    if (attributes !== '') rows.push({ label: 'Atributos', value: attributes });
    if (element.text !== null) rows.push({ label: 'Texto', value: element.text });

    return {
      ...base,
      title: selector,
      subtitle: this.hoverSubtitle(element),
      rows: this.prepareHoverRows(rows),
      code: null,
      footer: 'Clic: tarjeta completa · Esc: cerrar',
    };
  }

  private buildFrontendHoverTip(
    base: Pick<HoverTipData, 'mode' | 'modeLabel' | 'x' | 'y' | 'rect'>,
    resolution: HoverResolution,
    selector: string,
    provenance: HoverTextProvenance,
  ): HoverTipData {
    const element = resolution.element;
    const handler = resolution.handler;
    const rows: HoverTipRow[] = [];
    const request = provenance.request;
    const match = provenance.matches[0] ?? null;
    const link = provenance.runtime;
    const runtimeData = link !== null && link.entries.length > 0;

    if (element.text !== null) {
      rows.push({ label: 'Texto', value: element.text, tone: 'normal' });
    }
    if (element.form !== null) {
      rows.push({
        label: 'Formulario',
        value: `${element.form.method} ${element.form.action === '' ? '(sin action)' : element.form.action}`,
        tone: 'normal',
      });
    }
    if (element.link !== null) {
      rows.push({ label: 'Enlace', value: element.link, tone: 'normal' });
    }
    if (link !== null) {
      rows.push(...this.runtimeChainRows(link));
    }
    const staticCandidate =
      request === null && match === null && (link === null || link.requestInfo === null)
        ? this.staticRequests(resolution)[0]
        : undefined;
    if (staticCandidate !== undefined) {
      rows.push({
        label: 'Petición',
        value: `${staticCandidate.method} ${staticCandidate.path}`,
        tone: 'normal',
      });
      const matchedRoute = this.routes.match(
        staticCandidate.method,
        stripQuery(staticCandidate.path),
      );
      rows.push({
        label: 'Ruta',
        value:
          matchedRoute === null
            ? 'sin ruta estática en el proyecto'
            : `${matchedRoute.handlerName ?? 'sin resolver'} · ${matchedRoute.file}:${String(
                matchedRoute.line,
              )}`,
        tone: matchedRoute === null ? 'dim' : 'ok',
      });
    }
    const frames =
      link === null || link.requestInfo === null ? (request?.initiator?.frames ?? []) : [];
    if (frames.length > 0) {
      const lines = frames.map(
        (frame) =>
          `${frame.functionName ?? 'anónima'} · ${shortFunctionSource(frame.url)}:${String(
            frame.line,
          )}`,
      );
      rows.push({ label: 'Funciones', value: lines.join('\n'), tone: 'ok' });
    }
    for (const prop of element.textProps) {
      rows.push({
        label: prop.framework === 'react' ? 'React' : 'Vue',
        value: `${prop.component} · ${prop.key} = "${prop.value}"${prop.partial ? ' (parcial)' : ''}`,
        tone: 'ok',
      });
    }
    const framework =
      element.reactComponents.length > 0
        ? 'React'
        : element.vueComponents.length > 0
          ? 'Vue'
          : null;
    const components = framework === 'React' ? element.reactComponents : element.vueComponents;
    if (framework !== null && components.length > 0) {
      rows.push({ label: 'Cadena', value: components.join(' › '), tone: 'dim' });
    }
    if (match !== null) {
      rows.push({
        label: 'JSON',
        value: `${match.jsonPath} · ${match.origin === 'response' ? 'respuesta' : 'enviado'}${jsonMatchNote(
          match,
        )}`,
        tone: 'ok',
      });
      rows.push(...this.provenanceDataRows(element, match));
      if (request !== null) {
        rows.push({
          label: 'Petición',
          value: `${request.method} ${request.path} · ${observedStatusLabel(request)}`,
          tone: 'dim',
        });
      }
      if (provenance.route !== null) {
        rows.push({
          label: 'Ruta',
          value: `${provenance.route.handlerName ?? 'sin resolver'} · ${provenance.route.file}:${String(
            provenance.route.line,
          )}`,
          tone: 'ok',
        });
        rows.push(...this.sqlRows(provenance.route));
        rows.push(this.databaseRow(provenance.database));
      }
    } else if (!runtimeData && (provenance.query !== null || element.dataValues.length > 0)) {
      rows.push({
        label: 'JSON',
        value:
          element.dataValues.length > 0
            ? 'sin cuerpo capturado que contenga los datos del componente'
            : 'sin coincidencia en cuerpos capturados (máscara, recorte o no JSON)',
        tone: 'dim',
      });
      for (const dataValue of element.dataValues) {
        rows.push({
          label: 'Dato',
          value: `${dataValue.component} · ${dataValue.path} = "${dataValue.value}"`,
          tone: 'dim',
        });
      }
    }
    if (handler !== null) {
      rows.push({
        label: 'Handler',
        value: `${handler.event} → ${handler.name ?? 'función anónima'} · ${
          HANDLER_SOURCE_LABEL[handler.source]
        }`,
        tone: 'ok',
      });
      const location =
        handler.url !== null
          ? `${handler.url}:${String(handler.line ?? 0)}${
              handler.column !== null ? `:${String(handler.column)}` : ''
            }`
          : (handler.note ?? 'sin ubicación en el código');
      rows.push({ label: 'Ubicación', value: location });
    }
    if (resolution.listeners.length > 0) {
      rows.push({ label: 'Eventos', value: resolution.listeners.join(', ') });
    }
    rows.push({ label: 'Elemento', value: selector });

    return {
      ...base,
      title:
        element.text !== null && element.text !== ''
          ? `"${element.text}"`
          : handler !== null
            ? `${handler.event} → ${handler.name ?? 'función anónima'}`
            : staticCandidate !== undefined
              ? `${staticCandidate.method} ${staticCandidate.path}`
              : selector,
      subtitle: `${this.hoverSubtitle(element)}${match !== null || link !== null ? ' · OBSERVADO' : ''}`,
      rows: this.prepareHoverRows(rows),
      code: handler === null ? null : toHoverCode(handler.code),
      footer:
        link !== null && link.requestInfo !== null
          ? 'Cadena verificada en ejecución: función de render → dato → petición → backend.'
          : link !== null
            ? 'Render verificado en ejecución; sin petición enlazada por identidad.'
            : request !== null
              ? match?.basis === 'data'
                ? 'Petición correlacionada con los datos crudos que recibe el componente.'
                : match?.approximate
                  ? 'Coincidencia aproximada por valor: el texto formateado no aparece literal en el JSON; la cadena muestra la petición que contiene ese dato.'
                  : 'Funciones = pila que originó la petición que devolvió el texto.'
              : (handler?.note ?? 'Clic: tarjeta completa · Esc: cerrar'),
    };
  }

  private buildBackendHoverTip(
    base: Pick<HoverTipData, 'mode' | 'modeLabel' | 'x' | 'y' | 'rect'>,
    resolution: HoverResolution,
    selector: string,
    provenance: HoverTextProvenance,
  ): HoverTipData {
    const rows: HoverTipRow[] = [];
    const request = provenance.request;
    const route = provenance.route;
    const match = provenance.matches[0] ?? null;
    const link = provenance.runtime;

    if (link !== null && link.requestInfo !== null) {
      rows.push(...this.runtimeChainRows(link));
      const source = link.route === null ? null : this.hoverBackendSource(link.route);
      if (source?.note !== null && source?.note !== undefined) {
        rows.push({ label: 'Código', value: source.note, tone: 'warn' });
      }
      const title =
        link.route?.handlerName ?? `${link.requestInfo.method} ${link.requestInfo.path}`;
      return {
        ...base,
        title,
        subtitle: `${selector} · OBSERVADO`,
        rows: this.prepareHoverRows(rows),
        code: source === null ? null : toHoverCode(source.code),
        footer: 'Función frontend y petición enlazadas por identidad en ejecución.',
      };
    }

    if (match !== null) {
      if (provenance.query !== null) {
        rows.push({ label: 'Texto', value: provenance.query, tone: 'normal' });
      }
      rows.push({
        label: 'JSON',
        value: `${match.jsonPath} · ${match.origin === 'response' ? 'respuesta' : 'enviado'}${jsonMatchNote(
          match,
        )}`,
        tone: 'ok',
      });
      if (request !== null) {
        rows.push({
          label: 'Petición',
          value: `${request.method} ${request.path}`,
          tone: 'normal',
        });
        rows.push({ label: 'Observada', value: observedStatusLabel(request), tone: 'ok' });
      }
      if (route !== null) {
        rows.push({
          label: 'Backend',
          value: `${route.handlerName ?? 'sin resolver'} · ${route.file}:${String(route.line)}`,
          tone: 'ok',
        });
        rows.push({
          label: 'Líneas',
          value: `${String(route.line)}–${String(route.endLine)} · ${route.framework}`,
          tone: 'dim',
        });
        if (route.note !== null) rows.push({ label: 'Nota', value: route.note, tone: 'warn' });
      } else {
        rows.push({
          label: 'Backend',
          value: 'sin ruta estática para la petición observada',
          tone: 'dim',
        });
      }
      const source = route === null ? null : this.hoverBackendSource(route);
      if (source?.note !== null && source?.note !== undefined) {
        rows.push({ label: 'Código', value: source.note, tone: 'warn' });
      }
      const title =
        route?.handlerName ?? (request !== null ? `${request.method} ${request.path}` : 'Backend');
      return {
        ...base,
        title,
        subtitle: `${selector} · OBSERVADO`,
        rows: this.prepareHoverRows(rows),
        code: source === null ? null : toHoverCode(source.code),
        footer:
          match.basis === 'data'
            ? 'Ruta de la petición cuyos datos coinciden con el componente.'
            : 'Ruta de la petición que devolvió el texto.',
      };
    }

    const candidates = this.staticRequests(resolution);
    let title = 'Sin petición detectada';
    if (candidates.length === 0) {
      rows.push({
        label: 'Origen',
        value: 'sin petición observada ni fetch/axios/XHR/form/href estático',
        tone: 'dim',
      });
    }
    candidates.forEach((candidate, index) => {
      const matchedRoute = this.routes.match(candidate.method, stripQuery(candidate.path));
      if (index === 0) title = `${candidate.method} ${candidate.path}`;
      rows.push({
        label: index === 0 ? 'Petición' : `Opción ${String(index + 1)}`,
        value: `${candidate.method} ${candidate.path}`,
        tone: index === 0 ? 'normal' : 'dim',
      });
      if (matchedRoute !== null) {
        rows.push({
          label: 'Ruta',
          value: `${matchedRoute.handlerName ?? 'sin resolver'} · ${matchedRoute.file}:${String(
            matchedRoute.line,
          )}`,
          tone: 'ok',
        });
        rows.push({
          label: 'Framework',
          value: `${matchedRoute.framework} · líneas ${String(matchedRoute.line)}–${String(
            matchedRoute.endLine,
          )}`,
          tone: 'dim',
        });
        if (matchedRoute.note !== null) {
          rows.push({ label: 'Nota', value: matchedRoute.note, tone: 'warn' });
        }
      } else {
        rows.push({ label: 'Ruta', value: 'sin ruta estática en el proyecto', tone: 'dim' });
      }
    });

    return {
      ...base,
      title,
      subtitle: `${selector} · ESTÁTICO`,
      rows: this.prepareHoverRows(rows),
      code: null,
      footer: 'Datos estáticos del código · no ejecutado',
    };
  }

  private buildRequestHoverTip(
    base: Pick<HoverTipData, 'mode' | 'modeLabel' | 'x' | 'y' | 'rect'>,
    resolution: HoverResolution,
    selector: string,
    provenance: HoverTextProvenance,
  ): HoverTipData {
    const rows: HoverTipRow[] = [];
    const request = provenance.request;
    const route = provenance.route;
    const match = provenance.matches[0] ?? null;
    const link = provenance.runtime;

    if (link !== null && link.entries.length > 0) {
      rows.push(...this.runtimeChainRows(link));
      let code: HoverTipCode | null = null;
      if (link.request !== null && provenance.query !== null) {
        const local = findJsonTextMatches([link.request], provenance.query, 1, [], [])[0];
        if (local !== undefined) code = jsonParentCode(local, link.request);
      }
      const title =
        link.requestInfo !== null
          ? `${link.requestInfo.method} ${link.requestInfo.path}`
          : link.data !== null
            ? link.data.jsonPath
            : selector;
      return {
        ...base,
        title,
        subtitle: `${selector} · OBSERVADO`,
        rows: this.prepareHoverRows(rows),
        code,
        footer:
          link.data === null
            ? 'Respuesta enlazada por identidad; el texto no coincide con un campo del JSON.'
            : 'Camino exacto del dato en la respuesta enlazada por identidad en ejecución.',
      };
    }

    if (match !== null) {
      if (provenance.query !== null) {
        rows.push({ label: 'Texto', value: provenance.query, tone: 'normal' });
      }
      rows.push({
        label: 'JSON',
        value: `${match.jsonPath} · ${match.origin === 'response' ? 'respuesta' : 'enviado'}${jsonMatchNote(
          match,
        )}`,
        tone: 'ok',
      });
      rows.push({
        label: 'Objeto',
        value: `${match.parentPath}${match.key !== null ? ` · clave ${match.key}` : ''}`,
        tone: 'dim',
      });
      rows.push(...this.provenanceDataRows(resolution.element, match));
      if (request !== null) {
        rows.push({ label: 'Petición', value: `${request.method} ${request.path}` });
        rows.push({
          label: 'Observada',
          value: observedStatusLabel(request),
          tone: request.outcome === 'failed' || (request.statusCode ?? 0) >= 500 ? 'warn' : 'ok',
        });
      }
      if (route !== null) {
        rows.push({
          label: 'Backend',
          value: `${route.handlerName ?? 'sin resolver'} · ${route.file}:${String(route.line)}`,
          tone: 'ok',
        });
        rows.push(...this.sqlRows(route));
        rows.push(this.databaseRow(provenance.database));
      }
      for (const extra of provenance.matches.slice(1)) {
        rows.push({
          label: 'También',
          value: `${extra.jsonPath} = "${extra.value}"${jsonMatchNote(extra)}`,
          tone: 'dim',
        });
      }
      const code = jsonParentCode(match, request);
      return {
        ...base,
        title: request !== null ? `${request.method} ${request.path}` : `${match.jsonPath}`,
        subtitle: `${selector} · OBSERVADO`,
        rows: this.prepareHoverRows(rows),
        code,
        footer:
          match.basis === 'data'
            ? 'Objeto correlacionado por los valores crudos que recibe el componente.'
            : match.approximate
              ? 'Coincidencia aproximada por valor: el formato en pantalla difiere del JSON.'
              : 'Objeto contenedor del texto en el JSON capturado.',
      };
    }

    const candidates = this.staticRequests(resolution);
    let title = 'Sin petición detectada';
    if (provenance.query !== null) {
      rows.push({
        label: 'JSON',
        value: 'sin coincidencia en cuerpos capturados (máscara, recorte o no JSON)',
        tone: 'dim',
      });
    }
    if (candidates.length === 0) {
      rows.push({
        label: 'Petición',
        value: 'sin petición estática en el manejador',
        tone: 'dim',
      });
    }
    candidates.forEach((candidate, index) => {
      const path = stripQuery(candidate.path);
      const matchedRoute = this.routes.match(candidate.method, path);
      const observed = this.lastObservedRequest(candidate.method, path);
      if (index === 0) {
        title = `${candidate.method} ${candidate.path}`;
        rows.push({ label: 'Método', value: candidate.method });
        rows.push({ label: 'Destino', value: candidate.url });
      } else {
        rows.push({
          label: `Opción ${String(index + 1)}`,
          value: `${candidate.method} ${candidate.path}`,
          tone: 'dim',
        });
      }
      rows.push({
        label: 'Origen',
        value: `${candidate.source}${candidate.detail !== null ? ` · ${candidate.detail}` : ''}`,
      });
      rows.push({
        label: 'Backend',
        value:
          matchedRoute !== null
            ? `${matchedRoute.handlerName ?? 'sin resolver'} · ${matchedRoute.file}:${String(
                matchedRoute.line,
              )}`
            : 'sin ruta estática',
        tone: matchedRoute !== null ? 'ok' : 'dim',
      });
      if (observed !== null) {
        rows.push({
          label: 'Observada',
          value: observedStatusLabel(observed),
          tone: observed.outcome === 'failed' || (observed.statusCode ?? 0) >= 500 ? 'warn' : 'ok',
        });
      } else {
        rows.push({ label: 'Observada', value: 'sin ejecución registrada', tone: 'dim' });
      }
    });

    return {
      ...base,
      title,
      subtitle: `${selector} · ${candidates.length > 0 ? 'ESTÁTICO' : 'SIN PETICIÓN'}`,
      rows: this.prepareHoverRows(rows),
      code: null,
      footer: 'Observada = petición capturada por el navegador.',
    };
  }

  private buildDatabaseHoverTip(
    base: Pick<HoverTipData, 'mode' | 'modeLabel' | 'x' | 'y' | 'rect'>,
    resolution: HoverResolution,
    selector: string,
    provenance: HoverTextProvenance,
  ): HoverTipData {
    const routes: StaticRoute[] = [];
    if (provenance.route !== null) {
      routes.push(provenance.route);
    } else {
      const candidates = this.staticRequests(resolution);
      for (const candidate of candidates) {
        const route = this.routes.match(candidate.method, stripQuery(candidate.path));
        if (route === null) continue;
        const duplicate = routes.some(
          (entry) =>
            entry.file === route.file &&
            entry.line === route.line &&
            entry.method === route.method &&
            entry.path === route.path,
        );
        if (!duplicate) routes.push(route);
      }
    }
    const queries: InspectionSqlQuery[] = [];
    for (const route of routes) {
      for (const query of staticQueriesForRoute(route)) {
        if (query.sql === null) continue;
        if (queries.some((entry) => entry.id === query.id && entry.line === query.line)) continue;
        queries.push(query);
      }
    }

    const rows: HoverTipRow[] = [];
    const match = provenance.matches[0] ?? null;
    const link = provenance.runtime;
    const dialect = queries.find((query) => query.dialect !== null)?.dialect ?? null;
    if (link !== null) {
      rows.push(...this.runtimeOriginRows(link));
    }
    if (provenance.query !== null) {
      rows.push({ label: 'Texto', value: provenance.query, tone: 'normal' });
    }
    if (match !== null) {
      rows.push({
        label: 'JSON',
        value: `${match.jsonPath} · ${match.origin === 'response' ? 'respuesta' : 'enviado'}${jsonMatchNote(
          match,
        )}`,
        tone: 'ok',
      });
    }
    if (provenance.request !== null && (link === null || link.requestInfo === null)) {
      rows.push({
        label: 'Petición',
        value: `${provenance.request.method} ${provenance.request.path} · ${observedStatusLabel(
          provenance.request,
        )}`,
        tone: 'dim',
      });
    }
    if (provenance.database === null) {
      const engine = dialect === null ? null : DIALECT_ENGINE[dialect];
      rows.push({
        label: 'Base de datos',
        value:
          engine === null ? 'sin nombre detectado en el código' : `${engine} · nombre no declarado`,
        tone: engine === null ? 'dim' : 'ok',
      });
    } else {
      rows.push({
        label: 'Base de datos',
        value: databaseHintLabel(provenance.database),
        tone: 'ok',
      });
    }
    if (routes.length === 0) {
      rows.push({
        label: 'Ruta',
        value: 'sin ruta estática para la petición',
        tone: 'dim',
      });
    }
    for (const route of routes) {
      rows.push({
        label: 'Ruta',
        value: `${route.handlerName ?? 'sin resolver'} · ${route.file}:${String(route.line)}`,
        tone: 'ok',
      });
      if (route.note !== null) rows.push({ label: 'Nota', value: route.note, tone: 'warn' });
    }
    if (routes.length > 0 && queries.length === 0) {
      rows.push({ label: 'SQL', value: 'sin SQL estático en el manejador', tone: 'dim' });
    }

    const tablesRead: string[] = [];
    const tablesWritten: string[] = [];
    const columns: string[] = [];
    for (const query of queries) {
      for (const table of query.tablesRead) {
        if (!tablesRead.includes(table)) tablesRead.push(table);
      }
      for (const table of query.tablesWritten) {
        if (!tablesWritten.includes(table)) tablesWritten.push(table);
      }
      for (const column of query.columns) {
        const label = `${column.table !== null ? `${column.table}.` : ''}${column.name} (${column.usage})`;
        if (!columns.includes(label)) columns.push(label);
      }
    }
    if (tablesRead.length > 0) {
      rows.push({ label: 'Lee', value: tablesRead.join(', '), tone: 'normal' });
    }
    if (tablesWritten.length > 0) {
      rows.push({ label: 'Escribe', value: tablesWritten.join(', '), tone: 'warn' });
    }
    if (columns.length > 0) {
      rows.push({ label: 'Columnas', value: columns.join('\n'), tone: 'dim' });
    } else if (queries.some((query) => query.selectStar)) {
      rows.push({
        label: 'Columnas',
        value: 'SELECT * · el SQL no declara columnas',
        tone: 'warn',
      });
    }
    if (dialect !== null) {
      rows.push({ label: 'Dialecto', value: dialect, tone: 'dim' });
    }

    const firstQuery = queries[0];
    const firstRoute = routes[0];
    const primaryTables =
      firstQuery === undefined
        ? []
        : firstQuery.tablesRead.length > 0
          ? firstQuery.tablesRead
          : firstQuery.tablesWritten;
    const code: HoverTipCode | null =
      firstQuery === undefined || firstQuery.sql === null
        ? null
        : {
            file: `${firstRoute?.file ?? ''} · ${SQL_OPERATION_LABEL[firstQuery.operation]}`.trim(),
            range: firstQuery.line > 0 ? `línea ${String(firstQuery.line)}` : 'SQL estático',
            lines: firstQuery.sql.split('\n').map((text, index) => ({
              line: firstQuery.line > 0 ? firstQuery.line + index : index + 1,
              text,
            })),
          };

    return {
      ...base,
      title:
        firstQuery !== undefined
          ? `${SQL_OPERATION_LABEL[firstQuery.operation]}${
              primaryTables.length > 0 ? ` · ${primaryTables.join(', ')}` : ''
            }`
          : firstRoute !== undefined
            ? `${firstRoute.method.toUpperCase()} ${firstRoute.path}`
            : 'Sin SQL',
      subtitle: `${selector} · ${match !== null || link !== null ? 'OBSERVADO' : 'ESTÁTICO'}`,
      rows: this.prepareHoverRows(rows),
      code,
      footer:
        link !== null
          ? 'Ruta y base de datos de la petición enlazada por identidad en ejecución · SQL estático no ejecutado.'
          : match?.basis === 'data'
            ? 'Base de datos y ruta correlacionadas por los datos del componente · SQL estático no ejecutado.'
            : 'Base de datos detectada en fuentes del proyecto · SQL estático no ejecutado.',
    };
  }

  private fallbackHoverTip(signal: InspectorHoverSignal, mode: InspectionMode): HoverTipData {
    const rows: HoverTipRow[] = [];
    rows.push({ label: 'Elemento', value: `<${signal.element.tag}>` });
    if (signal.element.text !== null) {
      rows.push({ label: 'Texto', value: signal.element.text });
    }
    return {
      mode,
      modeLabel: INSPECTION_MODE_LABEL[mode],
      title: `<${signal.element.tag}>`,
      subtitle: 'No se pudo leer el elemento con CDP.',
      rows,
      code: null,
      footer: null,
      x: signal.x,
      y: signal.y,
      rect: signal.rect,
    };
  }

  private hoverSubtitle(element: HoverElementInfo): string {
    const parts = [
      `${String(Math.round(element.rect.width))} × ${String(Math.round(element.rect.height))} px`,
    ];
    const display = hoverStyleValue(element, 'display');
    const position = hoverStyleValue(element, 'position');
    if (display !== null) parts.push(display);
    if (position !== null) parts.push(position);
    return parts.join(' · ');
  }

  private prepareHoverRows(rows: HoverTipRow[]): HoverTipRow[] {
    return rows.map((row) => ({
      label: row.label,
      value: row.value.trim(),
      tone: row.tone,
    }));
  }

  private runtimeOriginRows(link: RuntimeLink): HoverTipRow[] {
    const rows: HoverTipRow[] = [];
    if (link.render !== null) {
      const render = link.render;
      const file = link.renderFile ?? render.file;
      const location =
        file === null
          ? 'sin archivo en el build'
          : `${shortFunctionSource(file)}${
              render.line === null
                ? ''
                : `:${String(render.line)}${
                    render.column === null ? '' : `:${String(render.column)}`
                  }`
            }`;
      rows.push({
        label: 'Render',
        value: `${render.component ?? 'componente'} · ${location}`,
        tone: link.renderFile !== null ? 'ok' : render.file === null ? 'dim' : 'normal',
      });
      if (link.renderLine !== null) {
        rows.push({ label: 'Código', value: link.renderLine, tone: 'ok' });
      } else if (link.renderFile === null && link.renderSymbol !== null) {
        rows.push({
          label: 'Definición',
          value: `${shortFunctionSource(link.renderSymbol.file)}:${String(
            link.renderSymbol.line,
          )} · ${link.renderSymbol.definition}`,
          tone: 'normal',
        });
      }
    } else if (link.functions.length > 0) {
      const chain = link.functions.map((entry) => entry.name).join(' → ');
      const primary = link.functions[0]?.name ?? 'componente';
      const location =
        link.renderSymbol === null
          ? 'sin archivo en el build'
          : `${shortFunctionSource(link.renderSymbol.file)}:${String(link.renderSymbol.line)}`;
      rows.push({
        label: 'Render',
        value: `${primary} · ${location}`,
        tone: link.renderSymbol === null ? 'dim' : 'ok',
      });
      if (link.functions.length > 1) {
        rows.push({ label: 'Cadena', value: chain, tone: 'dim' });
      }
      if (link.renderSymbol !== null) {
        rows.push({ label: 'Definición', value: link.renderSymbol.definition, tone: 'normal' });
      }
    }
    if (link.data !== null) {
      const value = link.data.value === '' ? '' : ` = "${link.data.value}"`;
      rows.push({
        label: 'Dato',
        value: `${link.data.component} · ${link.data.path}${value}`,
        tone: 'ok',
      });
      if (link.requestInfo !== null) {
        rows.push({
          label: 'Respuesta',
          value: `${link.data.jsonPath} · ${link.requestInfo.method} ${link.requestInfo.path}`,
          tone: 'ok',
        });
      }
    }
    if (link.requestInfo !== null) {
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const frame of link.requestInfo.frames) {
        const frameKey = `${frame.functionName ?? ''}|${frame.url}|${String(frame.line)}`;
        if (seen.has(frameKey)) continue;
        seen.add(frameKey);
        lines.push(
          `${frame.functionName ?? 'anónima'} · ${shortFunctionSource(frame.url)}:${String(
            frame.line,
          )}`,
        );
      }
      if (lines.length > 0) {
        rows.push({ label: 'Pila', value: lines.join('\n'), tone: 'ok' });
      }
      if (link.request !== null) {
        rows.push({
          label: 'Petición',
          value: `${link.request.method} ${link.request.path} · ${observedStatusLabel(
            link.request,
          )}`,
          tone: 'dim',
        });
      } else {
        const status =
          link.requestInfo.status === null
            ? 'sin estado'
            : `HTTP ${String(link.requestInfo.status)}`;
        rows.push({
          label: 'Petición',
          value: `${link.requestInfo.method} ${link.requestInfo.path} · ${status} · fuera del búfer`,
          tone: 'warn',
        });
      }
    }
    return rows;
  }

  private runtimeChainRows(link: RuntimeLink): HoverTipRow[] {
    const rows = this.runtimeOriginRows(link);
    if (link.requestInfo !== null) {
      if (link.route !== null) {
        rows.push({
          label: 'Ruta',
          value: `${link.route.handlerName ?? 'sin resolver'} · ${link.route.file}:${String(
            link.route.line,
          )}`,
          tone: 'ok',
        });
        rows.push(...this.sqlRows(link.route));
        rows.push(this.databaseRow(link.database));
      } else {
        rows.push({
          label: 'Ruta',
          value: 'sin ruta estática para la petición ejecutada',
          tone: 'dim',
        });
      }
    }
    for (const extra of link.entries) {
      if (extra === link.data) continue;
      const value = extra.value === '' ? '' : ` = "${extra.value}"`;
      rows.push({
        label: 'También',
        value: `${extra.component} · ${extra.path}${value} · ${extra.jsonPath}`,
        tone: 'dim',
      });
    }
    if (link.note !== null) rows.push({ label: 'Nota', value: link.note, tone: 'warn' });
    return rows;
  }

  private provenanceDataRows(element: HoverElementInfo, match: JsonTextMatch): HoverTipRow[] {
    const rows: HoverTipRow[] = [];
    const matchedNumbers = displayNumbers(match.value);
    for (const entry of element.dataValues) {
      if (rows.length >= 3) break;
      const sameText = entry.value.trim() === match.value.trim();
      const sameNumber =
        matchedNumbers.length > 0 &&
        displayNumbers(entry.value).some((value) => matchedNumbers.includes(value));
      if (!sameText && !sameNumber) continue;
      rows.push({
        label: 'Dato',
        value: `${entry.component} · ${entry.path} = "${entry.value}"`,
        tone: 'ok',
      });
    }
    return rows;
  }

  private sqlRows(route: StaticRoute): HoverTipRow[] {
    const read = new Set<string>();
    const written = new Set<string>();
    for (const query of staticQueriesForRoute(route)) {
      if (query.sql === null) continue;
      for (const table of query.tablesRead) read.add(table);
      for (const table of query.tablesWritten) written.add(table);
    }
    const rows: HoverTipRow[] = [];
    if (read.size > 0) {
      rows.push({ label: 'SQL', value: `lee ${[...read].join(', ')}`, tone: 'normal' });
    }
    if (written.size > 0) {
      rows.push({ label: 'SQL', value: `escribe ${[...written].join(', ')}`, tone: 'warn' });
    }
    return rows;
  }

  private databaseRow(database: DatabaseHint | null): HoverTipRow {
    return {
      label: 'Base de datos',
      value: database === null ? 'sin nombre detectado en el código' : databaseHintLabel(database),
      tone: database === null ? 'dim' : 'ok',
    };
  }

  private staticRequests(resolution: HoverResolution): StaticRequestCandidate[] {
    const element = resolution.element;
    const candidates: StaticRequestCandidate[] = [];
    const add = (
      methodRaw: string,
      rawUrl: string | null | undefined,
      source: string,
      detail: string | null,
    ): void => {
      if (rawUrl === null || rawUrl === undefined) return;
      const raw = rawUrl.trim();
      if (raw === '' || raw.length > 500) return;
      if (/^(?:#|javascript:|mailto:|tel:|data:|blob:)/i.test(raw)) return;
      const method = methodRaw.trim().toUpperCase().slice(0, 10);
      if (!/^[A-Z]+$/.test(method)) return;
      const target = this.resolveStaticTarget(raw);
      if (target === null) return;
      const path = stripQuery(target.path);
      if (!path.startsWith('/')) return;
      if (candidates.some((entry) => entry.method === method && entry.path === path)) return;
      candidates.push({ method, path, url: target.url, source, detail });
    };

    if (element.form !== null && element.form.action !== '') {
      add(element.form.method, element.form.action, 'form action', 'formulario');
    }
    if (element.link !== null) {
      add('GET', element.link, 'href', 'enlace');
    }
    for (const attribute of element.attributes) {
      if (!/^data-(?:url|endpoint|href|action)$/i.test(attribute.name)) continue;
      if (attribute.value === '') continue;
      add('GET', attribute.value, attribute.name, null);
    }
    const handler = resolution.handler;
    if (handler !== null && handler.code !== null) {
      const code = handler.code.lines.map((line) => line.text).join('\n');
      for (const found of extractRequestsFromCode(code)) {
        add(found.method, found.url, found.source, handler.name ?? 'función anónima');
      }
    }
    return candidates;
  }

  private resolveStaticTarget(raw: string): { url: string; path: string } | null {
    const base = this.state.currentUrl ?? this.state.config?.frontend.url ?? null;
    try {
      const url = new URL(raw, base ?? undefined);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return { url: url.toString(), path: url.pathname };
    } catch {
      return null;
    }
  }

  private lastObservedRequest(method: string, path: string): CapturedRequest | null {
    const requests = this.buffer?.all();
    if (requests === undefined) return null;
    const normalizedMethod = method.toUpperCase();
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index];
      if (request === undefined) continue;
      if (request.method.toUpperCase() !== normalizedMethod) continue;
      if (stripQuery(request.path) !== path) continue;
      return request;
    }
    return null;
  }

  private recordRequestActivity(request: CapturedRequest): void {
    const status =
      request.outcome === 'failed'
        ? 'ERR'
        : request.statusCode === null
          ? '—'
          : String(request.statusCode);
    let tone: ActivityTone = 'ok';
    if (
      request.outcome === 'failed' ||
      (request.statusCode !== null && request.statusCode >= 500)
    ) {
      tone = 'error';
    } else if (request.statusCode !== null && request.statusCode >= 400) {
      tone = 'warning';
    }
    const details = [
      REQUEST_ORIGIN_LABEL[request.origin],
      request.host,
      durationLabel(request.durationMs),
    ];
    if (request.error !== null) details.push(request.error);
    this.recordActivity({
      category: 'request',
      tone,
      title: `${request.method} ${stripQuery(request.path)} · ${status}`,
      detail: details.join(' · '),
      method: request.method,
      path: stripQuery(request.path),
    });
  }

  private isPreflight(request: CapturedRequest): boolean {
    return (
      request.method === 'OPTIONS' &&
      Object.keys(request.headers).some(
        (header) => header.toLowerCase() === 'access-control-request-method',
      )
    );
  }

  private toCdpTime(at: number): number | null {
    return this.cdpClockOffsetMs === null ? null : at - this.cdpClockOffsetMs;
  }

  private isBackendTraffic(request: CapturedRequest): boolean {
    if (request.origin === 'backend') return true;
    return this.routes.match(request.method, stripQuery(request.path)) !== null;
  }

  private phaseForStartedAt(session: InspectionSession, startedAt: number): InspectionRequestPhase {
    const clickedAtCdp = this.toCdpTime(session.clickedAt) ?? session.clickedAt;
    if (startedAt < clickedAtCdp - INSPECTION_LEEWAY_MS) return 'background';
    if (startedAt > clickedAtCdp + INSPECTION_WINDOW_MS) return 'background';
    return 'after-click';
  }

  private seedBackgroundRequests(session: InspectionSession): void {
    const buffer = this.buffer;
    if (buffer === null) return;
    for (const request of buffer.all()) {
      if (!this.isBackendTraffic(request) || this.isPreflight(request)) continue;
      this.addInspectionRequest(
        session,
        request,
        this.phaseForStartedAt(session, request.startedAt),
      );
    }
    this.autoSelect(session);
  }

  private addInspectionRequest(
    session: InspectionSession,
    request: CapturedRequest,
    phase: InspectionRequestPhase,
  ): InspectionRequest {
    const initiatorFunction = request.initiator?.frames[0]?.functionName ?? null;
    const item: InspectionRequest = {
      id: request.id,
      method: request.method,
      path: request.path,
      startedAt: request.startedAt,
      wallStartedAt: request.wallStartedAt,
      statusCode: request.statusCode,
      durationMs: request.durationMs,
      outcome: request.outcome,
      correlation:
        session.handlerName !== null &&
        initiatorFunction !== null &&
        initiatorFunction === session.handlerName
          ? 'direct'
          : 'heuristic',
      initiatorFunction,
      phase,
      backend: this.backendSummaryFor(request.method, request.path),
      requestBody: request.requestBody,
      responseBody: request.responseBody,
    };
    session.requests.set(item.id, item);
    const card = session.card;
    card.requests.push(item);
    card.requests.sort((left, right) => left.startedAt - right.startedAt);
    addEvidence(card, 'RUNTIME');
    return item;
  }

  private recordInspectionRequest(request: CapturedRequest): void {
    const session = this.inspectionSession;
    if (session === null) return;
    if (!this.isBackendTraffic(request) || this.isPreflight(request)) return;

    const existing = session.requests.get(request.id);
    if (existing !== undefined) {
      existing.statusCode = request.statusCode;
      existing.durationMs = request.durationMs;
      existing.outcome = request.outcome;
      existing.requestBody = request.requestBody;
      existing.responseBody = request.responseBody;
      const initiatorFunction = request.initiator?.frames[0]?.functionName ?? null;
      if (initiatorFunction !== null) {
        existing.initiatorFunction = initiatorFunction;
        existing.correlation =
          session.handlerName !== null && initiatorFunction === session.handlerName
            ? 'direct'
            : 'heuristic';
      }
      if (existing.backend === null) {
        existing.backend = this.backendSummaryFor(request.method, request.path);
      }
      this.autoSelect(session);
      this.updatePanel(session.card);
      return;
    }

    this.addInspectionRequest(session, request, this.phaseForStartedAt(session, request.startedAt));
    this.autoSelect(session);
    this.updatePanel(session.card);
  }

  private autoSelect(session: InspectionSession): void {
    if (session.selectedByUser) return;
    const card = session.card;
    const afterClick = card.requests.filter((item) => item.phase === 'after-click');
    let candidate: InspectionRequest | undefined;
    if (afterClick.length > 0) {
      candidate = afterClick.find((item) => item.correlation === 'direct') ?? afterClick[0];
    } else if (card.selectedRequestId === null) {
      const background = card.requests.filter((item) => item.phase === 'background');
      candidate = background[background.length - 1];
    }
    if (candidate === undefined || candidate.id === card.selectedRequestId) return;
    this.selectRequest(session, candidate);
  }

  private selectRequest(session: InspectionSession, request: InspectionRequest): void {
    const card = session.card;
    card.selectedRequestId = request.id;
    card.endpoint = { method: request.method, path: request.path };
    card.backend = null;
    card.queries = [];
    card.execution = null;
    card.level = 'N0';
    card.note = null;
    this.resolveBackend(session);
    this.updatePanel(card);
  }

  private selectedRequest(session: InspectionSession): InspectionRequest | null {
    const id = session.card.selectedRequestId;
    if (id === null) return null;
    return session.requests.get(id) ?? null;
  }

  private backendSummary(route: StaticRoute): InspectionRequestBackend {
    return {
      routePath: route.path,
      handlerName: route.handlerName,
      file: route.file,
      line: route.line,
      routeLine: route.routeLine,
      framework: route.framework,
      resolved: route.resolved,
      note: route.note,
    };
  }

  private backendSummaryFor(method: string, requestPath: string): InspectionRequestBackend | null {
    const route = this.routes.match(method, stripQuery(requestPath));
    return route === null ? null : this.backendSummary(route);
  }

  private refreshRequestBackends(session: InspectionSession): void {
    for (const request of session.card.requests) {
      if (request.backend === null) {
        request.backend = this.backendSummaryFor(request.method, request.path);
      }
    }
  }

  private resolveBackend(session: InspectionSession): void {
    const request = this.selectedRequest(session);
    if (request === null) return;
    const requestPath = stripQuery(request.path);
    const route = this.routes.match(request.method, requestPath);
    if (route !== null) {
      this.applyBackend(session, request, route);
      return;
    }
    if (session.routeLookupPending) return;
    session.routeLookupPending = true;
    void this.routes
      .refresh()
      .then(() => {
        session.routeLookupPending = false;
        this.syncInspectorRoutes();
        if (this.inspectionSession !== session) return;
        this.refreshRequestBackends(session);
        const current = this.selectedRequest(session);
        if (current === null) return;
        const found = this.routes.match(current.method, stripQuery(current.path));
        if (found !== null) {
          this.applyBackend(session, current, found);
        } else {
          session.card.note =
            this.options.getWorkspaceRoot() === null
              ? 'Abre el proyecto del backend.'
              : 'Sin ruta estática en el proyecto.';
          this.tryAttachExecution(session);
          this.updatePanel(session.card);
        }
      })
      .catch(() => {
        session.routeLookupPending = false;
      });
  }

  private applyBackend(
    session: InspectionSession,
    request: InspectionRequest,
    route: StaticRoute,
  ): void {
    const summary = this.backendSummary(route);
    request.backend = summary;
    const source = this.readBackendSource(route);
    const backend: InspectionBackend = {
      ...summary,
      method: route.method.toUpperCase(),
      endLine: route.endLine,
      code: source.code,
      codeNote: source.note,
    };
    session.card.backend = backend;
    session.card.queries = staticQueriesForRoute(route);
    if (session.card.level !== 'N2') {
      session.card.level = 'N1';
    }
    addEvidence(session.card, 'STATIC');
    this.tryAttachSql(session);
    this.tryAttachExecution(session);
    this.updatePanel(session.card);
  }

  private onSqlObserved(observation: SqlObservation): void {
    const routes = observation.breakpoints
      .map((breakpoint) => `${breakpoint.method.toUpperCase()} ${breakpoint.path}`)
      .join(', ');
    this.recordActivity({
      category: 'sql',
      tone: 'ok',
      title: 'Línea SQL ejecutada',
      detail: [observation.file + ':' + String(observation.line), routes, observation.functionName]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · '),
      file: observation.file,
      line: observation.line,
    });
    const session = this.inspectionSession;
    if (session === null) return;
    if (
      observation.observedAt < session.clickedAt - INSPECTION_LEEWAY_MS ||
      observation.observedAt > session.clickedAt + INSPECTION_WINDOW_MS
    ) {
      return;
    }
    const duplicate = session.sqlObservations.some(
      (item) =>
        item.observedAt === observation.observedAt &&
        item.file === observation.file &&
        item.line === observation.line,
    );
    if (duplicate) return;
    session.sqlObservations.push(observation);
    if (this.tryAttachSql(session)) {
      this.updatePanel(session.card);
    }
  }

  private tryAttachSql(session: InspectionSession): boolean {
    const card = session.card;
    if (card.queries.length === 0 || session.sqlObservations.length === 0) {
      return false;
    }
    const endpoint = card.endpoint;
    if (endpoint === null) {
      return false;
    }
    const method = endpoint.method.toUpperCase();
    const path = stripQuery(endpoint.path);
    const backend = card.backend;
    let changed = false;
    for (const query of card.queries) {
      if (query.status === 'observed') {
        continue;
      }
      const hit = session.sqlObservations.find(
        (observation) =>
          observation.siteIds.includes(query.id) &&
          observation.breakpoints.some((breakpoint) => {
            if (breakpoint.method.toUpperCase() !== method) return false;
            return backend !== null
              ? breakpoint.path === backend.routePath
              : breakpoint.path === path;
          }),
      );
      if (hit === undefined) {
        continue;
      }
      query.status = 'observed';
      query.observedAt = hit.observedAt;
      addEvidence(card, 'RUNTIME');
      changed = true;
      this.log.info('Consulta SQL asociada a la inspección', {
        file: backend?.file ?? null,
        line: query.line,
        operation: query.operation,
        routes: hit.breakpoints,
      });
    }
    return changed;
  }

  private onSqlCaptureChanged(info: SqlCaptureInfo): void {
    if (!info.ok) {
      this.recordActivity({
        category: 'backend',
        tone: 'warning',
        title: 'La captura SQL en runtime no está disponible',
        detail: info.error ?? 'El inspector no pudo instalar los hooks de los drivers.',
      });
      return;
    }
    if (info.drivers.length === 0) {
      this.recordActivity({
        category: 'backend',
        tone: 'warning',
        title: 'Sin drivers SQL detectados',
        detail: info.prisma
          ? 'Prisma usa un motor propio y no expone el SQL al driver de Node. La captura cubre pg, mysql2, mysql, sqlite3 y better-sqlite3.'
          : 'La captura cubre pg, mysql2, mysql, sqlite3 y better-sqlite3.',
      });
      return;
    }
    const detail = [`Drivers: ${info.drivers.join(', ')}`, 'solo texto SQL, sin parámetros'];
    if (info.prisma) {
      detail.push('Prisma usa un motor propio: su SQL no se puede leer desde el driver');
    }
    this.recordActivity({
      category: 'backend',
      title: 'Captura SQL de drivers activa',
      detail: detail.join(' · '),
    });
  }

  private onSqlCaptured(execution: CapturedSqlExecution): void {
    const key = `${String(execution.at)}:${execution.driver}:${execution.sql.slice(0, 200)}`;
    if (!this.runtimeSqlActivitySeen.has(key)) {
      this.runtimeSqlActivitySeen.add(key);
      if (this.runtimeSqlActivitySeen.size > 500) this.runtimeSqlActivitySeen.clear();
      const analysis = analyzeSql(execution.sql)[0];
      const tables =
        analysis === undefined
          ? []
          : [...new Set([...analysis.tablesRead, ...analysis.tablesWritten])];
      const frame = this.primaryFrame(execution);
      this.recordActivity({
        category: 'sql',
        tone: 'ok',
        title: `SQL ${(analysis?.operation ?? sqlOperationFromText(execution.sql)).toUpperCase()}${
          tables.length === 0 ? '' : ` · ${tables.slice(0, 3).join(', ')}`
        } · ${execution.driver}`,
        detail: execution.sql,
        file: frame?.file ?? null,
        line: frame?.line ?? null,
      });
    }
    const session = this.inspectionSession;
    if (session === null) return;
    if (this.applyCapturedSql(session, execution)) {
      this.updatePanel(session.card);
    }
  }

  private applyCapturedSql(session: InspectionSession, execution: CapturedSqlExecution): boolean {
    const card = session.card;
    if (
      execution.at < session.clickedAt - INSPECTION_LEEWAY_MS ||
      execution.at > session.clickedAt + INSPECTION_WINDOW_MS
    ) {
      return false;
    }
    const normalized = normalizeSqlText(execution.sql);
    if (normalized === '') return false;

    const known = card.queries.find(
      (query) => query.sql !== null && normalizeSqlText(query.sql) === normalized,
    );
    if (known !== undefined) {
      if (known.status === 'observed') return false;
      known.status = 'observed';
      known.observedAt = execution.at;
      addEvidence(card, 'RUNTIME');
      this.log.info('Consulta SQL capturada coincide con una consulta estática', {
        driver: execution.driver,
        operation: known.operation,
      });
      return true;
    }

    const analysis = analyzeSql(execution.sql)[0];
    const frame = this.primaryFrame(execution);
    card.queries.push({
      id: `runtime-${String(++this.sqlRuntimeSequence)}`,
      status: 'observed',
      operation: analysis?.operation ?? sqlOperationFromText(execution.sql),
      tablesRead: analysis === undefined ? [] : [...analysis.tablesRead],
      tablesWritten: analysis === undefined ? [] : [...analysis.tablesWritten],
      columns: analysis === undefined ? [] : analysis.columns.map((column) => ({ ...column })),
      dialect: analysis?.dialect ?? null,
      parse: analysis?.parse ?? 'fallback',
      selectStar: analysis?.selectStar ?? false,
      sql: shorten(execution.sql, 700),
      dynamic: false,
      line: frame?.line ?? 0,
      column: frame?.column ?? 0,
      callMethod: execution.driver,
      callObject: null,
      note: null,
      observedAt: execution.at,
    });
    addEvidence(card, 'RUNTIME');
    this.log.info('Consulta SQL capturada en runtime', {
      driver: execution.driver,
      file: frame?.file ?? null,
      line: frame?.line ?? null,
      operation: analysis?.operation ?? null,
    });
    return true;
  }

  private primaryFrame(execution: CapturedSqlExecution): RelativeFrame | null {
    for (const frame of execution.frames) {
      const file = this.relativeFramePath(frame.file);
      if (file === null) continue;
      return { file, line: frame.line, column: frame.column };
    }
    return null;
  }

  private relativeFramePath(file: string): string | null {
    let absolute = file;
    if (file.startsWith('file:')) {
      try {
        absolute = fileURLToPath(file);
      } catch {
        return null;
      }
    }
    return this.relativeFilePath(absolute);
  }

  private relativeFilePath(absolute: string): string | null {
    const root = this.options.getWorkspaceRoot();
    if (root === null) return null;
    if (!path.isAbsolute(absolute)) return null;
    const relative = path.relative(root, absolute);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      relative.startsWith('../') ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    return relative.split(path.sep).join('/');
  }

  private readBackendSource(route: StaticRoute): BackendSource {
    const root = this.options.getWorkspaceRoot();
    if (root === null) {
      return {
        code: null,
        note: 'Sin proyecto abierto.',
      };
    }
    try {
      return {
        code: readCodeBlock(root, route.file, route.line, route.endLine, {
          maxLines: MAX_BACKEND_CODE_LINES,
        }),
        note: null,
      };
    } catch (error) {
      return {
        code: null,
        note: error instanceof Error ? error.message : 'No se pudo leer el código del manejador.',
      };
    }
  }

  private syncInspectorRoutes(): void {
    if (this.runtime === null) return;
    void this.runtime.setRoutes(this.routes.all()).catch((error: unknown) => {
      this.log.warn('No se pudieron sincronizar los puntos de parada', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private onRuntimeChanged(runtime: InspectionRuntime): void {
    const changed = this.lastRuntimeStatus !== runtime.status;
    this.lastRuntimeStatus = runtime.status;
    this.panelRuntime = runtime;
    if (changed && runtime.status === 'connected') {
      this.recordActivity({
        category: 'backend',
        title: 'Inspector de Node conectado',
        detail: runtime.message,
      });
    } else if (changed && runtime.status === 'unavailable') {
      this.recordActivity({
        category: 'backend',
        tone: 'warning',
        title: 'Inspector de Node no disponible',
        detail: runtime.message,
      });
    }
    this.updatePanel(this.inspectionSession?.card ?? null);
  }

  private onNodeExecution(execution: InspectionExecution): void {
    const routes = execution.breakpoints
      .map((breakpoint) => `${breakpoint.method.toUpperCase()} ${breakpoint.path}`)
      .join(', ');
    this.recordActivity({
      category: 'backend',
      title: `Ejecución de ${execution.functionName ?? 'una función anónima'}`,
      detail: [execution.file + ':' + String(execution.line), routes]
        .filter((part) => part !== '')
        .join(' · '),
      file: execution.file,
      line: execution.line,
    });
    const session = this.inspectionSession;
    if (session === null) return;
    if (
      execution.observedAt < session.clickedAt - INSPECTION_LEEWAY_MS ||
      execution.observedAt > session.clickedAt + INSPECTION_WINDOW_MS
    ) {
      return;
    }
    const duplicate = session.executions.some(
      (item) =>
        item.observedAt === execution.observedAt &&
        item.file === execution.file &&
        item.line === execution.line,
    );
    if (duplicate) return;
    session.executions.push(execution);
    this.tryAttachExecution(session);
  }

  private tryAttachExecution(session: InspectionSession): void {
    const card = session.card;
    if (card.execution !== null) return;
    const endpoint = card.endpoint;
    if (endpoint === null) return;
    const method = endpoint.method.toUpperCase();
    const path = stripQuery(endpoint.path);
    const backend = card.backend;
    const candidate = session.executions.find((execution) =>
      execution.breakpoints.some((breakpoint) => {
        if (breakpoint.method.toUpperCase() !== method) return false;
        return backend !== null ? breakpoint.path === backend.routePath : breakpoint.path === path;
      }),
    );
    if (candidate === undefined) return;
    card.execution = candidate;
    card.level = 'N2';
    addEvidence(card, 'RUNTIME');
    this.log.info('Ejecución asociada a la inspección', {
      file: candidate.file,
      line: candidate.line,
      function: candidate.functionName,
    });
    this.updatePanel(card);
  }

  private updatePanel(card: InspectionCard | null): void {
    if (card !== null) {
      this.flowLedger.upsert(card);
      this.markFlowDirty();
    }
    this.panel.update({
      card,
      runtime: { ...this.panelRuntime },
      inspectionEnabled: this.state.inspectionEnabled,
      mode: this.inspectionMode,
    });
  }

  private hostWindow(): BrowserWindow | null {
    const window = this.chromeWindow ?? this.window ?? this.getWindow();
    return window !== null && !window.isDestroyed() ? window : null;
  }

  private handleCdpMessage(method: string, params: unknown): void {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(params as CdpRequestWillBeSent);
        break;
      case 'Network.responseReceived':
        this.onResponseReceived(params as CdpResponseReceived);
        break;
      case 'Network.loadingFinished':
        this.onLoadingFinished(params as CdpLoadingFinished);
        break;
      case 'Network.loadingFailed':
        this.onLoadingFailed(params as CdpLoadingFailed);
        break;
      case 'Debugger.paused': {
        void this.view?.webContents.debugger.sendCommand('Debugger.resume').catch(() => undefined);
        break;
      }
      default:
        break;
    }
  }

  private onRequestWillBeSent(params: CdpRequestWillBeSent): void {
    const buffer = this.buffer;
    if (buffer === null) return;
    this.cdpClockOffsetMs = Date.now() - params.timestamp * 1000;

    let redirects = this.redirects.get(params.requestId) ?? 0;
    if (params.redirectResponse !== undefined) {
      const current = this.pending.get(params.requestId);
      if (current !== undefined) {
        const finished = buffer.finish(current.storeId, {
          statusCode: params.redirectResponse.status,
          mimeType: params.redirectResponse.mimeType ?? null,
          durationMs: (params.timestamp - current.startedAt) * 1000,
        });
        if (finished !== null) {
          this.dirty.add(finished.id);
          this.recordRequestActivity(finished);
          this.recordInspectionRequest(finished);
        }
        this.scheduleFlush();
      }
      redirects += 1;
      this.redirects.set(params.requestId, redirects);
    }

    const storeId = redirects === 0 ? params.requestId : `${params.requestId}:${redirects}`;
    const requestBody = sanitizeJsonBody(params.request.postData, MAX_BODY_CHARS);
    const wallTimestamp =
      params.wallTime !== undefined && Number.isFinite(params.wallTime) && params.wallTime > 0
        ? params.wallTime * 1000
        : Date.now();
    const created = buffer.begin({
      requestId: storeId,
      url: params.request.url,
      method: params.request.method,
      resourceType: params.type ?? 'Other',
      timestamp: params.timestamp * 1000,
      wallTimestamp,
      initiator: params.initiator ?? null,
      headers: params.request.headers ?? null,
      requestBody,
    });
    if (created === null) return;

    this.pending.set(params.requestId, {
      storeId,
      startedAt: params.timestamp,
      statusCode: null,
      mimeType: null,
    });
    this.dirty.add(created.id);
    this.recordInspectionRequest(created);
    if (requestBody === null && hasJsonContentType(params.request.headers)) {
      void this.captureRequestBody(storeId, params.requestId);
    }
    this.scheduleFlush();
  }

  private onResponseReceived(params: CdpResponseReceived): void {
    const current = this.pending.get(params.requestId);
    if (current === undefined) return;
    current.statusCode = params.response.status;
    current.mimeType = params.response.mimeType ?? null;
  }

  private onLoadingFinished(params: CdpLoadingFinished): void {
    const current = this.pending.get(params.requestId);
    if (current === undefined || this.buffer === null) return;
    const finished = this.buffer.finish(current.storeId, {
      statusCode: current.statusCode,
      mimeType: current.mimeType,
      durationMs: (params.timestamp - current.startedAt) * 1000,
    });
    this.pending.delete(params.requestId);
    this.redirects.delete(params.requestId);
    if (finished !== null) {
      this.dirty.add(finished.id);
      this.recordRequestActivity(finished);
      this.recordInspectionRequest(finished);
      void this.captureResponseBody(
        finished.id,
        params.requestId,
        finished.mimeType,
        finished.resourceType,
      );
    }
    this.scheduleFlush();
  }

  private async captureRequestBody(storeId: string, requestId: string): Promise<void> {
    const view = this.view;
    if (view === null || view.webContents.isDestroyed()) return;
    try {
      const response = (await view.webContents.debugger.sendCommand('Network.getRequestPostData', {
        requestId,
      })) as { postData?: string };
      if (typeof response.postData !== 'string') return;
      const body = sanitizeJsonBody(response.postData, MAX_BODY_CHARS);
      if (body === null || this.view !== view) return;
      const updated = this.buffer?.setRequestBody(storeId, body) ?? null;
      if (updated === null) return;
      this.dirty.add(updated.id);
      this.recordInspectionRequest(updated);
      this.scheduleFlush();
    } catch (error) {
      this.log.debug('No se pudo leer el cuerpo JSON de la petición', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async captureResponseBody(
    storeId: string,
    requestId: string,
    mimeType: string | null,
    resourceType: string,
  ): Promise<void> {
    const mime = mimeType === null ? '' : mimeType.toLowerCase();
    const jsonMime = mime.includes('json');
    const apiCall = resourceType === 'XHR' || resourceType === 'Fetch';
    const textual = mime === '' || /json|text|javascript|x-www-form-urlencoded/.test(mime);
    if (!jsonMime && (!apiCall || !textual)) return;
    const view = this.view;
    if (view === null || view.webContents.isDestroyed()) return;
    try {
      const response = (await view.webContents.debugger.sendCommand('Network.getResponseBody', {
        requestId,
      })) as { body?: string; base64Encoded?: boolean };
      if (typeof response.body !== 'string') return;
      const text =
        response.base64Encoded === true
          ? Buffer.from(response.body, 'base64').toString('utf8')
          : response.body;
      const body = sanitizeJsonBody(text, MAX_BODY_CHARS);
      if (body === null || this.view !== view) return;
      const updated = this.buffer?.setResponseBody(storeId, body) ?? null;
      if (updated === null) return;
      this.dirty.add(updated.id);
      this.recordInspectionRequest(updated);
      this.scheduleFlush();
    } catch (error) {
      this.log.debug('No se pudo leer el cuerpo JSON de la respuesta', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onLoadingFailed(params: CdpLoadingFailed): void {
    const current = this.pending.get(params.requestId);
    if (current === undefined || this.buffer === null) return;
    const reason = params.canceled === true ? 'Cancelada' : (params.errorText ?? 'Fallo de red');
    const failed = this.buffer.fail(
      current.storeId,
      reason,
      (params.timestamp - current.startedAt) * 1000,
    );
    this.pending.delete(params.requestId);
    this.redirects.delete(params.requestId);
    if (failed !== null) {
      this.dirty.add(failed.id);
      this.recordRequestActivity(failed);
      this.recordInspectionRequest(failed);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushRequests();
    }, FLUSH_INTERVAL_MS);
  }

  private flushRequests(): void {
    const buffer = this.buffer;
    if (buffer !== null && this.dirty.size > 0) {
      const requests: CapturedRequest[] = [];
      for (const id of this.dirty) {
        const request = buffer.get(id);
        if (request !== null) requests.push(request);
      }
      this.dirty.clear();
      this.state = { ...this.state, requestCount: buffer.count };
      if (requests.length > 0) {
        this.send({ type: 'requests', requests, requestCount: buffer.count });
        this.markFlowDirty();
      }
    }
    this.flushActivity();
  }

  private flushActivity(): void {
    if (this.pendingActivity.length === 0) return;
    const activity = this.pendingActivity.splice(0, this.pendingActivity.length);
    this.send({ type: 'activity', activity });
  }

  private recordActivity(input: ActivityInput): void {
    const at = Date.now();
    const rawDetail =
      input.detail === undefined || input.detail === null
        ? null
        : input.detail.replace(/\s+/g, ' ').trim();
    const event: ActivityEvent = {
      id: `act-${String(at)}-${String(++this.activitySequence)}`,
      at,
      category: input.category,
      tone: input.tone ?? 'info',
      title: shorten(input.title, 180),
      detail:
        rawDetail === null || rawDetail === '' ? null : shorten(rawDetail, MAX_ACTIVITY_DETAIL),
      method: input.method ?? null,
      path: input.path ?? null,
      file: input.file ?? null,
      line: input.line ?? null,
    };
    this.activity.push(event);
    this.pendingActivity.push(event);
    this.scheduleFlush();
  }

  private clearActivity(): void {
    this.activity = [];
    this.pendingActivity = [];
    this.runtimeSqlActivitySeen.clear();
    this.send({ type: 'activity-cleared' });
  }

  private applyBounds(): void {
    const window = this.window ?? this.getWindow();
    if (this.view === null || window === null || window.isDestroyed()) return;
    const content = window.getContentBounds();
    const x = Math.max(0, Math.min(this.bounds.x, content.width));
    const y = Math.max(0, Math.min(this.bounds.y, content.height));
    const width = Math.max(0, Math.min(this.bounds.width, content.width - x));
    const height = Math.max(0, Math.min(this.bounds.height, content.height - y));
    this.applyHostLayout(x, y, width, height, this.bounds.visible && width > 0 && height > 0);
  }

  private syncCount(): void {
    if (this.buffer !== null) {
      this.state = { ...this.state, requestCount: this.buffer.count };
    }
  }

  private sendChromeState(): void {
    const window = this.chromeWindow;
    const view = this.view;
    if (
      window === null ||
      window.isDestroyed() ||
      !this.chromeReady ||
      view === null ||
      view.webContents.isDestroyed()
    ) {
      return;
    }
    const contents = view.webContents;
    const rawUrl = contents.getURL();
    const url =
      rawUrl !== '' && rawUrl !== 'about:blank' ? rawUrl : (this.state.config?.frontend.url ?? '');
    const chromeState: BrowserChromeState = {
      url,
      title: this.state.title ?? '',
      loading: this.state.loading,
      captureActive: this.state.captureActive,
      inspectionEnabled: this.state.inspectionEnabled,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      message: this.state.error,
    };
    window.webContents.send(BROWSER_CHROME_CHANNELS.state, chromeState);
  }

  private emitState(): void {
    this.send({ type: 'state', state: { ...this.state } });
    this.sendChromeState();
  }

  private send(event: BrowserEvent): void {
    const window = this.window ?? this.getWindow();
    if (window === null || window.isDestroyed()) return;
    const contents = window.webContents;
    if (contents.isDestroyed()) return;
    contents.send(IPC_CHANNELS.browserEvent, event);
  }

  private teardownConnection(): void {
    this.resetFlow();
    this.mapWindow.close();
    this.dismissCard();
    this.inspectionSession = null;
    this.hoverProvenanceCache = null;
    this.lastRuntimeStatus = null;
    this.clearActivity();
    this.activitySequence = 0;
    this.sqlRuntimeSequence = 0;

    const runtime = this.runtime;
    this.runtime = null;
    runtime?.dispose();
    this.panelRuntime = { ...OFF_RUNTIME };

    const frontendLauncher = this.frontendLauncher;
    this.frontendLauncher = null;
    frontendLauncher?.stop();
    const backendLauncher = this.backendLauncher;
    this.backendLauncher = null;
    backendLauncher?.stop();

    const inspector = this.inspector;
    this.inspector = null;
    inspector?.dispose();

    const view = this.view;
    this.view = null;
    const panelView = this.panelView;
    this.panelView = null;
    this.buffer = null;
    this.pending.clear();
    this.redirects.clear();
    this.dirty.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const chromeWindow = this.chromeWindow;
    this.chromeWindow = null;
    this.chromeReady = false;
    const host = chromeWindow ?? this.window ?? this.getWindow();

    if (panelView !== null) {
      if (host !== null && !host.isDestroyed()) {
        try {
          host.contentView.removeChildView(panelView);
        } catch {
          this.log.warn('No se pudo retirar el panel de inspección');
        }
      }
      this.panel.dispose();
    }

    if (view !== null) {
      try {
        if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
      } catch {
        this.log.warn('No se pudo desadjuntar el depurador CDP');
      }
      if (host !== null && !host.isDestroyed()) {
        try {
          host.contentView.removeChildView(view);
        } catch {
          this.log.warn('No se pudo retirar la vista del navegador');
        }
      }
      try {
        if (!view.webContents.isDestroyed()) {
          view.webContents.close({ waitForBeforeUnload: false });
        }
      } catch {
        this.log.warn('No se pudo cerrar la vista del navegador');
      }
    }

    if (chromeWindow !== null && !chromeWindow.isDestroyed()) {
      chromeWindow.destroy();
    }
  }
}
