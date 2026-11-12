import { memo, useCallback, useMemo, useState } from 'react';
import {
  normalizeSearchText,
  requestStatusView,
  type CapturedBody,
  type CapturedRequest,
  type RequestOrigin,
} from '@bdt/protocol';
import { useBrowser } from '../state/browser-store';
import { CodeLink } from './CodeLink';

type Filter = 'all' | RequestOrigin;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'backend', label: 'Backend' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'external', label: 'Externas' },
];

const ORIGIN_LABEL: Record<RequestOrigin, string> = {
  backend: 'Backend',
  frontend: 'Frontend',
  external: 'Externa',
};

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type SequenceTone = 'normal' | 'ok' | 'error';

interface SequenceStep {
  at: number | null;
  tag: string;
  text: string;
  tone: SequenceTone;
}

function requestSteps(request: CapturedRequest): SequenceStep[] {
  const steps: SequenceStep[] = [];
  const frame = request.initiator?.frames[0];
  if (frame !== undefined) {
    const target = `${frame.url.split('/').pop() ?? frame.url}:${frame.line}`;
    steps.push({
      at: request.wallStartedAt,
      tag: 'Frontend',
      text: `${frame.functionName ?? '(anónima)'} · ${target}`,
      tone: 'normal',
    });
  }
  steps.push({
    at: request.wallStartedAt,
    tag: 'HTTP',
    text: `${request.method} ${request.path}`,
    tone: 'normal',
  });

  if (request.durationMs !== null) {
    const view = requestStatus(request);
    const text = `${view.label} · ${formatDuration(request.durationMs)}${
      request.error !== null ? ` · ${request.error}` : ''
    }`;
    steps.push({
      at: request.wallStartedAt + request.durationMs,
      tag: 'Respuesta',
      text,
      tone: view.tone === 'error' ? 'error' : 'ok',
    });
  } else {
    steps.push({
      at: null,
      tag: 'Respuesta',
      text: request.outcome === 'pending' ? 'Pendiente' : 'Sin respuesta',
      tone: 'normal',
    });
  }

  steps.sort((left, right) => {
    if (left.at === null) return right.at === null ? 0 : 1;
    if (right.at === null) return -1;
    return left.at - right.at;
  });
  return steps;
}

