import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  INSPECTION_MODES,
  type CapturedBody,
  type InspectionCard,
  type InspectionCodeBlock,
  type InspectionExecution,
  type InspectionMode,
  type InspectionPanelState,
  type InspectionRequest,
  type InspectionRuntime,
  type InspectionSqlQuery,
} from '@bdt/protocol';
import {
  createHighlightState,
  highlightLine,
  languageForFile,
  type HighlightLanguage,
  type HighlightToken,
} from './highlight';

const MAX_BODY_LINES = 240;

const MODE_HINT: Record<InspectionMode, string> = {
  html: 'Pasa el mouse: etiqueta, tamaño y estilos calculados.',
  frontend: 'Pasa el mouse: handler, componentes y código.',
  backend: 'Pasa el mouse: petición y ruta del backend.',
  request: 'Pasa el mouse: ruta JSON, objeto, petición y funciones.',
  database: 'Pasa el mouse: rutas y SQL estático.',
};

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Falta el elemento ${id} en el panel de inspección.`);
  }
  return found as T;
}

function statusLabel(card: InspectionCard): string {
  switch (card.status) {
    case 'resolving':
      return 'Resolviendo…';
    case 'listening':
      return 'Escuchando…';
    default:
      return card.requests.length === 0
        ? 'Sin peticiones'
        : `${String(card.requests.length)} peticiones`;
  }
}

const PHASE_LABEL: Record<InspectionRequest['phase'], string> = {
  background: 'FONDO',
  'after-click': 'CLIC',
};

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function requestNode(
  request: InspectionRequest,
  selected: boolean,
  select: (id: string) => void,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `request${selected ? ' is-selected' : ''}`;
  button.dataset.requestId = request.id;

  const head = document.createElement('div');
  head.className = 'head';
  const method = document.createElement('span');
  method.className = `method ${request.method.toLowerCase()}`;
  method.textContent = request.method;
  const pathNode = document.createElement('span');
  pathNode.className = 'path';
  pathNode.textContent = request.path;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = clock(request.wallStartedAt);
  const phase = document.createElement('span');
  phase.className = `phase ${request.phase}`;
  phase.textContent = PHASE_LABEL[request.phase];
  const status = document.createElement('span');
  status.className = 'status';
  const code =
    request.statusCode !== null
      ? String(request.statusCode)
      : request.outcome === 'failed'
        ? 'ERR'
        : '…';
  const duration =
    request.durationMs !== null ? `${String(Math.round(request.durationMs))} ms` : '—';
  status.textContent = `${code} · ${duration}`;
  head.append(method, pathNode, time, phase, status);

  const backendLine = document.createElement('div');
  backendLine.className = 'backend-line';
  backendLine.textContent =
    request.backend === null
      ? 'sin ruta'
      : `${request.backend.handlerName ?? 'sin resolver'} · ${request.backend.file}:${String(
          request.backend.line,
        )}`;

  button.append(head, backendLine);
  button.addEventListener('click', () => {
    select(request.id);
  });
  return button;
}

function renderRuntime(runtime: InspectionRuntime): void {
  const status = element('runtime-status');
  status.classList.remove('is-on', 'is-connecting', 'is-warn');
  switch (runtime.status) {
    case 'connected':
      status.textContent = 'INSPECTOR ON';
      status.classList.add('is-on');
      break;
    case 'connecting':
      status.textContent = 'CONECTANDO';
      status.classList.add('is-connecting');
      break;
    case 'unavailable':
      status.textContent = 'SIN INSPECTOR';
      status.classList.add('is-warn');
      break;
    default:
      status.textContent = 'INSPECTOR OFF';
      break;
  }

  const port =
    runtime.status === 'connected' && runtime.port !== null
      ? ` · 127.0.0.1:${String(runtime.port)}`
      : '';
  element('runtime-message').textContent = `${runtime.message ?? ''}${port}`;
}

function isMode(value: string | undefined): value is InspectionMode {
  return value !== undefined && (INSPECTION_MODES as readonly string[]).includes(value);
}

function renderModes(mode: InspectionMode): void {
  document.querySelectorAll<HTMLButtonElement>('.mode').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('is-on', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  element('idle-hint').textContent = `${MODE_HINT[mode]} Haz clic para la tarjeta completa.`;
}

function tokenFragment(tokens: readonly HighlightToken[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const item of tokens) {
    if (item.text === '') continue;
    if (item.kind === null) {
      fragment.append(document.createTextNode(item.text));
    } else {
      const span = document.createElement('span');
      span.className = `tok-${item.kind}`;
      span.textContent = item.text;
      fragment.append(span);
    }
  }
  return fragment;
}

function renderHighlightedText(
  container: HTMLElement,
  text: string,
  language: HighlightLanguage,
  maxLines: number,
): boolean {
  container.replaceChildren();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const state = createHighlightState();
  const count = Math.min(lines.length, maxLines);
  for (let index = 0; index < count; index += 1) {
    if (index > 0) container.append(document.createTextNode('\n'));
    container.append(tokenFragment(highlightLine(lines[index] ?? '', language, state)));
  }
  return lines.length > count;
}

function renderCode(
  container: HTMLElement,
  block: InspectionCodeBlock | null,
  note: string | null,
  highlightLineNumber: number | null,
): void {
  container.replaceChildren();
  if (block === null || block.lines.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'code-note';
    empty.textContent = note ?? block?.note ?? 'Código no disponible.';
    container.append(empty);
    return;
  }

  const language = languageForFile(block.file);
  const state = createHighlightState();
  for (const line of block.lines) {
    const row = document.createElement('div');
    row.className = 'code-line';
    if (highlightLineNumber !== null && line.line === highlightLineNumber) {
      row.classList.add('is-executed');
    }
    const number = document.createElement('span');
    number.className = 'code-number';
    number.textContent = String(line.line);
    const text = document.createElement('span');
    text.className = 'code-text';
    const fragment = tokenFragment(
      highlightLine(line.text === '' ? ' ' : line.text, language, state),
    );
    if (fragment.childNodes.length === 0) {
      text.textContent = ' ';
    } else {
      text.append(fragment);
    }
    row.append(number, text);
    container.append(row);
  }

  const executed = container.querySelector('.is-executed');
  if (executed !== null) {
    executed.scrollIntoView({ block: 'nearest' });
  }
}

function lineRange(code: InspectionCodeBlock): string {
  return code.startLine === code.endLine
    ? `línea ${String(code.startLine)}`
    : `líneas ${String(code.startLine)}–${String(code.endLine)}`;
}

const SQL_OPERATION_LABEL: Record<InspectionSqlQuery['operation'], string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  other: 'SQL',
};

function queryNode(query: InspectionSqlQuery): HTMLElement {
  const container = document.createElement('div');
  container.className = query.status === 'observed' ? 'query is-observed' : 'query';

  const head = document.createElement('div');
  head.className = 'head';
  const operation = document.createElement('span');
  operation.className = 'op';
  operation.textContent = SQL_OPERATION_LABEL[query.operation];
  const state = document.createElement('span');
  state.className = 'state';
  state.textContent = query.status === 'observed' ? 'OBSERVADA' : 'POSIBLE';
  head.append(operation, state);
  container.append(head);

  const sql = document.createElement('div');
  sql.className = 'sql';
  renderHighlightedText(sql, query.sql ?? '', 'sql', 80);
  container.append(sql);

  const parts: string[] = [];
  if (query.tablesRead.length > 0) {
    parts.push(`lee ${query.tablesRead.join(', ')}`);
  }
  if (query.tablesWritten.length > 0) {
    parts.push(`escribe ${query.tablesWritten.join(', ')}`);
  }
  if (query.line > 0) {
    parts.push(`línea ${String(query.line)}`);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = parts.join(' · ');
  container.append(meta);
  return container;
}

function queriesEmptyText(card: InspectionCard): string {
  if (card.backend === null) {
    return card.endpoint !== null ? 'Sin ruta' : 'Sin petición';
  }
  if (!card.backend.resolved) {
    return 'Manejador no resuelto';
  }
  return 'Sin SQL en el manejador';
}

function renderQueries(card: InspectionCard): void {
  const container = element('queries');
  container.replaceChildren();
  const visible = card.queries.filter((query) => query.sql !== null);
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = queriesEmptyText(card);
    container.append(empty);
    return;
  }

  for (const query of visible) {
    container.append(queryNode(query));
  }
}

type SequenceTone = 'normal' | 'ok' | 'error';

interface SequenceStep {
  at: number | null;
  tag: string;
  text: string;
  tone: SequenceTone;
}

function sameBackend(card: InspectionCard, request: InspectionRequest): boolean {
  const cardBackend = card.backend;
  const requestBackend = request.backend;
  if (cardBackend === null || requestBackend === null) return false;
  return cardBackend.file === requestBackend.file && cardBackend.line === requestBackend.line;
}

function requestSteps(card: InspectionCard, request: InspectionRequest): SequenceStep[] {
  const steps: SequenceStep[] = [];
  const start = request.wallStartedAt;
  const end = request.durationMs !== null ? start + request.durationMs : null;
  const backendMatches = sameBackend(card, request);
  const clickSession = start >= card.createdAt - 150;

  if (request.initiatorFunction !== null) {
    steps.push({ at: start, tag: 'FRONTEND', text: request.initiatorFunction, tone: 'normal' });
  }
  steps.push({
    at: start,
    tag: 'HTTP',
    text: `${request.method} ${request.path}`,
    tone: 'normal',
  });

  if (backendMatches && clickSession && card.execution !== null) {
    const at = card.execution.observedAt;
    if (at >= start - 50 && (end === null || at <= end + 500)) {
      const name = card.execution.functionName ?? 'función anónima';
      steps.push({
        at,
        tag: 'BACKEND',
        text: `${name} · ${card.execution.file}:${String(card.execution.line)}`,
        tone: 'ok',
      });
    }
  }

  if (backendMatches && clickSession) {
    for (const query of card.queries) {
      if (query.observedAt === null || query.sql === null) continue;
      if (query.observedAt < start - 50 || (end !== null && query.observedAt > end + 500)) continue;
      const tables = query.tablesWritten.length > 0 ? query.tablesWritten : query.tablesRead;
      const target = tables.length > 0 ? ` ${tables.join(', ')}` : '';
      steps.push({
        at: query.observedAt,
        tag: 'SQL',
        text: `${SQL_OPERATION_LABEL[query.operation]}${target}`,
        tone: 'ok',
      });
    }
  }

  if (request.outcome === 'pending') {
    steps.push({ at: null, tag: 'RESPUESTA', text: 'Pendiente', tone: 'normal' });
  } else if (end !== null) {
    const code =
      request.statusCode !== null
        ? String(request.statusCode)
        : request.outcome === 'failed'
          ? 'ERR'
          : '—';
    const duration =
      request.durationMs !== null ? ` · ${String(Math.round(request.durationMs))} ms` : '';
    const failed = request.outcome === 'failed' || (request.statusCode ?? 0) >= 500;
    steps.push({
      at: end,
      tag: 'RESPUESTA',
      text: `${code}${duration}`,
      tone: failed ? 'error' : 'ok',
    });
  }

  steps.sort((left, right) => {
    if (left.at === null) return right.at === null ? 0 : 1;
    if (right.at === null) return -1;
    return left.at - right.at;
  });
  return steps;
}

function renderSequence(card: InspectionCard, request: InspectionRequest | null): void {
  const container = element('sequence');
  container.replaceChildren();
  if (request === null) return;
  for (const step of requestSteps(card, request)) {
    const row = document.createElement('div');
    row.className = step.tone === 'normal' ? 'seq-item' : `seq-item is-${step.tone}`;
    const time = document.createElement('span');
    time.className = 'seq-time';
    time.textContent = step.at === null ? '—' : clock(step.at);
    const tag = document.createElement('span');
    tag.className = 'seq-tag';
    tag.textContent = step.tag;
    const text = document.createElement('span');
    text.className = 'seq-text';
    text.textContent = step.text;
    row.append(time, tag, text);
    container.append(row);
  }
}

function executionEmptyText(card: InspectionCard, runtime: InspectionRuntime): string {
  if (runtime.status === 'connecting') {
    return 'Conectando…';
  }
  if (card.backend?.framework === 'fastapi' || card.backend?.framework === 'flask') {
    return 'Adaptador solo para Node.';
  }
  return 'Sin ejecución observada.';
}

function renderExecution(
  card: InspectionCard,
  execution: InspectionExecution | null,
  runtime: InspectionRuntime,
): void {
  const container = element('execution');
  const empty = element('execution-empty');
  if (execution === null) {
    container.hidden = true;
    empty.hidden = false;
    empty.textContent = executionEmptyText(card, runtime);
    return;
  }

  container.hidden = false;
  empty.hidden = true;
  const functionName = execution.functionName ?? 'función anónima';
  element('execution-loc').textContent = `${functionName} · ${execution.file}:${String(
    execution.line,
  )}:${String(execution.column)}`;
  element('breakpoints').textContent = execution.breakpoints
    .map((breakpoint) => `${breakpoint.method} ${breakpoint.path}`)
    .join(', ');

  const codeFile = element('execution-code-file');
  const codeRange = element('execution-code-range');
  if (execution.code !== null) {
    codeFile.textContent = execution.code.file;
    codeRange.textContent = lineRange(execution.code);
  } else {
    codeFile.textContent = execution.file;
    codeRange.textContent = '';
  }
  renderCode(element('execution-code'), execution.code, execution.codeNote, execution.line);
}

interface DisplayBody {
  text: string;
  truncated: boolean;
}

function prettyBody(body: CapturedBody): DisplayBody {
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (parsed !== null && typeof parsed === 'object') {
      return { text: JSON.stringify(parsed, null, 2), truncated: body.truncated };
    }
  } catch {
    // Cuerpo recortado o no estrictamente JSON: se muestra tal cual.
  }
  return { text: body.text, truncated: body.truncated };
}

function renderBody(
  bodyId: string,
  headId: string,
  body: CapturedBody | null,
  label: string,
): boolean {
  const container = element(bodyId);
  const head = element(headId);
  if (body === null) {
    head.hidden = true;
    container.hidden = true;
    container.replaceChildren();
    return false;
  }
  const display = prettyBody(body);
  head.hidden = false;
  head.textContent = label;
  container.hidden = false;
  const overflow = renderHighlightedText(container, display.text, 'json', MAX_BODY_LINES);
  return display.truncated || overflow;
}

function renderHandler(card: InspectionCard): void {
  const handler = element('handler');
  if (card.handler === null) {
    handler.textContent = card.status === 'resolving' ? 'Resolviendo…' : 'Sin manejador';
  } else {
    const source =
      card.handler.source === 'react'
        ? 'React'
        : card.handler.source === 'vue'
          ? 'Vue'
          : 'listener';
    handler.textContent = `${card.handler.event} → ${
      card.handler.name ?? 'función anónima'
    } · ${source}`;
  }

  const location = element('handler-loc');
  if (card.handler !== null && card.handler.url !== null) {
    const column = card.handler.column !== null ? `:${String(card.handler.column)}` : '';
    location.textContent = `${card.handler.url}:${String(card.handler.line ?? 0)}${column}`;
  } else {
    location.textContent = card.handler?.note ?? '';
  }

  const wrap = element('handler-code-wrap');
  const code = card.handler?.code ?? null;
  if (code === null) {
    wrap.hidden = true;
    element('handler-code').replaceChildren();
    return;
  }
  wrap.hidden = false;
  element('handler-code-file').textContent = code.file;
  element('handler-code-range').textContent = lineRange(code);
  renderCode(element('handler-code'), code, null, null);
}

function renderBackend(card: InspectionCard): void {
  const backend = element('backend');
  const location = element('backend-loc');
  const wrap = element('backend-code-wrap');
  if (card.backend === null) {
    backend.textContent = '—';
    location.textContent = '';
    wrap.hidden = true;
    element('backend-code').replaceChildren();
    return;
  }

  backend.textContent = card.backend.handlerName ?? 'sin resolver';
  const range =
    card.backend.line === card.backend.endLine
      ? String(card.backend.line)
      : `${String(card.backend.line)}–${String(card.backend.endLine)}`;
  location.textContent = `${card.backend.file}:${range}`;

  wrap.hidden = false;
  if (card.backend.code !== null) {
    element('backend-code-file').textContent = card.backend.code.file;
    element('backend-code-range').textContent = lineRange(card.backend.code);
  } else {
    element('backend-code-file').textContent = card.backend.file;
    element('backend-code-range').textContent = '';
  }
  const highlight =
    card.execution !== null &&
    card.backend.code !== null &&
    card.execution.file === card.backend.code.file
      ? card.execution.line
      : null;
  renderCode(element('backend-code'), card.backend.code, card.backend.codeNote, highlight);
}

function render(card: InspectionCard | null, runtime: InspectionRuntime): void {
  document.title = 'Inspección';
  const content = element('content');
  const idle = element('idle');
  if (card === null) {
    content.hidden = true;
    idle.hidden = false;
    element('level').textContent = 'N0';
    return;
  }

  idle.hidden = true;
  content.hidden = false;

  element('element').textContent =
    `<${card.element.tag}>${card.element.text !== null ? ` ${card.element.text}` : ''}`;
  const details: string[] = [];
  if (card.element.role !== null) {
    details.push(`rol ${card.element.role}`);
  }
  if (card.element.ariaLabel !== null) {
    details.push(`etiqueta ${card.element.ariaLabel}`);
  }
  if (card.element.inputType !== null) {
    details.push(`tipo ${card.element.inputType}`);
  }
  element('element-detail').textContent = details.join(' · ');

  renderHandler(card);

  const requests = element('requests');
  requests.replaceChildren();
  if (card.requests.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = card.status === 'done' ? 'Sin peticiones' : 'Escuchando…';
    requests.append(empty);
  } else {
    for (const request of card.requests) {
      requests.append(
        requestNode(request, request.id === card.selectedRequestId, (id) => {
          ipcRenderer.send(BROWSER_PANEL_CHANNELS.selectRequest, id);
        }),
      );
    }
  }

  element('endpoint').textContent =
    card.endpoint !== null ? `${card.endpoint.method} ${card.endpoint.path}` : '—';

  const selected = card.requests.find((request) => request.id === card.selectedRequestId) ?? null;
  renderSequence(card, selected);
  const requestTruncated = renderBody(
    'request-body',
    'request-body-head',
    selected?.requestBody ?? null,
    'Enviado',
  );
  const responseTruncated = renderBody(
    'response-body',
    'response-body-head',
    selected?.responseBody ?? null,
    'Respuesta',
  );
  const bodiesNote = element('bodies-note');
  bodiesNote.hidden = !(requestTruncated || responseTruncated);
  bodiesNote.textContent = requestTruncated || responseTruncated ? 'JSON recortado' : '';

  renderBackend(card);
  renderExecution(card, card.execution, runtime);
  renderQueries(card);

  const evidence = element('evidence');
  evidence.replaceChildren();
  for (const item of card.evidence) {
    const chip = document.createElement('span');
    chip.className = `chip ${item.toLowerCase()}`;
    chip.textContent = item;
    evidence.append(chip);
  }

  const note = element('note');
  note.hidden = card.note === null;
  note.textContent = card.note ?? '';
  element('level').textContent = card.level;
  element('status').textContent = statusLabel(card);
}

window.addEventListener('DOMContentLoaded', () => {
  const openMap = (): void => {
    ipcRenderer.send(BROWSER_PANEL_CHANNELS.map, true);
  };
  document.getElementById('map-toggle')?.addEventListener('click', openMap);
  document.getElementById('map-mode')?.addEventListener('click', openMap);
  document.querySelectorAll<HTMLButtonElement>('.mode[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      if (isMode(mode)) {
        ipcRenderer.send(BROWSER_PANEL_CHANNELS.setMode, mode);
      }
    });
  });
  ipcRenderer.on(BROWSER_PANEL_CHANNELS.data, (_event, state: InspectionPanelState) => {
    renderRuntime(state.runtime);
    renderModes(state.mode);
    render(state.card, state.runtime);
  });
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.ready);
});
