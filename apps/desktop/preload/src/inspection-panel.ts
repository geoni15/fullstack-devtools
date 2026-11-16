import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  ELEMENT_STYLE_GROUPS,
  ERROR_CODES,
  INSPECTION_MODES,
  IPC_CHANNELS,
  elementSelectorLabel,
  elementSizeLabel,
  elementStyleGroups,
  handlerLabel,
  handlerProfileTags,
  normalizeSearchText,
  requestStatusView,
  type CapturedBody,
  type FileContent,
  type FileSaveResult,
  type InspectionCard,
  type InspectionCodeBlock,
  type InspectionElementInfo,
  type InspectionExecution,
  type InspectionMode,
  type InspectionPanelState,
  type InspectionRequest,
  type InspectionRuntime,
  type InspectionSqlQuery,
  type InspectionSqlResult,
  type IpcResult,
} from '@bdt/protocol';
import {
  createHighlightState,
  highlightLine,
  type HighlightLanguage,
  type HighlightToken,
} from './highlight';

const MAX_BODY_LINES = 240;

let currentCard: InspectionCard | null = null;
let currentRuntime: InspectionRuntime = { status: 'off', port: null, message: null };
let currentMode: InspectionMode = 'html';

const MODE_HINT: Record<InspectionMode, string> = {
  html: 'Pasa el mouse: etiqueta, tamaño y estilos calculados.',
  frontend: 'Pasa el mouse: handler, componentes y código.',
  backend: 'Pasa el mouse: petición y ruta del backend.',
  request: 'Pasa el mouse: ruta JSON, objeto, petición y funciones.',
  database: 'Pasa el mouse: SQL estático y observado asociado a la ruta.',
};

// Cada modo enseña solo su categoría; el resto de secciones se oculta, no se atenúa.
const MODE_SECTIONS: Record<InspectionMode, readonly string[]> = {
  html: ['sec-html'],
  frontend: ['sec-frontend'],
  backend: ['sec-backend', 'sec-execution'],
  request: ['sec-requests', 'sec-request'],
  database: ['sec-sql'],
};

function applyModeSections(mode: InspectionMode): void {
  const visible = MODE_SECTIONS[mode];
  document.querySelectorAll<HTMLElement>('#content > section').forEach((section) => {
    section.hidden = !visible.includes(section.id);
  });
}

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

function revealLocation(
  file: string | null | undefined,
  line: number | null | undefined,
  endLine: number | null | undefined,
): void {
  if (file === null || file === undefined || line === null || line === undefined || line <= 0) {
    return;
  }
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.revealLocation, {
    path: file,
    line,
    endLine: endLine ?? null,
  });
}

function codeLink(
  label: string,
  file: string | null | undefined,
  line: number | null | undefined,
  endLine: number | null | undefined,
): HTMLElement {
  const plain = document.createElement('span');
  plain.textContent = label;
  if (file === null || file === undefined || line === null || line === undefined || line <= 0) {
    return plain;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-link';
  button.textContent = label;
  button.title = 'Abrir en el editor y marcar la función';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealLocation(file, line, endLine);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  });
  return button;
}

function stepEndLine(
  card: InspectionCard,
  file: string,
  line: number,
  fallback: InspectionCodeBlock | null,
): number | null {
  if (
    card.backend !== null &&
    card.backend.file === file &&
    card.backend.line <= line &&
    line <= card.backend.endLine
  ) {
    return card.backend.endLine;
  }
  if (fallback !== null && fallback.file === file && fallback.startLine <= line) {
    return fallback.endLine;
  }
  return null;
}

function requestPath(request: InspectionRequest): string {
  const index = request.path.indexOf('?');
  return index === -1 ? request.path : request.path.slice(0, index);
}

