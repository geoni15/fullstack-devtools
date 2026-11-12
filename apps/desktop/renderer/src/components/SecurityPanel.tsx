import { useState } from 'react';
import type {
  SecurityCategory,
  SecurityFinding,
  SecuritySeverity,
  SecuritySource,
} from '@bdt/protocol';
import { useBrowser } from '../state/browser-store';
import { CodeLink } from './CodeLink';

type SeverityFilter = 'all' | SecuritySeverity;
type CategoryFilter = 'all' | SecurityCategory;

const SEVERITY_FILTERS: { id: SeverityFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'critical', label: 'Críticas' },
  { id: 'high', label: 'Altas' },
  { id: 'medium', label: 'Medias' },
  { id: 'low', label: 'Bajas' },
];

const CATEGORY_FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'server-exposure', label: 'Servidor expuesto' },
  { id: 'insecure-transport', label: 'Sin cifrar' },
  { id: 'secret', label: 'Secretos' },
  { id: 'dom-sink', label: 'DOM peligroso' },
];

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  critical: 'CRÍTICA',
  high: 'ALTA',
  medium: 'MEDIA',
  low: 'BAJA',
};

const SOURCE_LABEL: Record<SecuritySource, string> = {
  html: 'HTML',
  css: 'CSS',
  js: 'JS',
  request: 'PETICIÓN',
};

function formatTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function locationText(finding: SecurityFinding): string {
  const target = finding.file ?? finding.url;
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
  if (finding.line !== null) text += `:${String(finding.line)}`;
  if (finding.column !== null) text += `:${String(finding.column)}`;
  return text;
}

function resolvableTarget(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(value) ? value : null;
}

function locationTarget(finding: SecurityFinding): string | null {
  return resolvableTarget(finding.file) ?? resolvableTarget(finding.url);
}

