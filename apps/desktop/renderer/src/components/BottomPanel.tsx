import { useState } from 'react';
import { useBrowser } from '../state/browser-store';
import { useWorkspace } from '../state/workspace-store';
import { ActivityLog } from './ActivityLog';
import { ConsolePanel } from './ConsolePanel';
import { Timeline } from './Timeline';

const BOTTOM_TABS = ['Registro', 'Peticiones', 'Consola', 'Problemas'] as const;
type BottomTab = (typeof BOTTOM_TABS)[number];

const TAB_TEST_ID: Record<BottomTab, string> = {
  Registro: 'bottom-tab-registro',
  Peticiones: 'bottom-tab-peticiones',
  Consola: 'bottom-tab-consola',
  Problemas: 'bottom-tab-problemas',
};

export function BottomPanel() {
  const { state, dismissError } = useWorkspace();
  const browser = useBrowser();
  const [active, setActive] = useState<BottomTab>('Registro');
  const requestCount = browser.state.requests.length;
  const consoleProblems = browser.state.consoleEntries.filter(
    (entry) => entry.level === 'warn' || entry.level === 'error' || entry.level === 'exception',
  ).length;

  return (
    <section className="panel bottom-panel">
      <div className="bottom-tabs" role="tablist" aria-label="Paneles inferiores">
        {BOTTOM_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active === tab}
            className={`bottom-tab${active === tab ? ' is-active' : ''}`}
            onClick={() => setActive(tab)}
            data-testid={TAB_TEST_ID[tab]}
          >
            {tab}
            {tab === 'Peticiones' && requestCount > 0 ? (
              <span className="badge-count">{requestCount}</span>
            ) : null}
            {tab === 'Consola' && consoleProblems > 0 ? (
              <span className="badge-error">{consoleProblems}</span>
            ) : null}
            {tab === 'Problemas' && state.error !== null ? (
              <span className="badge-error">1</span>
            ) : null}
          </button>
        ))}
      </div>

      <div
        className={`bottom-body${
          active === 'Registro' || active === 'Peticiones' || active === 'Consola'
            ? ' is-timeline'
            : ''
        }`}
      >
        {active === 'Registro' ? <ActivityLog /> : null}
        {active === 'Peticiones' ? <Timeline /> : null}
        {active === 'Consola' ? <ConsolePanel /> : null}

        {active === 'Problemas' ? (
          state.error !== null ? (
            <div className="problem-row">
              <span className="problem-code">Error</span>
              <span>{state.error}</span>
              <button type="button" className="button small" onClick={dismissError}>
                Descartar
              </button>
            </div>
          ) : (
            <p className="empty-text">Sin problemas registrados.</p>
          )
        ) : null}
      </div>
    </section>
  );
}
