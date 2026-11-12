import type { Debugger as CdpDebugger } from 'electron';
import {
  emptySecurityReport,
  type BrowserConfig,
  type CapturedRequest,
  type SecurityCategory,
  type SecurityFinding,
  type SecurityScanReport,
  type SecuritySeverity,
  type SecuritySource,
} from '@bdt/protocol';
import type { Logger } from '../logger';

const MAX_EVIDENCE_CHARS = 240;
const SCRIPT_CONCURRENCY = 6;
const STYLE_WAIT_MS = 160;
const SCAN_SLICE_MS = 8;

const PRIVATE_IPV4 =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/;

const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'`<>\\]+/gi;
const BARE_PRIVATE_HOST =
  /\b(?:(?:10|127)\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}(?::\d{2,5})?\b/g;
const BARE_LOCALHOST = /\blocalhost:(\d{2,5})\b/gi;
const NAMESPACE_HOSTS = new Set([
  'www.w3.org',
  'w3.org',
  'schemas.xmlsoap.org',
  'ns.adobe.com',
  'purl.org',
  'xmlns.com',
  'json-schema.org',
  'schemas.microsoft.com',
]);

const SECRET_PATTERNS: readonly {
  kind: string;
  severity: SecuritySeverity;
  marker: string;
  pattern: RegExp;
}[] = [
  {
    kind: 'Stripe',
    severity: 'critical',
    marker: 'sk_',
    pattern: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  { kind: 'AWS', severity: 'critical', marker: 'AKIA', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: 'GitHub',
    severity: 'critical',
    marker: 'gh',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: 'GitLab',
    severity: 'critical',
    marker: 'glpat-',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: 'Google',
    severity: 'critical',
    marker: 'AIza',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    kind: 'clave privada',
    severity: 'critical',
    marker: 'PRIVATE KEY',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    kind: 'JWT',
    severity: 'high',
    marker: 'eyJ',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

const GENERIC_SECRET =
  /(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[:=]\s*(['"`])([^'"`\s]{8,})\2/gi;

const GENERIC_SECRET_HINT = /(?:api|key|secret|passw|token)/i;

const DOM_SINKS: readonly {
  id: string;
  label: string;
  severity: SecuritySeverity;
  marker: string;
  pattern: RegExp;
}[] = [
  {
    id: 'eval',
    label: 'eval()',
    severity: 'high',
    marker: 'eval',
    pattern: /(^|[^.\w$])eval\s*\(/g,
  },
  {
    id: 'new-function',
    label: 'new Function()',
    severity: 'high',
    marker: 'Function',
    pattern: /\bnew\s+Function\s*\(/g,
  },
  {
    id: 'innerhtml',
    label: 'innerHTML',
    severity: 'medium',
    marker: 'innerHTML',
    pattern: /\.innerHTML\s*=/g,
  },
  {
    id: 'outerhtml',
    label: 'outerHTML',
    severity: 'medium',
    marker: 'outerHTML',
    pattern: /\.outerHTML\s*=/g,
  },
  {
    id: 'insertadjacenthtml',
    label: 'insertAdjacentHTML()',
    severity: 'medium',
    marker: 'insertAdjacentHTML',
    pattern: /\.insertAdjacentHTML\s*\(/g,
  },
  {
    id: 'document-write',
    label: 'document.write()',
    severity: 'medium',
    marker: 'document.write',
    pattern: /document\.write(?:ln)?\s*\(/g,
  },
  {
    id: 'dangerously-set-inner-html',
    label: 'dangerouslySetInnerHTML',
    severity: 'medium',
    marker: 'dangerouslySetInnerHTML',
    pattern: /dangerouslySetInnerHTML/g,
  },
];

const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface ScanSource {
  kind: 'html' | 'css' | 'js';
  url: string | null;
  text: string;
  locatable: boolean;
  firstParty: boolean;
}

interface ScanContext {
  pageUrl: string | null;
  pageHost: string | null;
  pagePort: number | null;
  backendHost: string | null;
  backendPort: number | null;
}

interface EndpointRef {
  host: string;
  port: number | null;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function findingId(
  category: SecurityCategory,
  evidence: string,
  url: string | null,
  line: number | null,
): string {
  return `security:${category}:${hashText(`${evidence}\u0001${url ?? ''}\u0001${String(line)}`)}`;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: index - (starts[low] ?? 0) + 1 };
}

function clipEvidence(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_EVIDENCE_CHARS
    ? `${collapsed.slice(0, MAX_EVIDENCE_CHARS)} …`
    : collapsed;
}

function isPrivateIp(host: string): boolean {
  return PRIVATE_IPV4.test(host);
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isPrivateHost(host: string): boolean {
  return isPrivateIp(host) || isLoopbackHost(host) || host.endsWith('.local');
}

function isVendorScript(url: string): boolean {
  if (url === '') return false;
  const lower = url.toLowerCase();
  return lower.includes('/node_modules/') || lower.includes('/.vite/deps/');
}

function cleanHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function endpointFromUrl(value: string): EndpointRef | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const fallback = url.protocol === 'https:' ? 443 : 80;
    const port = url.port === '' ? fallback : Number(url.port);
    return {
      host: cleanHost(url.hostname),
      port: Number.isFinite(port) ? port : fallback,
    };
  } catch {
    return null;
  }
}

function endpointFromBare(value: string): EndpointRef {
  const colon = value.lastIndexOf(':');
  if (colon === -1) return { host: cleanHost(value), port: null };
  return {
    host: cleanHost(value.slice(0, colon)),
    port: Number(value.slice(colon + 1)),
  };
}

function sameBackend(endpoint: EndpointRef, context: ScanContext): boolean {
  if (context.backendHost === null) return false;
  if (endpoint.host !== context.backendHost) return false;
  if (endpoint.port === null || context.backendPort === null) return true;
  return endpoint.port === context.backendPort;
}

function exposureSeverity(endpoint: EndpointRef, context: ScanContext): SecuritySeverity | null {
  const host = endpoint.host;
  const samePageHost = context.pageHost !== null && host === context.pageHost;
  const samePagePort =
    endpoint.port === null || context.pagePort === null || endpoint.port === context.pagePort;
  if (samePageHost && samePagePort) return null;
  if (sameBackend(endpoint, context)) return 'critical';
  if (isPrivateIp(host)) return 'critical';
  if (isLoopbackHost(host))
    return endpoint.port !== null && endpoint.port !== context.pagePort ? 'high' : null;
  if (host.endsWith('.local')) return 'high';
  return null;
}

function exposureDetail(
  endpoint: EndpointRef,
  severity: SecuritySeverity,
  context: ScanContext,
  source: SecuritySource,
): string {
  const target = `${endpoint.host}${endpoint.port === null ? '' : `:${String(endpoint.port)}`}`;
  const sourceLabel =
    source === 'html'
      ? 'HTML'
      : source === 'css'
        ? 'CSS'
        : source === 'js'
          ? 'JavaScript'
          : 'petición';
  if (sameBackend(endpoint, context)) {
    return `El ${sourceLabel} entregado al navegador incluye la dirección directa del backend (${target}). El cliente debería usar el proxy o el dominio público del frontend, no el host interno.`;
  }
  if (severity === 'critical') {
    return `El ${sourceLabel} contiene una dirección interna (${target}). Cualquier usuario puede leer la topología de la red y llamar al servidor sin pasar por el frontend.`;
  }
  return `El ${sourceLabel} contiene la dirección ${target}, que no coincide con el origen de la página. Revisa si debe ser pública o resolverse mediante el proxy del frontend.`;
}

function exposureTitle(
  endpoint: EndpointRef,
  severity: SecuritySeverity,
  context: ScanContext,
): string {
  if (sameBackend(endpoint, context)) return 'Host del backend en el cliente';
  if (isPrivateIp(endpoint.host)) return 'IP privada expuesta en el cliente';
  if (isLoopbackHost(endpoint.host)) return 'Servicio local expuesto en el cliente';
  if (endpoint.host.endsWith('.local')) return 'Host interno expuesto en el cliente';
  return severity === 'critical'
    ? 'Servidor expuesto en el cliente'
    : 'Endpoint interno en el cliente';
}

function makeFinding(input: {
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
  redacted?: boolean;
  note?: string | null;
}): SecurityFinding {
  return {
    id: findingId(input.category, input.evidence, input.url, input.line),
    category: input.category,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    evidence: clipEvidence(input.evidence),
    source: input.source,
    url: input.url,
    file: input.file,
    line: input.line,
    column: input.column,
    host: input.host,
    redacted: input.redacted ?? false,
    note: input.note ?? null,
  };
}

function scanEndpoints(
  source: ScanSource,
  starts: readonly number[],
  context: ScanContext,
  findings: Map<string, SecurityFinding>,
): void {
  const seen = new Set<string>();
  const sourceKey = `${source.kind}:${source.url ?? context.pageUrl ?? ''}`;
  const add = (endpoint: EndpointRef, index: number, evidence: string): void => {
    const severity = exposureSeverity(endpoint, context);
    if (severity === null) return;
    const hostKey = `${endpoint.host}:${endpoint.port === null ? '' : String(endpoint.port)}`;
    const dedupeKey = `${sourceKey}:${hostKey}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const position = positionAt(starts, index);
    const locatable = source.locatable && source.url !== null;
    const finding = makeFinding({
      category: 'server-exposure',
      severity,
      title: exposureTitle(endpoint, severity, context),
      detail: exposureDetail(endpoint, severity, context, source.kind),
      evidence,
      source: source.kind,
      url: source.url ?? context.pageUrl,
      file: locatable ? source.url : null,
      line: locatable ? position.line : null,
      column: locatable ? position.column : null,
      host: hostKey,
      note:
        source.kind === 'html'
          ? 'Ubicación en el DOM serializado; no es una línea del archivo fuente.'
          : locatable
            ? null
            : 'La referencia está en código servido; su archivo fuente puede no coincidir con la línea.',
    });
    findings.set(finding.id, finding);
  };

  for (const match of source.text.matchAll(ABSOLUTE_URL)) {
    const raw = match[0];
    if (raw === undefined) continue;
    const trimmed = raw.replace(/[.,;:!?]+$/g, '');
    const endpoint = endpointFromUrl(trimmed);
    if (endpoint === null) continue;
    if (NAMESPACE_HOSTS.has(endpoint.host)) continue;
    add(endpoint, match.index ?? 0, trimmed);
    if (
      trimmed.startsWith('http://') &&
      !isPrivateHost(endpoint.host) &&
      !(context.pageHost !== null && endpoint.host === context.pageHost)
    ) {
      const position = positionAt(starts, match.index ?? 0);
      const locatable = source.locatable && source.url !== null;
      const finding = makeFinding({
        category: 'insecure-transport',
        severity: 'medium',
        title: 'Endpoint HTTP sin cifrar',
        detail: `El ${source.kind.toUpperCase()} del cliente referencia ${endpoint.host} por HTTP. El tráfico y las credenciales viajan sin cifrar.`,
        evidence: trimmed,
        source: source.kind,
        url: source.url ?? context.pageUrl,
        file: locatable ? source.url : null,
        line: locatable ? position.line : null,
        column: locatable ? position.column : null,
        host: endpoint.host,
        note: null,
      });
      findings.set(finding.id, finding);
    }
  }

  for (const match of source.text.matchAll(BARE_PRIVATE_HOST)) {
    const raw = match[0];
    if (raw === undefined) continue;
    add(endpointFromBare(raw), match.index ?? 0, raw);
  }

  for (const match of source.text.matchAll(BARE_LOCALHOST)) {
    const raw = match[0];
    const port = match[1];
    if (raw === undefined || port === undefined) continue;
    const numeric = Number(port);
    if (!Number.isFinite(numeric)) continue;
    if (context.pagePort !== null && numeric === context.pagePort) continue;
    add({ host: 'localhost', port: numeric }, match.index ?? 0, raw);
  }
}

function redactSecret(value: string): string {
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

function secretFinding(
  source: ScanSource,
  starts: readonly number[],
  index: number,
  kind: string,
  severity: SecuritySeverity,
  value: string,
  context: ScanContext,
): SecurityFinding {
  const position = positionAt(starts, index);
  const locatable = source.locatable && source.url !== null;
  return makeFinding({
    category: 'secret',
    severity,
    title: `Posible ${kind} en el cliente`,
    detail: `El ${source.kind === 'js' ? 'JavaScript' : source.kind.toUpperCase()} entregado al navegador contiene un valor con forma de ${kind}. Cualquier usuario puede extraerlo desde las herramientas del navegador.`,
    evidence: `Valor enmascarado: ${redactSecret(value)}`,
    source: source.kind,
    url: source.url ?? context.pageUrl,
    file: locatable ? source.url : null,
    line: locatable ? position.line : null,
    column: locatable ? position.column : null,
    host: null,
    redacted: true,
    note: locatable
      ? null
      : 'La coincidencia está en código servido o en un fragmento en línea; la línea puede no corresponder al archivo fuente.',
  });
}

function scanSecrets(
  source: ScanSource,
  starts: readonly number[],
  context: ScanContext,
  findings: Map<string, SecurityFinding>,
): void {
  if (source.kind === 'css') return;
  const text = source.text;
  for (const entry of SECRET_PATTERNS) {
    if (text.indexOf(entry.marker) === -1) continue;
    entry.pattern.lastIndex = 0;
    for (const match of text.matchAll(entry.pattern)) {
      const value = match[0];
      if (value === undefined) continue;
      const finding = secretFinding(
        source,
        starts,
        match.index ?? 0,
        entry.kind,
        entry.severity,
        value,
        context,
      );
      findings.set(`${finding.id}:${hashText(value)}`, finding);
    }
  }
  if (!source.firstParty) return;
  if (!GENERIC_SECRET_HINT.test(text)) return;
  GENERIC_SECRET.lastIndex = 0;
  for (const match of text.matchAll(GENERIC_SECRET)) {
    const name = match[1] ?? 'secreto';
    const value = match[3];
    if (value === undefined) continue;
    if (
      /^(?:password|changeme|example|your[-_]|xxx+|\*+|null|undefined|true|false|localhost)$/i.test(
        value,
      )
    ) {
      continue;
    }
    if (value.includes('${') || value.startsWith('process.')) continue;
    const finding = secretFinding(
      source,
      starts,
      match.index ?? 0,
      `credencial (${name})`,
      'high',
      value,
      context,
    );
    findings.set(`${finding.id}:${hashText(value)}`, finding);
  }
}

function scanSinks(
  source: ScanSource,
  starts: readonly number[],
  context: ScanContext,
  findings: Map<string, SecurityFinding>,
): void {
  if (source.kind !== 'js' || !source.firstParty) return;
  for (const sink of DOM_SINKS) {
    if (source.text.indexOf(sink.marker) === -1) continue;
    sink.pattern.lastIndex = 0;
    const match = sink.pattern.exec(source.text);
    if (match === null) continue;
    const position = positionAt(starts, match.index);
    const lineEnd = source.text.indexOf('\n', match.index);
    const snippet = source.text.slice(match.index, lineEnd === -1 ? undefined : lineEnd);
    const locatable = source.locatable && source.url !== null;
    const finding = makeFinding({
      category: 'dom-sink',
      severity: sink.severity,
      title: `Uso de ${sink.label} en código propio`,
      detail: `El código del cliente usa ${sink.label}. Si recibe datos de usuarios o de la red sin sanear, permite inyectar HTML o ejecutar código.`,
      evidence: snippet,
      source: 'js',
      url: source.url ?? context.pageUrl,
      file: locatable ? source.url : null,
      line: locatable ? position.line : null,
      column: locatable ? position.column : null,
      host: null,
      note: 'Detección textual; requiere revisar si el valor llega de una fuente no confiable.',
    });
    findings.set(`${finding.id}:${sink.id}`, finding);
  }
}

function scanRequestFindings(
  requests: readonly CapturedRequest[],
  context: ScanContext,
  findings: Map<string, SecurityFinding>,
): void {
  for (const request of requests) {
    const endpoint = endpointFromUrl(request.url);
    if (endpoint === null) continue;
    const backend = sameBackend(endpoint, context);
    if (!backend && !isPrivateIp(endpoint.host)) continue;
    const samePageEndpoint =
      context.pageHost !== null &&
      endpoint.host === context.pageHost &&
      (endpoint.port === null || context.pagePort === null || endpoint.port === context.pagePort);
    if (samePageEndpoint) continue;
    const severity: SecuritySeverity = backend ? 'high' : 'critical';
    const frame = request.initiator?.frames[0];
    const finding = makeFinding({
      category: 'server-exposure',
      severity,
      title: 'Petición directa a un host interno',
      detail: sameBackend(endpoint, context)
        ? 'La página llama directamente a la dirección del backend. En desarrollo es habitual, pero en producción deja el servidor expuesto fuera del proxy del frontend.'
        : 'La página llama directamente a una IP privada. Cualquier usuario puede leer la topología y repetir la petición sin pasar por el frontend.',
      evidence: `${request.method} ${request.url}`,
      source: 'request',
      url: request.url,
      file: frame?.url ?? null,
      line: frame?.line ?? null,
      column: frame?.column ?? null,
      host: `${endpoint.host}${endpoint.port === null ? '' : `:${String(endpoint.port)}`}`,
      note:
        frame === undefined
          ? 'Sin pila de origen capturada.'
          : `Iniciada por ${frame.functionName ?? 'una función sin nombre'} en ${frame.url}:${String(frame.line)}.`,
    });
    findings.set(finding.id, finding);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function buildSecurityFindings(input: {
  sources: readonly ScanSource[];
  requests: readonly CapturedRequest[];
  pageUrl: string | null;
  config: BrowserConfig | null;
}): Promise<SecurityFinding[]> {
  const actualPage = input.pageUrl === null ? null : endpointFromUrl(input.pageUrl);
  const context: ScanContext = {
    pageUrl: input.pageUrl,
    pageHost:
      actualPage?.host ?? (input.config === null ? null : cleanHost(input.config.frontend.host)),
    pagePort: actualPage?.port ?? (input.config === null ? null : input.config.frontend.port),
    backendHost: input.config === null ? null : cleanHost(input.config.backend.host),
    backendPort: input.config === null ? null : input.config.backend.port,
  };
  const findings = new Map<string, SecurityFinding>();
  let sliceStarted = Date.now();
  for (const source of input.sources) {
    if (source.text.trim() === '') continue;
    const starts = lineStarts(source.text);
    scanEndpoints(source, starts, context, findings);
    scanSecrets(source, starts, context, findings);
    scanSinks(source, starts, context, findings);
    if (Date.now() - sliceStarted >= SCAN_SLICE_MS) {
      await yieldToEventLoop();
      sliceStarted = Date.now();
    }
  }
  scanRequestFindings(input.requests, context, findings);
  return [...findings.values()].sort((left, right) => {
    const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (severity !== 0) return severity;
    const category = left.category.localeCompare(right.category);
    if (category !== 0) return category;
    return left.title.localeCompare(right.title);
  });
}

const PAGE_CONTENT_EXPRESSION = String.raw`(() => {
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const sheets = [];
  let list = [];
  try { list = Array.from(document.styleSheets); } catch (error) { list = []; }
  for (const sheet of list) {
    let text = null;
    try {
      const rules = sheet.cssRules;
      text = rules ? Array.from(rules).map((rule) => rule.cssText).join('\n') : '';
    } catch (error) {
      text = null;
    }
    sheets.push({ href: sheet.href, text });
  }
  return JSON.stringify({ html, sheets });
})()`;

interface StyleSheetHeader {
  url: string | null;
}

export class SecurityScanner {
  private readonly scripts = new Map<string, string>();
  private readonly styleSheets = new Map<string, StyleSheetHeader>();
  private report: SecurityScanReport = emptySecurityReport();
  private active: Promise<SecurityScanReport> | null = null;
  private epoch = 0;

  constructor(
    private readonly log: Logger,
    private readonly isFirstParty: (url: string) => boolean,
  ) {}

  current(): SecurityScanReport {
    return this.report;
  }

  reset(): SecurityScanReport {
    this.epoch += 1;
    this.scripts.clear();
    this.styleSheets.clear();
    this.report = emptySecurityReport();
    return this.report;
  }

  markStale(): void {
    this.epoch += 1;
    this.report = emptySecurityReport();
  }

  handleMessage(method: string, params: unknown): void {
    if (method === 'Debugger.scriptParsed') {
      const record = params as {
        scriptId?: unknown;
        url?: unknown;
      };
      if (typeof record.scriptId !== 'string') return;
      this.scripts.set(record.scriptId, typeof record.url === 'string' ? record.url : '');
      return;
    }
    if (method === 'Debugger.globalObjectCleared') {
      this.scripts.clear();
      return;
    }
    if (method === 'CSS.styleSheetAdded') {
      const record = params as { header?: { styleSheetId?: unknown; sourceURL?: unknown } };
      const id = record.header?.styleSheetId;
      if (typeof id !== 'string') return;
      const url = typeof record.header?.sourceURL === 'string' ? record.header.sourceURL : '';
      this.styleSheets.set(id, { url: url === '' ? null : url });
      return;
    }
    if (method === 'CSS.styleSheetRemoved') {
      const record = params as { styleSheetId?: unknown };
      if (typeof record.styleSheetId === 'string') this.styleSheets.delete(record.styleSheetId);
    }
  }

  async scan(input: {
    target: CdpDebugger;
    config: BrowserConfig | null;
    pageUrl: string | null;
    requests: readonly CapturedRequest[];
  }): Promise<SecurityScanReport> {
    while (this.active !== null) {
      await this.active;
    }
    const run = this.runScan(input);
    this.active = run;
    try {
      return await run;
    } finally {
      if (this.active === run) this.active = null;
    }
  }

  private async runScan(input: {
    target: CdpDebugger;
    config: BrowserConfig | null;
    pageUrl: string | null;
    requests: readonly CapturedRequest[];
  }): Promise<SecurityScanReport> {
    const epoch = this.epoch;
    this.report = { ...this.report, status: 'scanning', error: null };
    try {
      const html = await this.pageHtml(input.target);
      const styleSources = await this.collectStyleSheets(input.target, html.fallbackSheets);
      const scriptSources = await this.collectScripts(input.target);
      const sources: ScanSource[] = [
        {
          kind: 'html',
          url: input.pageUrl,
          text: html.html,
          locatable: false,
          firstParty: true,
        },
        ...styleSources,
        ...scriptSources,
      ];
      const findings = await buildSecurityFindings({
        sources,
        requests: input.requests,
        pageUrl: input.pageUrl,
        config: input.config,
      });
      if (epoch !== this.epoch) return this.report;
      this.report = {
        status: 'done',
        scannedAt: Date.now(),
        pageUrl: input.pageUrl,
        error: null,
        findings,
        scripts: scriptSources.length,
        styleSheets: styleSources.length,
        requests: input.requests.length,
      };
    } catch (error) {
      if (epoch !== this.epoch) return this.report;
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('No se pudo completar el análisis de seguridad', { message });
      this.report = {
        ...this.report,
        status: 'error',
        scannedAt: Date.now(),
        error: message,
      };
    }
    return this.report;
  }

  private async pageHtml(target: CdpDebugger): Promise<{
    html: string;
    fallbackSheets: Array<{ href: string | null; text: string | null }>;
  }> {
    try {
      const response = (await target.sendCommand('Runtime.evaluate', {
        expression: PAGE_CONTENT_EXPRESSION,
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      const value = response.result?.value;
      if (typeof value !== 'string') return { html: '', fallbackSheets: [] };
      const parsed = JSON.parse(value) as {
        html?: unknown;
        sheets?: unknown;
      };
      const html = typeof parsed.html === 'string' ? parsed.html : '';
      const sheets: Array<{ href: string | null; text: string | null }> = [];
      if (Array.isArray(parsed.sheets)) {
        for (const entry of parsed.sheets) {
          if (entry === null || typeof entry !== 'object') continue;
          const record = entry as { href?: unknown; text?: unknown };
          sheets.push({
            href: typeof record.href === 'string' ? record.href : null,
            text: typeof record.text === 'string' ? record.text : null,
          });
        }
      }
      return { html, fallbackSheets: sheets };
    } catch (error) {
      this.log.debug('No se pudo leer el HTML de la página para el análisis', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { html: '', fallbackSheets: [] };
    }
  }

  private async collectStyleSheets(
    target: CdpDebugger,
    fallback: readonly { href: string | null; text: string | null }[],
  ): Promise<ScanSource[]> {
    const sources: ScanSource[] = [];
    try {
      await target.sendCommand('CSS.disable').catch(() => undefined);
      this.styleSheets.clear();
      await target.sendCommand('DOM.enable').catch(() => undefined);
      await target.sendCommand('CSS.enable');
      await new Promise((resolve) => setTimeout(resolve, STYLE_WAIT_MS));
      const entries = [...this.styleSheets.entries()];
      for (const [styleSheetId, header] of entries) {
        try {
          const response = (await target.sendCommand('CSS.getStyleSheetText', {
            styleSheetId,
          })) as { text?: unknown };
          const text = typeof response.text === 'string' ? response.text : '';
          if (text.trim() === '') continue;
          const url = header.url;
          sources.push({
            kind: 'css',
            url,
            text,
            locatable: url !== null && this.isFirstParty(url),
            firstParty: url !== null && this.isFirstParty(url),
          });
        } catch (error) {
          this.log.debug('No se pudo leer una hoja de estilos para el análisis', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.log.debug('El dominio CSS no está disponible; se usa el contenido accesible', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // El dominio CSS mantiene trabajo de estilo en la página; se apaga al terminar.
      await target.sendCommand('CSS.disable').catch(() => undefined);
    }
    if (sources.length > 0) return sources;
    for (const entry of fallback) {
      if (entry.text === null || entry.text.trim() === '') continue;
      const url = entry.href;
      sources.push({
        kind: 'css',
        url,
        text: entry.text,
        locatable: url !== null && this.isFirstParty(url),
        firstParty: url !== null && this.isFirstParty(url),
      });
    }
    return sources;
  }

  private async collectScripts(target: CdpDebugger): Promise<ScanSource[]> {
    const entries = [...this.scripts.entries()];
    const sources: ScanSource[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor];
        cursor += 1;
        if (entry === undefined) return;
        const [scriptId, url] = entry;
        if (
          url.startsWith('chrome-extension://') ||
          url.startsWith('devtools://') ||
          url.startsWith('extensions::') ||
          url.startsWith('wasm://')
        ) {
          continue;
        }
        // Escanear dependencias de terceros consume segundos y no es código propio.
        if (isVendorScript(url)) continue;
        try {
          const response = (await target.sendCommand('Debugger.getScriptSource', {
            scriptId,
          })) as { scriptSource?: unknown };
          const text = typeof response.scriptSource === 'string' ? response.scriptSource : '';
          if (text.trim() === '') continue;
          const external = url.startsWith('http://') || url.startsWith('https://');
          const fileUrl = external && this.isFirstParty(url) ? url : null;
          sources.push({
            kind: 'js',
            url: external ? url : null,
            text,
            locatable: fileUrl !== null,
            firstParty: url === '' || fileUrl !== null,
          });
        } catch (error) {
          this.log.debug('No se pudo leer un script para el análisis', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SCRIPT_CONCURRENCY, Math.max(1, entries.length)) }, worker),
    );
    return sources;
  }
}