function RequestSequence({ request }: { request: CapturedRequest }) {
  const steps = requestSteps(request);
  return (
    <div className="detail-block is-wide">
      <span className="detail-label">Secuencia</span>
      <div className="sequence">
        {steps.map((step, index) => (
          <div
            key={`${step.tag}:${String(step.at)}:${String(index)}`}
            className={step.tone === 'normal' ? 'seq-row' : `seq-row is-${step.tone}`}
          >
            <span className="seq-time mono">{step.at === null ? '—' : formatTime(step.at)}</span>
            <span className="seq-tag">{step.tag}</span>
            <span className="seq-text">{step.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function requestStatus(request: CapturedRequest): ReturnType<typeof requestStatusView> {
  return requestStatusView({
    statusCode: request.statusCode,
    outcome: request.outcome,
    error: request.error,
  });
}

function statusTone(request: CapturedRequest): string {
  const tone = requestStatus(request).tone;
  if (tone === 'ok') return 'is-ok';
  if (tone === 'warning') return 'is-warning';
  if (tone === 'error') return 'is-error';
  if (tone === 'pending') return 'is-idle';
  return 'is-muted';
}

function matchesRequest(request: CapturedRequest, query: string): boolean {
  if (query === '') return true;
  const status = requestStatus(request);
  const parts = [
    status.search,
    request.method,
    request.path,
    request.host,
    request.url,
    initiatorLabel(request),
  ];
  return parts.some(
    (part) => part !== null && part !== undefined && normalizeSearchText(part).includes(query),
  );
}

function initiatorLabel(request: CapturedRequest): string {
  const frame = request.initiator?.frames[0];
  if (frame === undefined) return '—';
  return frame.functionName ?? frame.url.split('/').pop() ?? frame.url;
}

function formatBody(body: CapturedBody): string {
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Cuerpo recortado o no estrictamente JSON.
  }
  return body.text;
}

function JsonBody({ label, body }: { label: string; body: CapturedBody | null }) {
  if (body === null) return null;
  return (
    <div className="detail-block is-wide">
      <span className="detail-label">{label}</span>
      <pre className="detail-body mono">{formatBody(body)}</pre>
      {body.truncated ? <span className="detail-note">Recortado a 16 KB.</span> : null}
    </div>
  );
}

function RequestDetail({ request }: { request: CapturedRequest }) {
  const headers = Object.entries(request.headers);
  const frames = request.initiator?.frames ?? [];
  const status = requestStatus(request);

  return (
    <div className="request-detail" data-testid={`request-detail-${request.id}`}>
      <div className="detail-block">
        <span className="detail-label">Petición</span>
        <span className="detail-value mono">{request.url}</span>
        <span className="detail-meta">
          {formatTime(request.wallStartedAt)} · {request.method} · {request.resourceType} ·{' '}
          {ORIGIN_LABEL[request.origin]} · {formatDuration(request.durationMs)}
          {request.mimeType !== null ? ` · ${request.mimeType}` : ''}
        </span>
        <span className="detail-value">
          {status.label} · {status.phase}
        </span>
        <span className="detail-meta">{status.detail}</span>
        {request.error !== null ? <span className="detail-error">{request.error}</span> : null}
      </div>

      <RequestSequence request={request} />

      <JsonBody label="Enviado" body={request.requestBody} />
      <JsonBody label="Respuesta" body={request.responseBody} />

      <div className="detail-block">
        <span className="detail-label">Iniciador</span>
        {request.initiator === null ? (
          <span className="detail-meta">Sin pila.</span>
        ) : (
          <>
            <span className="detail-meta">
              Tipo {request.initiator.type}
              {request.initiator.async ? ' · asíncrono' : ' · síncrono'}
            </span>
            {frames.length === 0 ? (
              <span className="detail-meta">Sin marcos.</span>
            ) : (
              <ul className="initiator-frames">
                {frames.map((frame, index) => (
                  <li key={`${frame.url}:${frame.line}:${frame.column}:${index}`}>
                    <span className="initiator-fn">{frame.functionName ?? '(anónima)'}</span>
                    <CodeLink
                      file={frame.url}
                      line={frame.line}
                      label={`${frame.url}:${frame.line}:${frame.column}`}
                      className="initiator-loc mono"
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="detail-block">
        <span className="detail-label">Cabeceras de la petición</span>
        {headers.length === 0 ? (
          <span className="detail-meta">Sin cabeceras.</span>
        ) : (
          <dl className="header-list">
            {headers.map(([name, value]) => (
              <div key={name} className="header-item">
                <dt>{name}</dt>
                <dd className="mono">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <span className="detail-note">Valores sensibles enmascarados.</span>
      </div>
    </div>
  );
}

interface RequestRowProps {
  request: CapturedRequest;
  isOpen: boolean;
  onToggle: (id: string) => void;
}

const RequestRow = memo(function RequestRow({ request, isOpen, onToggle }: RequestRowProps) {
  const status = requestStatus(request);
  return (
    <div className="request-entry">
      <button
        type="button"
        role="row"
        className={`request-row${isOpen ? ' is-open' : ''}`}
        onClick={() => onToggle(request.id)}
        aria-expanded={isOpen}
        title={request.url}
        data-testid={`request-row-${request.id}`}
      >
        <span className={`method method-${request.method.toLowerCase()}`} role="cell">
          {request.method}
        </span>
        <span className="request-time" role="cell">
          {formatTime(request.wallStartedAt)}
        </span>
        <span className="request-path" role="cell">
          <span className="request-path-value">{request.path}</span>
          <span className="request-host">{request.host}</span>
        </span>
        <span role="cell">
          <span className={`origin origin-${request.origin}`}>{ORIGIN_LABEL[request.origin]}</span>
        </span>
        <span
          className={`request-status ${statusTone(request)}`}
          role="cell"
          title={`${status.phase} · ${status.detail}`}
        >
          {status.label}
        </span>
        <span className="request-duration" role="cell">
          {formatDuration(request.durationMs)}
        </span>
        <span className="request-initiator" role="cell">
          {initiatorLabel(request)}
        </span>
      </button>
      {isOpen ? <RequestDetail request={request} /> : null}
    </div>
  );
});

export function Timeline() {
  const { state } = useBrowser();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const browser = state.state;
  const connected = browser?.connected ?? false;
  const requests = state.requests;

  const counts = useMemo(
    () => ({
      all: requests.length,
      backend: requests.filter((request) => request.origin === 'backend').length,
      frontend: requests.filter((request) => request.origin === 'frontend').length,
      external: requests.filter((request) => request.origin === 'external').length,
    }),
    [requests],
  );

  const normalizedQuery = normalizeSearchText(query.trim());
  const visible = useMemo(
    () =>
      requests.filter(
        (request) =>
          (filter === 'all' || request.origin === filter) &&
          matchesRequest(request, normalizedQuery),
      ),
    [requests, filter, normalizedQuery],
  );

  const toggle = useCallback((id: string): void => {
    setExpanded((current) => (current === id ? null : id));
  }, []);

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline-bar">
        <div className="timeline-filters" role="tablist" aria-label="Filtrar peticiones">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              className={`timeline-filter${filter === option.id ? ' is-active' : ''}`}
              onClick={() => setFilter(option.id)}
              data-testid={`filter-${option.id}`}
            >
              {option.label}
              <span className="filter-count">{counts[option.id]}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="timeline-search"
          placeholder="Buscar por estado, método o ruta…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar peticiones por estado"
          data-testid="timeline-search"
        />
        <span className="timeline-meta">
          {connected ? 'N0 · observación de red' : 'N0 · sin sesión'}
        </span>
      </div>

      <div className="timeline-list">
        {!connected ? (
          <p className="empty-text">
            Conecta el frontend y el backend en la pestaña Aplicación para ver las peticiones que
            hace la página.
          </p>
        ) : visible.length === 0 ? (
          <p className="empty-text">
            {requests.length === 0
              ? 'Aún no hay peticiones. Interactúa con la página embebida.'
              : 'No hay peticiones con este filtro.'}
          </p>
        ) : (
          <div className="request-table" role="table" aria-label="Peticiones observadas">
            <div className="request-head" role="row">
              <span role="columnheader">Método</span>
              <span role="columnheader">Hora</span>
              <span role="columnheader">Ruta</span>
              <span role="columnheader">Origen</span>
              <span role="columnheader">Estado</span>
              <span role="columnheader">Duración</span>
              <span role="columnheader">Iniciador</span>
            </div>
            {visible.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                isOpen={expanded === request.id}
                onToggle={toggle}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