function backendObserved(card: InspectionCard, request: InspectionRequest): boolean | null {
  if (request.backend === null) return null;
  if (card.execution === null) return false;
  const method = request.method.toUpperCase();
  const path = requestPath(request);
  return card.execution.breakpoints.some(
    (breakpoint) =>
      breakpoint.method.toUpperCase() === method &&
      (breakpoint.path === path || breakpoint.path === request.path),
  );
}

function matchesRequestFilter(card: InspectionCard, request: InspectionRequest): boolean {
  const query = normalizeSearchText(element<HTMLInputElement>('request-search').value.trim());
  if (query === '') return true;
  const status = requestStatusView({
    statusCode: request.statusCode,
    outcome: request.outcome,
    backendObserved: backendObserved(card, request),
  });
  const parts = [
    status.search,
    request.method,
    request.path,
    request.initiatorFunction,
    request.backend?.file,
    request.backend?.handlerName,
  ];
  return parts.some(
    (part) => part !== null && part !== undefined && normalizeSearchText(part).includes(query),
  );
}

function requestNode(
  card: InspectionCard,
  request: InspectionRequest,
  selected: boolean,
  select: (id: string) => void,
): HTMLElement {
  const observed = backendObserved(card, request);
  const view = requestStatusView({
    statusCode: request.statusCode,
    outcome: request.outcome,
    backendObserved: observed,
  });
  const row = document.createElement('div');
  row.className = `request status-${view.kind}${selected ? ' is-selected' : ''}`;
  row.dataset.requestId = request.id;
  row.dataset.status = view.kind;
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

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
  const duration =
    request.durationMs !== null ? `${String(Math.round(request.durationMs))} ms` : '—';
  status.textContent = `${view.label} · ${duration}`;
  status.title = `${view.phase} · ${view.detail}`;
  head.append(method, pathNode, time, phase, status);

  const backendLine = document.createElement('div');
  backendLine.className = 'backend-line';
  if (request.backend === null) {
    backendLine.textContent = 'sin ruta';
  } else {
    backendLine.append(
      document.createTextNode(`${request.backend.handlerName ?? 'sin resolver'} · `),
      codeLink(
        `${request.backend.file}:${String(request.backend.line)}`,
        request.backend.file,
        request.backend.line,
        stepEndLine(card, request.backend.file, request.backend.line, null),
      ),
    );
  }

  row.append(head, backendLine);
  row.addEventListener('click', () => {
    select(request.id);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select(request.id);
  });
  return row;
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

interface PanelCodeBuffer {
  path: string;
  text: string;
  baseText: string;
  baseMtimeMs: number;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  conflict: boolean;
}

interface PanelCodeEditor {
  wrap: HTMLElement;
  editor: HTMLTextAreaElement;
  save: HTMLButtonElement;
  reload: HTMLButtonElement;
  overwrite: HTMLButtonElement;
  dirty: HTMLElement;
  status: HTMLElement;
}

const CODE_LINE_HEIGHT = 17;
const codeBuffers = new Map<string, PanelCodeBuffer>();
const codeEditors = new Map<string, PanelCodeEditor>();
const codeOpen = new Set<string>();
const codeReveal = new Map<string, number>();

function syncCodeEditor(view: PanelCodeEditor, path: string): void {
  const buffer = codeBuffers.get(path);
  const ready = buffer !== undefined && !buffer.loading;
  view.editor.readOnly = !ready;
  view.editor.placeholder = ready ? '' : 'Cargando el archivo completo…';
  if (ready && buffer !== undefined && document.activeElement !== view.editor) {
    view.editor.value = buffer.text;
  }
  const conflict = buffer?.conflict ?? false;
  view.save.hidden = conflict;
  view.save.disabled = !ready || !(buffer?.dirty ?? false);
  view.reload.hidden = !conflict;
  view.overwrite.hidden = !conflict;
  view.dirty.hidden = !(buffer?.dirty ?? false);
  const error = buffer?.error ?? null;
  view.status.hidden = error === null;
  view.status.textContent = error ?? '';
}

function syncCodePath(path: string): void {
  for (const view of codeEditors.values()) {
    if (view.wrap.dataset.codePath === path) syncCodeEditor(view, path);
  }
}

async function loadPanelCode(path: string, revealLine: number): Promise<void> {
  const existing = codeBuffers.get(path);
  if (existing !== undefined && (existing.loading || existing.error === null)) return;
  const buffer: PanelCodeBuffer = {
    path,
    text: '',
    baseText: '',
    baseMtimeMs: 0,
    dirty: false,
    loading: true,
    error: null,
    conflict: false,
  };
  codeBuffers.set(path, buffer);
  codeReveal.set(path, revealLine);
  syncCodePath(path);
  const result = (await ipcRenderer.invoke(IPC_CHANNELS.readFile, {
    path,
  })) as IpcResult<FileContent>;
  if (codeBuffers.get(path) !== buffer) return;
  buffer.loading = false;
  if (!result.ok) {
    buffer.error = result.error.message;
    syncCodePath(path);
    return;
  }
  buffer.text = result.value.content;
  buffer.baseText = result.value.content;
  buffer.baseMtimeMs = result.value.mtimeMs;
  syncCodePath(path);
  const reveal = codeReveal.get(path);
  if (reveal === undefined) return;
  codeReveal.delete(path);
  for (const view of codeEditors.values()) {
    if (view.wrap.dataset.codePath !== path) continue;
    view.editor.scrollTop = Math.max(0, (reveal - 3) * CODE_LINE_HEIGHT);
  }
}

async function savePanelCode(path: string, force = false): Promise<boolean> {
  const buffer = codeBuffers.get(path);
  if (buffer === undefined || buffer.loading) return false;
  if (buffer.conflict && !force) return false;
  const result = (await ipcRenderer.invoke(IPC_CHANNELS.saveFile, {
    path,
    content: buffer.text,
    baseMtimeMs: buffer.baseMtimeMs,
  })) as IpcResult<FileSaveResult>;
  if (codeBuffers.get(path) !== buffer) return false;
  if (!result.ok) {
    buffer.conflict = result.error.code === ERROR_CODES.FILE_CONFLICT;
    buffer.error = buffer.conflict
      ? 'El archivo cambió en disco. Recarga o guarda encima.'
      : result.error.message;
    syncCodePath(path);
    return false;
  }
  buffer.baseText = buffer.text;
  buffer.baseMtimeMs = result.value.mtimeMs;
  buffer.dirty = false;
  buffer.conflict = false;
  buffer.error = null;
  syncCodePath(path);
  return true;
}

async function overwritePanelCode(path: string): Promise<void> {
  const read = (await ipcRenderer.invoke(IPC_CHANNELS.readFile, {
    path,
  })) as IpcResult<FileContent>;
  const buffer = codeBuffers.get(path);
  if (buffer === undefined) return;
  if (!read.ok) {
    buffer.error = read.error.message;
    syncCodePath(path);
    return;
  }
  buffer.baseMtimeMs = read.value.mtimeMs;
  await savePanelCode(path, true);
}

async function reloadPanelCode(path: string): Promise<void> {
  codeBuffers.delete(path);
  await loadPanelCode(path, 0);
}

async function saveAllPanelCode(): Promise<void> {
  for (const buffer of [...codeBuffers.values()]) {
    if (!buffer.dirty) continue;
    const saved = await savePanelCode(buffer.path);
    if (!saved) return;
  }
}

function savePanelCodeFromKeyboard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.classList.contains('panel-editor')) {
    const path = active.dataset.codePath;
    if (path !== undefined) {
      void savePanelCode(path);
      return;
    }
  }
  void saveAllPanelCode();
}

function codeButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'panel-save';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function buildCodeEditor(container: HTMLElement, path: string): PanelCodeEditor {
  const wrap = document.createElement('div');
  wrap.className = 'panel-edit';
  wrap.dataset.codePath = path;
  const editor = document.createElement('textarea');
  editor.className = 'panel-editor';
  editor.spellcheck = false;
  editor.wrap = 'off';
  editor.dataset.codePath = path;
  editor.setAttribute('aria-label', `Código de ${path}`);
  const dirty = document.createElement('span');
  dirty.className = 'panel-dirty';
  dirty.textContent = 'Sin guardar';
  const status = document.createElement('span');
  status.className = 'panel-edit-status';
  const view: PanelCodeEditor = {
    wrap,
    editor,
    save: codeButton('Guardar · Ctrl+S', () => {
      void savePanelCode(path);
    }),
    reload: codeButton('Recargar', () => {
      void reloadPanelCode(path);
    }),
    overwrite: codeButton('Guardar encima', () => {
      void overwritePanelCode(path);
    }),
    dirty,
    status,
  };
  editor.addEventListener('input', () => {
    const buffer = codeBuffers.get(path);
    if (buffer === undefined) return;
    buffer.text = editor.value;
    buffer.dirty = buffer.text !== buffer.baseText;
    syncCodePath(path);
  });
  const bar = document.createElement('div');
  bar.className = 'panel-savebar';
  bar.append(view.save, view.reload, view.overwrite, dirty, status);
  wrap.append(editor, bar);
  container.replaceChildren(wrap);
  return view;
}

