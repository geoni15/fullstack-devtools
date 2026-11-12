export interface BrowserEndpoint {
  url: string;
  origin: string;
  host: string;
  port: number;
}

export type BrowserMode = 'window' | 'embedded';

export interface LaunchRequest {
  command: string;
  cwd: string;
}

export type BackendLaunchRequest = LaunchRequest;

export interface BackendLaunchConfig extends LaunchRequest {
  pid: number | null;
  inspectorPort: number | null;
}

export interface BrowserConfig {
  frontend: BrowserEndpoint;
  backend: BrowserEndpoint;
  mode: BrowserMode;
  nodeInspectorPort: number | null;
  frontendLaunch: BackendLaunchConfig | null;
  backendLaunch: BackendLaunchConfig | null;
}

export interface BrowserTargetsRequest {
  frontendUrl: string;
  backendUrl: string;
  mode: BrowserMode;
  nodeInspectorPort: number | null;
  frontendLaunch?: LaunchRequest | null;
  backendLaunch: BackendLaunchRequest | null;
}

export interface DetectedAppSetup {
  role: 'frontend' | 'backend';
  dir: string;
  packageName: string | null;
  framework: string | null;
  scriptName: string | null;
  scriptCommand: string | null;
  launchCommand: string | null;
  launchCwd: string;
  port: number | null;
  evidence: string[];
}

export interface ProjectSetupDetection {
  frontend: DetectedAppSetup | null;
  backend: DetectedAppSetup | null;
  packageCount: number;
  detectedAt: number;
}

