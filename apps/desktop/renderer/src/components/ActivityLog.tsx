import { useEffect, useRef, useState } from 'react';
import type { ActivityCategory, ActivityEvent } from '@bdt/protocol';
import { useBrowser } from '../state/browser-store';
import { CodeLink } from './CodeLink';

type Filter = 'all' | ActivityCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'request', label: 'Peticiones' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' },
  { id: 'sql', label: 'SQL' },
];

const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  request: 'PETICIÓN',
  frontend: 'FRONTEND',
  backend: 'BACKEND',
  sql: 'SQL',
};

function formatTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function locationLabel(event: ActivityEvent): string {
  if (event.file === null) return '';
  return event.line !== null && event.line > 0 ? `${event.file}:${String(event.line)}` : event.file;
}

export function ActivityLog() {
  const { state } = useBrowser();
  const activities = state.activities;
  const connected = state.state?.connected ?? false;
  const [filter, setFilter] = useState<Filter>('all');
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const counts: Record<Filter, number> = {
    all: activities.length,
    request: activities.filter((event) => event.category === 'request').length,
    frontend: activities.filter((event) => event.category === 'frontend').length,
    backend: activities.filter((event) => event.category === 'backend').length,
    sql: activities.filter((event) => event.category === 'sql').length,
  };

  const visible =
    filter === 'all' ? activities : activities.filter((event) => event.category === filter);

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
    <div className="activity-log" data-testid="activity-log">
      <div className="activity-bar">
        <div className="activity-filters" role="tablist" aria-label="Filtrar actividad">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              className={`activity-filter${filter === option.id ? ' is-active' : ''}`}
              onClick={() => setFilter(option.id)}
              data-testid={`activity-filter-${option.id}`}
            >
              {option.label}
              <span className="activity-count">{counts[option.id]}</span>
            </button>
          ))}
        </div>
        <span className="activity-meta">
          {connected ? 'Registro cronológico · en vivo' : 'Registro · sin sesión'}
        </span>
      </div>

      <div className="activity-list" ref={listRef} onScroll={handleScroll}>
        {!connected ? (
          <p className="empty-text">
            Conecta el frontend y el backend en la pestaña Aplicación para registrar lo que hace la
            página, las peticiones, las ejecuciones del backend y el SQL.
          </p>
        ) : visible.length === 0 ? (
          <p className="empty-text">
            {activities.length === 0
              ? 'Aún no hay actividad. Interactúa con la página embebida o con la ventana del navegador.'
              : 'No hay eventos con este filtro.'}
          </p>
        ) : (
          <div className="activity-rows" role="log" aria-label="Actividad de la página">
            {visible.map((event) => {
              const where = locationLabel(event);
              return (
                <div
                  key={event.id}
                  className={`activity-row tone-${event.tone}`}
                  data-category={event.category}
                  data-testid="activity-row"
                >
                  <span className="activity-time">{formatTime(event.at)}</span>
                  <span className={`activity-tag tag-${event.category}`}>
                    {CATEGORY_LABEL[event.category]}
                  </span>
                  <span className="activity-main">
                    <span className="activity-title">{event.title}</span>
                    {event.detail !== null ? (
                      <span className="activity-detail mono" title={event.detail}>
                        {event.detail}
                      </span>
                    ) : null}
                  </span>
                  <CodeLink
                    file={event.file}
                    line={event.line}
                    label={where}
                    className="activity-where mono"
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