// El código se muestra plegado y se edita sobre el archivo completo: el bloque del snapshot
// está recortado y no sirve para guardar sin perder contenido.
function renderCode(
  container: HTMLElement,
  block: InspectionCodeBlock | null,
  note: string | null,
  highlightLineNumber: number | null,
): void {
  const key = container.id;
  const toggle = document.getElementById(`${key}-toggle`);
  if (block === null || block.lines.length === 0) {
    codeEditors.delete(key);
    if (toggle !== null) toggle.hidden = true;
    container.hidden = false;
    container.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'code-note';
    empty.textContent = note ?? block?.note ?? 'Código no disponible.';
    container.append(empty);
    return;
  }

  const open = codeOpen.has(key);
  if (toggle instanceof HTMLButtonElement) {
    toggle.hidden = false;
    toggle.textContent = open ? '▾ Código' : '▸ Código';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.onclick = () => {
      if (codeOpen.has(key)) {
        codeOpen.delete(key);
      } else {
        codeOpen.add(key);
      }
      renderCode(container, block, note, highlightLineNumber);
    };
  }
  container.hidden = !open;
  if (!open) return;

  const existing = codeEditors.get(key);
  const view =
    existing !== undefined &&
    existing.wrap.dataset.codePath === block.file &&
    existing.wrap.parentElement === container
      ? existing
      : buildCodeEditor(container, block.file);
  codeEditors.set(key, view);
  syncCodeEditor(view, block.file);
  void loadPanelCode(block.file, highlightLineNumber ?? block.startLine);
}

function lineRange(code: InspectionCodeBlock): string {
  return code.startLine === code.endLine
    ? `línea ${String(code.startLine)}`
    : `líneas ${String(code.startLine)}–${String(code.endLine)}`;
}

function kvRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'kv';
  const key = document.createElement('span');
  key.className = 'k';
  key.textContent = label;
  const text = document.createElement('span');
  text.className = 'v';
  text.textContent = value;
  row.append(key, text);
  return row;
}