export interface BrowserState {
  config: BrowserConfig | null;
  connected: boolean;
  currentUrl: string | null;
  title: string | null;
  loading: boolean;
  captureActive: boolean;
  inspectionEnabled: boolean;
  requestCount: number;
  error: string | null;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export type RequestOrigin = 'backend' | 'frontend' | 'external';

export type RequestOutcome = 'pending' | 'finished' | 'failed';

export interface InitiatorFrame {
  functionName: string | null;
  url: string;
  line: number;
  column: number;
}

export interface RequestInitiator {
  type: string;
  frames: InitiatorFrame[];
  async: boolean;
  mapped: boolean;
}

export interface CapturedBody {
  text: string;
  truncated: boolean;
}

export interface CapturedRequest {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  resourceType: string;
  origin: RequestOrigin;
  outcome: RequestOutcome;
  statusCode: number | null;
  mimeType: string | null;
  startedAt: number;
  wallStartedAt: number;
  durationMs: number | null;
  error: string | null;
  initiator: RequestInitiator | null;
  headers: Record<string, string>;
  requestBody: CapturedBody | null;
  responseBody: CapturedBody | null;
}

export type ActivityCategory = 'frontend' | 'request' | 'backend' | 'sql' | 'json';

export type ActivityTone = 'info' | 'ok' | 'warning' | 'error';

export interface ActivityEvent {
  id: string;
  at: number;
  category: ActivityCategory;
  tone: ActivityTone;
  title: string;
  detail: string | null;
  method: string | null;
  path: string | null;
  file: string | null;
  line: number | null;
}

export type ConsoleSource = 'frontend' | 'backend';

export type ConsoleLevel = 'log' | 'info' | 'debug' | 'warn' | 'error' | 'exception';

export interface ConsoleEntry {
  id: string;
  at: number;
  source: ConsoleSource;
  level: ConsoleLevel;
  text: string;
  url: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low';

export type SecurityCategory = 'server-exposure' | 'insecure-transport' | 'secret' | 'dom-sink';

export type SecuritySource = 'html' | 'css' | 'js' | 'request';

export interface SecurityFinding {
  id: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  evidence: string;
  source: SecuritySource;
  url: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  host: string | null;
  redacted: boolean;
  note: string | null;
}

export type SecurityScanStatus = 'idle' | 'scanning' | 'done' | 'error';

export interface SecurityScanReport {
  status: SecurityScanStatus;
  scannedAt: number | null;
  pageUrl: string | null;
  error: string | null;
  findings: SecurityFinding[];
  scripts: number;
  styleSheets: number;
  requests: number;
}

export function emptySecurityReport(): SecurityScanReport {
  return {
    status: 'idle',
    scannedAt: null,
    pageUrl: null,
    error: null,
    findings: [],
    scripts: 0,
    styleSheets: 0,
    requests: 0,
  };
}

export interface BrowserSnapshot {
  state: BrowserState;
  requests: CapturedRequest[];
  activity: ActivityEvent[];
  consoleEntries: ConsoleEntry[];
  security: SecurityScanReport;
}

export type BrowserEvent =
  | { type: 'state'; state: BrowserState }
  | { type: 'requests'; requests: CapturedRequest[]; requestCount: number }
  | { type: 'requests-cleared' }
  | { type: 'activity'; activity: ActivityEvent[] }
  | { type: 'activity-cleared' }
  | { type: 'console'; entries: ConsoleEntry[] }
  | { type: 'console-cleared' }
  | { type: 'security'; report: SecurityScanReport };

export type InspectionStatus = 'resolving' | 'listening' | 'done';

export interface InspectionElement {
  tag: string;
  text: string | null;
  role: string | null;
  ariaLabel: string | null;
  inputType: string | null;
  submitLike?: boolean;
  key?: string | null;
  selector?: string | null;
  kind?: string | null;
  href?: string | null;
  formAction?: string | null;
  formMethod?: string | null;
  formKey?: string | null;
}

export type HandlerSource = 'listener' | 'react' | 'vue';

export interface HandlerProfile {
  async: boolean;
  await: boolean;
  generator: boolean;
  arrow: boolean;
  tryCatch: boolean;
  params: string | null;
  signature: string | null;
}

export function handlerLabel(
  name: string | null,
  profile: HandlerProfile | null,
  fallback = 'función anónima',
): string {
  if (name !== null && name !== '') return name;
  if (profile !== null && profile.signature !== null && profile.signature !== '') {
    return profile.signature;
  }
  return fallback;
}

export function handlerProfileTags(profile: HandlerProfile | null): string[] {
  if (profile === null) return [];
  const tags: string[] = [];
  if (profile.async) tags.push('async');
  if (profile.await) tags.push('await');
  if (profile.generator) tags.push('generador');
  if (profile.arrow) tags.push('flecha');
  if (profile.tryCatch) tags.push('try/catch');
  return tags;
}

export interface InspectionHandler {
  event: 'click' | 'submit';
  name: string | null;
  url: string | null;
  line: number | null;
  column: number | null;
  source: HandlerSource;
  note: string | null;
  code: InspectionCodeBlock | null;
  profile: HandlerProfile | null;
}

export type InspectionCorrelation = 'direct' | 'heuristic';

export type InspectionRequestPhase = 'background' | 'after-click';

export interface InspectionRequestBackend {
  routePath: string;
  handlerName: string | null;
  file: string;
  line: number;
  routeLine: number;
  framework: string;
  resolved: boolean;
  note: string | null;
}

export interface InspectionRequest {
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
  phase: InspectionRequestPhase;
  backend: InspectionRequestBackend | null;
  requestBody: CapturedBody | null;
  responseBody: CapturedBody | null;
}

export interface InspectionEndpoint {
  method: string;
  path: string;
}

export interface InspectionCodeLine {
  line: number;
  text: string;
}

export interface InspectionCodeBlock {
  file: string;
  startLine: number;
  endLine: number;
  lines: InspectionCodeLine[];
  truncated: boolean;
  note: string | null;
}

export interface InspectionBackend {
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
  code: InspectionCodeBlock | null;
  codeNote: string | null;
}

export type InspectionSqlOperation =
  'select' | 'insert' | 'update' | 'delete' | 'replace' | 'other';

export type InspectionSqlColumnUsage =
  'select' | 'insert' | 'set' | 'where' | 'join' | 'group' | 'order' | 'returning';

export interface InspectionSqlColumn {
  table: string | null;
  name: string;
  usage: InspectionSqlColumnUsage;
}

export type InspectionSqlStatus = 'possible' | 'observed';

export interface InspectionSqlResult {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  observedAt: number;
  driver: string;
}

export interface InspectionSqlQuery {
  id: string;
  status: InspectionSqlStatus;
  operation: InspectionSqlOperation;
  tablesRead: string[];
  tablesWritten: string[];
  columns: InspectionSqlColumn[];
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
  result: InspectionSqlResult | null;
}

export type InspectionRuntimeStatus = 'off' | 'connecting' | 'connected' | 'unavailable';

export interface InspectionRuntime {
  status: InspectionRuntimeStatus;
  port: number | null;
  message: string | null;
}

export interface InspectionBreakpoint {
  method: string;
  path: string;
}

export interface InspectionExecution {
  functionName: string | null;
  file: string;
  line: number;
  column: number;
  observedAt: number;
  breakpoints: InspectionBreakpoint[];
  code: InspectionCodeBlock | null;
  codeNote: string | null;
}

export type InspectionLevel = 'N0' | 'N1' | 'N2';

export type InspectionMode = 'html' | 'frontend' | 'backend' | 'request' | 'database';

export const INSPECTION_MODES: readonly InspectionMode[] = [
  'html',
  'frontend',
  'backend',
  'request',
  'database',
];

export interface InspectionCard {
  id: string;
  status: InspectionStatus;
  createdAt: number;
  element: InspectionElement;
  handler: InspectionHandler | null;
  requests: InspectionRequest[];
  selectedRequestId: string | null;
  endpoint: InspectionEndpoint | null;
  backend: InspectionBackend | null;
  queries: InspectionSqlQuery[];
  execution: InspectionExecution | null;
  evidence: Array<'RUNTIME' | 'STATIC'>;
  level: InspectionLevel;
  note: string | null;
}

export interface InspectionPanelState {
  card: InspectionCard | null;
  runtime: InspectionRuntime;
  inspectionEnabled: boolean;
  mode: InspectionMode;
}

export const BROWSER_CHROME_CHANNELS = {
  ready: 'browser-chrome:ready',
  state: 'browser-chrome:state',
  navigate: 'browser-chrome:navigate',
  back: 'browser-chrome:back',
  forward: 'browser-chrome:forward',
  reload: 'browser-chrome:reload',
  toggleInspection: 'browser-chrome:toggle-inspection',
  toggleHoverTip: 'browser-chrome:toggle-hover-tip',
} as const;

export const BROWSER_PANEL_CHANNELS = {
  ready: 'browser-panel:ready',
  data: 'browser-panel:data',
  selectRequest: 'browser-panel:select-request',
  setMode: 'browser-panel:set-mode',
  map: 'browser-panel:map',
  mapData: 'browser-panel:map-data',
  jsonData: 'browser-panel:json-data',
  highlight: 'browser-panel:highlight',
  shift: 'browser-panel:shift',
  revealLocation: 'browser-panel:reveal-location',
} as const;

export interface BrowserChromeState {
  url: string;
  title: string;
  loading: boolean;
  captureActive: boolean;
  inspectionEnabled: boolean;
  hoverTipPinned: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  message: string | null;
}
