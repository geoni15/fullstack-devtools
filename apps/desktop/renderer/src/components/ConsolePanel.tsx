import { useEffect, useRef, useState } from 'react';
import type { ConsoleEntry, ConsoleLevel, ConsoleSource } from '@bdt/protocol';
import { useBrowser } from '../state/browser-store';
import { CodeLink } from './CodeLink';

type Filter = 'all' | ConsoleSource;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' },
];

const SOURCE_LABEL: Record<ConsoleSource, string> = {
  frontend: 'FRONTEND',
  backend: 'BACKEND',
};

const LEVEL_LABEL: Record<ConsoleLevel, string> = {
  log: 'LOG',
  info: 'INFO',
  debug: 'DEBUG',
  warn: 'WARN',
  error: 'ERROR',
  exception: 'EXC',
};

const PROBLEM_LEVELS: ReadonlySet<ConsoleLevel> = new Set(['warn', 'error', 'exception']);

function isProblem(entry: ConsoleEntry): boolean {
  return PROBLEM_LEVELS.has(entry.level);
}

function formatTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function locationLabel(entry: ConsoleEntry): string {
  const target = entry.file ?? entry.url;
  if (target === null) return '';
  let text = target;
  if (/^https?:/i.test(target)) {
    try {
      const url = new URL(target);
      text = url.pathname === '' ? url.host : url.pathname;
    } catch {
      text = target;
    }
  }
  if (entry.line !== null) text += `:${String(entry.line)}`;
  if (entry.column !== null) text += `:${String(entry.column)}`;
  return text;
}

function revealTarget(entry: ConsoleEntry): string | null {
  if (entry.file !== null) return entry.file;
  if (
    entry.url !== null &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(entry.url)
  ) {
    return entry.url;
  }
  return null;
}

export function ConsolePanel() {
  const { state } = useBrowser();
  const entries = state.consoleEntries;
  const connected = state.state?.connected ?? false;
  const [filter, setFilter] = useState<Filter>('all');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const problems = entries.filter(isProblem).length;
  const counts: Record<Filter, number> = {
    all: entries.length,
    frontend: entries.filter((entry) => entry.source === 'frontend').length,
    backend: entries.filter((entry) => entry.source === 'backend').length,
  };

  const visible = entries.filter(
    (entry) => (filter === 'all' || entry.source === filter) && (!problemsOnly || isProblem(entry)),
  );

  useEffect(() => {
    const node = listRef.current;
    if (node !== null && stickRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [visible.length]);

  const handleScroll = (): void => {
    const node = listRef.current;
    if (node === null) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  };

  return (
    <div className="console-panel" data-testid="console-panel">
      <div className="activity-bar">
        <div className="activity-filters" role="tablist" aria-label="Filtrar consola por origen">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              className={`activity-filter${filter === option.id ? ' is-active' : ''}`}
              onClick={() => setFilter(option.id)}
              data-testid={`console-filter-${option.id}`}
            >
              {option.label}
              <span className="activity-count">{counts[option.id]}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={problemsOnly}
            className={`activity-filter${problemsOnly ? ' is-active' : ''}`}
            onClick={() => setProblemsOnly((current) => !current)}
            data-testid="console-filter-problems"
          >
            Solo problemas
            <span className="activity-count">{problems}</span>
          </button>
        </div>
        <span className="activity-meta">
          {connected
            ? `Consola cronológica · ${String(entries.length)} ${entries.length === 1 ? 'entrada' : 'entradas'}`
            : 'Consola · sin sesión'}
        </span>
      </div>

      <div className="console-list" ref={listRef} onScroll={handleScroll}>
        {!connected ? (
          <p className="empty-text">
            Conecta el frontend y el backend en la pestaña Aplicación para ver los console.log,
            advertencias, errores y excepciones de la página y del backend.
          </p>
        ) : visible.length === 0 ? (
          <p className="empty-text">
            {entries.length === 0
              ? 'Aún no hay mensajes. Interactúa con la página o revisa la salida de los procesos.'
              : 'No hay mensajes con este filtro.'}
          </p>
        ) : (
          <div className="console-rows" role="log" aria-label="Consola de la aplicación">
            {visible.map((entry) => {
              const where = locationLabel(entry);
              return (
                <div
                  key={entry.id}
                  className={`console-row level-${entry.level}`}
                  data-source={entry.source}
                  data-level={entry.level}
                  data-testid="console-row"
                >
                  <span className="console-time">{formatTime(entry.at)}</span>
                  <span className={`console-level level-${entry.level}`}>
                    {LEVEL_LABEL[entry.level]}
                  </span>
                  <span className={`console-source source-${entry.source}`}>
                    {SOURCE_LABEL[entry.source]}
                  </span>
                  <span className="console-text mono">{entry.text}</span>
                  <CodeLink
                    file={revealTarget(entry)}
                    line={entry.line}
                    label={where}
                    className="console-where mono"
                    title={where}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