function renderElementInfo(info: InspectionElementInfo | null, fallbackSelector: string): void {
  const rows = element('html-rows');
  rows.replaceChildren();
  const empty = element('html-empty');
  if (info === null) {
    element('html-selector').textContent = fallbackSelector;
    element('html-size').textContent = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  element('html-selector').textContent = elementSelectorLabel(info);
  element('html-size').textContent =
    `${elementSizeLabel(info)} · x ${String(Math.round(info.rect.x))} · y ${String(
      Math.round(info.rect.y),
    )}`;
  for (const group of elementStyleGroups(info.styles)) {
    rows.append(kvRow(group.label, group.value));
  }
  const grouped = new Set<string>(ELEMENT_STYLE_GROUPS.flatMap((group) => [...group.names]));
  const rest = info.styles.filter((style) => !grouped.has(style.name) && style.value !== '');
  if (rest.length > 0) {
    rows.append(kvRow('Otros', rest.map((style) => `${style.name}: ${style.value}`).join(' · ')));
  }
  const attributes = info.attributes
    .map((attribute) => `${attribute.name}="${attribute.value}"`)
    .join(' ');
  if (attributes !== '') rows.append(kvRow('Atributos', attributes));
  if (info.text !== null) rows.append(kvRow('Texto', info.text));
}

function sqlCellText(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function sqlResultNode(result: InspectionSqlResult): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sql-result';

  const head = document.createElement('div');
  head.className = 'result-head';
  const driver = document.createElement('span');
  driver.textContent = `${result.driver} · ${clock(result.observedAt)}`;
  const count = document.createElement('span');
  count.className = 'result-count';
  count.textContent = result.rowCount === 1 ? '1 fila' : `${String(result.rowCount)} filas`;
  head.append(driver, count);
  container.append(head);

  if (result.columns.length === 0 || result.rows.length === 0) {
    const note = document.createElement('div');
    note.className = 'result-note';
    note.textContent =
      result.rows.length === 0 ? 'La consulta no devolvió filas.' : 'Sin columnas en la muestra.';
    container.append(note);
    return container;
  }

  const grid = document.createElement('div');
  grid.className = 'result-grid';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of result.columns) {
    const th = document.createElement('th');
    th.textContent = column;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (let index = 0; index < result.columns.length; index += 1) {
      const td = document.createElement('td');
      const value = row[index] ?? null;
      td.textContent = sqlCellText(value);
      if (value === null) td.className = 'is-null';
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  grid.append(table);
  container.append(grid);

  if (result.truncated || result.rows.length < result.rowCount) {
    const note = document.createElement('div');
    note.className = 'result-note';
    note.textContent = `Muestra de ${String(result.rows.length)} de ${String(
      result.rowCount,
    )} filas · límite de captura en memoria.`;
    container.append(note);
  }
  return container;
}

const SQL_OPERATION_LABEL: Record<InspectionSqlQuery['operation'], string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  other: 'SQL',
};

function queryNode(
  query: InspectionSqlQuery,
  file: string | null,
  endLine: number | null,
): HTMLElement {
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

  const parts: Node[] = [];
  if (query.tablesRead.length > 0) {
    parts.push(document.createTextNode(`lee ${query.tablesRead.join(', ')}`));
  }
  if (query.tablesWritten.length > 0) {
    parts.push(document.createTextNode(`escribe ${query.tablesWritten.join(', ')}`));
  }
  if (query.columns.length > 0) {
    parts.push(
      document.createTextNode(`columnas ${query.columns.map((column) => column.name).join(', ')}`),
    );
  }
  if (query.dialect !== null) parts.push(document.createTextNode(query.dialect));
  if (query.result === null && query.callMethod !== null) {
    parts.push(document.createTextNode(query.callMethod));
  }
  if (query.observedAt !== null) {
    parts.push(document.createTextNode(clock(query.observedAt)));
  }
  if (query.line > 0) {
    const label = `línea ${String(query.line)}`;
    parts.push(
      file === null ? document.createTextNode(label) : codeLink(label, file, query.line, endLine),
    );
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  parts.forEach((part, index) => {
    if (index > 0) {
      meta.append(document.createTextNode(' · '));
    }
    meta.append(part);
  });
  container.append(meta);

  const flags: string[] = [];
  if (query.dynamic) flags.push('SQL dinámico: el texto puede variar en ejecución');
  if (query.selectStar) flags.push('SELECT *');
  if (query.parse === 'fallback') flags.push('análisis por texto, sin AST');
  if (query.note !== null && query.note !== '') flags.push(query.note);
  if (flags.length > 0) {
    const note = document.createElement('div');
    note.className = 'meta';
    note.textContent = flags.join(' · ');
    container.append(note);
  }

  if (query.result !== null) container.append(sqlResultNode(query.result));
  return container;
}

function queriesEmptyText(card: InspectionCard): string {
  if (card.backend === null) {
    return card.endpoint !== null
      ? 'Sin SQL asociado a este elemento: la petición no tiene ruta backend resuelta.'
      : 'Sin SQL asociado a este elemento: no hay petición enlazada.';
  }
  if (!card.backend.resolved) {
    return 'Sin SQL asociado a este elemento: el manejador de la ruta no está resuelto.';
  }
  return 'Sin SQL en el manejador de esta ruta.';
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

  const backend = card.backend;
  for (const query of visible) {
    const endLine =
      backend !== null && query.line >= backend.line && query.line <= backend.endLine
        ? backend.endLine
        : null;
    container.append(queryNode(query, backend?.file ?? null, endLine));
  }
}

type SequenceTone = 'normal' | 'ok' | 'error';

interface SequenceStep {
  at: number | null;
  tag: string;
  text: string;
  tone: SequenceTone;
  file?: string | null;
  line?: number | null;
  endLine?: number | null;
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
      const name = card.execution.functionName ?? 'función en ejecución';
      steps.push({
        at,
        tag: 'BACKEND',
        text: `${name} · ${card.execution.file}:${String(card.execution.line)}`,
        tone: 'ok',
        file: card.execution.file,
        line: card.execution.line,
        endLine: stepEndLine(card, card.execution.file, card.execution.line, card.execution.code),
      });
    }
  }

  if (backendMatches && clickSession) {
    for (const query of card.queries) {
      if (query.observedAt === null || query.sql === null) continue;
      if (query.observedAt < start - 50 || (end !== null && query.observedAt > end + 500)) continue;
      const tables = query.tablesWritten.length > 0 ? query.tablesWritten : query.tablesRead;
      const target = tables.length > 0 ? ` ${tables.join(', ')}` : '';
      const backend = card.backend;
      steps.push({
        at: query.observedAt,
        tag: 'SQL',
        text: `${SQL_OPERATION_LABEL[query.operation]}${target}`,
        tone: 'ok',
        file: backend?.file ?? null,
        line: query.line > 0 ? query.line : null,
        endLine:
          backend !== null && query.line >= backend.line && query.line <= backend.endLine
            ? backend.endLine
            : null,
      });
    }
  }

  if (request.outcome === 'pending') {
    steps.push({ at: null, tag: 'RESPUESTA', text: 'Pendiente', tone: 'normal' });
  } else if (end !== null) {
    const view = requestStatusView({
      statusCode: request.statusCode,
      outcome: request.outcome,
      backendObserved: backendObserved(card, request),
    });
    const duration =
      request.durationMs !== null ? ` · ${String(Math.round(request.durationMs))} ms` : '';
    steps.push({
      at: end,
      tag: 'RESPUESTA',
      text: `${view.label}${duration}`,
      tone: view.tone === 'error' ? 'error' : 'ok',
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
    if (
      step.file !== null &&
      step.file !== undefined &&
      step.line !== null &&
      step.line !== undefined
    ) {
      text.append(codeLink(step.text, step.file, step.line, step.endLine));
    } else {
      text.textContent = step.text;
    }
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
  const functionName = execution.functionName ?? 'función en ejecución';
  const location = element('execution-loc');
  location.replaceChildren(
    document.createTextNode(`${functionName} · `),
    codeLink(
      `${execution.file}:${String(execution.line)}:${String(execution.column)}`,
      execution.file,
      execution.line,
      stepEndLine(card, execution.file, execution.line, execution.code),
    ),
  );
  element('breakpoints').textContent = execution.breakpoints
    .map((breakpoint) => `${breakpoint.method} ${breakpoint.path}`)
    .join(', ');

  const codeFile = element('execution-code-file');
  const codeRange = element('execution-code-range');
  if (execution.code !== null) {
    codeFile.replaceChildren(
      codeLink(
        execution.code.file,
        execution.code.file,
        execution.code.startLine,
        execution.code.endLine,
      ),
    );
    codeRange.textContent = lineRange(execution.code);
  } else {
    codeFile.replaceChildren(
      codeLink(
        execution.file,
        execution.file,
        execution.line,
        stepEndLine(card, execution.file, execution.line, null),
      ),
    );
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
    const tags = handlerProfileTags(card.handler.profile);
    handler.textContent = `${card.handler.event} → ${handlerLabel(
      card.handler.name,
      card.handler.profile,
    )}${tags.length === 0 ? '' : ` · ${tags.join(' · ')}`} · ${source}`;
  }

  const location = element('handler-loc');
  if (card.handler !== null && card.handler.url !== null) {
    const handlerUrl = card.handler.url;
    const handler = card.handler;
    const column = handler.column !== null ? `:${String(handler.column)}` : '';
    const code = handler.code;
    const line = handler.line ?? code?.startLine ?? 0;
    const target = code?.file ?? handlerUrl;
    const start = code?.startLine ?? line;
    const label = line > 0 ? `${handlerUrl}:${String(line)}${column}` : handlerUrl;
    location.replaceChildren(codeLink(label, target, start, code?.endLine ?? null));
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
  element('handler-code-file').replaceChildren(
    codeLink(code.file, code.file, code.startLine, code.endLine),
  );
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
  location.replaceChildren(
    codeLink(
      `${card.backend.file}:${range}`,
      card.backend.file,
      card.backend.line,
      card.backend.endLine,
    ),
  );

  wrap.hidden = false;
  const codeFile = element('backend-code-file');
  if (card.backend.code !== null) {
    codeFile.replaceChildren(
      codeLink(
        card.backend.code.file,
        card.backend.code.file,
        card.backend.code.startLine,
        card.backend.code.endLine,
      ),
    );
    element('backend-code-range').textContent = lineRange(card.backend.code);
  } else {
    codeFile.replaceChildren(
      codeLink(card.backend.file, card.backend.file, card.backend.line, card.backend.endLine),
    );
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

function render(
  card: InspectionCard | null,
  runtime: InspectionRuntime,
  mode: InspectionMode,
): void {
  document.title = 'Inspección';
  currentCard = card;
  currentRuntime = runtime;
  currentMode = mode;
  applyModeSections(mode);
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

  renderElementInfo(card.elementInfo, card.element.selector ?? `<${card.element.tag}>`);

  renderHandler(card);

  const requests = element('requests');
  requests.replaceChildren();
  const visibleRequests = card.requests.filter((request) => matchesRequestFilter(card, request));
  if (card.requests.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = card.status === 'done' ? 'Sin peticiones' : 'Escuchando…';
    requests.append(empty);
  } else if (visibleRequests.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Ninguna petición coincide con el filtro de estado.';
    requests.append(empty);
  } else {
    for (const request of visibleRequests) {
      requests.append(
        requestNode(card, request, request.id === card.selectedRequestId, (id) => {
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
  document.getElementById('request-search')?.addEventListener('input', () => {
    render(currentCard, currentRuntime, currentMode);
  });
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
    render(state.card, state.runtime, state.mode);
  });
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key !== 's' && event.key !== 'S') return;
    event.preventDefault();
    savePanelCodeFromKeyboard();
  });
  ipcRenderer.send(BROWSER_PANEL_CHANNELS.ready);
});