export function SecurityPanel() {
  const { state, scanSecurity } = useBrowser();
  const report = state.security;
  const connected = state.state?.connected ?? false;
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [search, setSearch] = useState('');

  const findings = report.findings;
  const scanning = report.status === 'scanning';
  const query = search.trim().toLowerCase();

  const severityCounts: Record<SeverityFilter, number> = {
    all: findings.length,
    critical: findings.filter((entry) => entry.severity === 'critical').length,
    high: findings.filter((entry) => entry.severity === 'high').length,
    medium: findings.filter((entry) => entry.severity === 'medium').length,
    low: findings.filter((entry) => entry.severity === 'low').length,
  };
  const categoryCounts: Record<CategoryFilter, number> = {
    all: findings.length,
    'server-exposure': findings.filter((entry) => entry.category === 'server-exposure').length,
    'insecure-transport': findings.filter((entry) => entry.category === 'insecure-transport')
      .length,
    secret: findings.filter((entry) => entry.category === 'secret').length,
    'dom-sink': findings.filter((entry) => entry.category === 'dom-sink').length,
  };

  const visible = findings.filter((finding) => {
    if (severity !== 'all' && finding.severity !== severity) return false;
    if (category !== 'all' && finding.category !== category) return false;
    if (query === '') return true;
    const haystack = [
      finding.title,
      finding.detail,
      finding.evidence,
      finding.host ?? '',
      finding.file ?? '',
      finding.url ?? '',
      finding.note ?? '',
      finding.category,
      finding.source,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });

  const meta =
    report.scannedAt === null
      ? ''
      : `Analizado a las ${formatTime(report.scannedAt)} · ${String(findings.length)} ${
          findings.length === 1 ? 'hallazgo' : 'hallazgos'
        } · ${String(report.scripts)} JS · ${String(report.styleSheets)} CSS · ${String(
          report.requests,
        )} peticiones`;

  return (
    <div className="security-panel" data-testid="security-panel">
      <div className="security-bar">
        <div
          className="activity-filters"
          role="tablist"
          aria-label="Filtrar hallazgos por gravedad"
        >
          {SEVERITY_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={severity === option.id}
              className={`activity-filter${severity === option.id ? ' is-active' : ''}`}
              onClick={() => setSeverity(option.id)}
              data-testid={`security-severity-${option.id}`}
            >
              {option.label}
              <span className="activity-count">{severityCounts[option.id]}</span>
            </button>
          ))}
        </div>
        <div className="activity-filters" role="tablist" aria-label="Filtrar hallazgos por tipo">
          {CATEGORY_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={category === option.id}
              className={`activity-filter${category === option.id ? ' is-active' : ''}`}
              onClick={() => setCategory(option.id)}
              data-testid={`security-category-${option.id}`}
            >
              {option.label}
              <span className="activity-count">{categoryCounts[option.id]}</span>
            </button>
          ))}
        </div>
        <input
          className="security-search"
          type="search"
          value={search}
          placeholder="Buscar host, regla o archivo"
          onChange={(event) => setSearch(event.target.value)}
          data-testid="security-search"
        />
        <button
          type="button"
          className="button small"
          onClick={() => {
            void scanSecurity();
          }}
          disabled={!connected || scanning}
          data-testid="security-rescan"
        >
          {scanning ? 'Analizando…' : 'Reanalizar'}
        </button>
      </div>

      <div className="security-status">
        <span className={`security-status-tag status-${report.status}`}>
          {report.status === 'scanning'
            ? 'En curso'
            : report.status === 'done'
              ? 'Completado'
              : report.status === 'error'
                ? 'Error'
                : 'En espera'}
        </span>
        <span className="security-meta">{meta}</span>
      </div>

      <div className="console-list security-list">
        {!connected ? (
          <p className="empty-text">
            Conecta el frontend y el backend en la pestaña Aplicación para analizar el HTML, CSS y
            JavaScript que recibe el navegador.
          </p>
        ) : report.status === 'error' && findings.length === 0 ? (
          <p className="empty-text">
            El análisis falló: {report.error ?? 'error desconocido.'} Vuelve a intentarlo con
            Reanalizar.
          </p>
        ) : scanning && findings.length === 0 ? (
          <p className="empty-text">Analizando HTML, CSS y JavaScript de la página…</p>
        ) : report.status === 'idle' && report.scannedAt === null ? (
          <p className="empty-text">
            El análisis de seguridad se ejecuta al pulsar Reanalizar, para no cargar trabajo sobre
            la página mientras navegas.
          </p>
        ) : findings.length === 0 ? (
          <p className="empty-text">
            Sin hallazgos en este análisis. Se revisan direcciones internas, transporte sin cifrar,
            secretos y sumideros DOM en el código entregado al navegador.
          </p>
        ) : visible.length === 0 ? (
          <p className="empty-text">No hay hallazgos con estos filtros.</p>
        ) : (
          <div className="security-rows">
            {visible.map((finding) => {
              const where = locationText(finding);
              return (
                <article
                  key={finding.id}
                  className={`security-row severity-${finding.severity}`}
                  data-testid="security-row"
                  data-severity={finding.severity}
                  data-category={finding.category}
                >
                  <header className="security-head">
                    <span className={`security-severity severity-${finding.severity}`}>
                      {SEVERITY_LABEL[finding.severity]}
                    </span>
                    <span className="security-title">{finding.title}</span>
                    <span className="security-source">{SOURCE_LABEL[finding.source]}</span>
                    {finding.host !== null ? (
                      <span className="security-host mono">{finding.host}</span>
                    ) : null}
                  </header>
                  <p className="security-detail">{finding.detail}</p>
                  <div className="security-evidence mono">{finding.evidence}</div>
                  <footer className="security-foot">
                    <CodeLink
                      file={locationTarget(finding)}
                      line={finding.line}
                      label={where === '' ? 'Sin ubicación' : where}
                      className="security-where mono"
                      title={where}
                    />
                    {finding.note !== null ? (
                      <span className="security-note">{finding.note}</span>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
