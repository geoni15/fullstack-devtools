import { useEffect, useState } from 'react';
import { languageForPath } from '../monaco';
import { useBrowser } from '../state/browser-store';
import { useWorkspace } from '../state/workspace-store';
import { AppView } from './AppView';
import { MonacoPane } from './MonacoPane';

type EditorView = 'app' | 'file';

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function EmptyEditor() {
  return (
    <div className="editor-empty">
      <p className="empty-title">Sin archivo abierto</p>
      <p className="empty-text">
        Selecciona un archivo del explorador para verlo en modo solo lectura, o abre la pestaña
        Aplicación para inspeccionar una web en ejecución.
      </p>
      <p className="empty-hint">F1 · Captura N0 de red</p>
    </div>
  );
}

export function EditorArea() {
  const { state, activateTab, closeTab } = useWorkspace();
  const browser = useBrowser();
  const [view, setView] = useState<EditorView>('app');
  const activeTab = state.tabs.find((tab) => tab.path === state.activePath) ?? null;

  useEffect(() => {
    if (state.activePath !== null) {
      setView('file');
    }
  }, [state.activePath]);

  const openFileTab = (path: string): void => {
    activateTab(path);
    setView('file');
  };

  const browserState = browser.state.state;
  const connected = browserState?.connected ?? false;

  return (
    <section className="panel editor-area">
      <div className="tabs" role="tablist" aria-label="Vistas del editor">
        <div className={`tab app-tab${view === 'app' ? ' is-active' : ''}`}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'app'}
            className="tab-label"
            onClick={() => setView('app')}
            data-testid="tab-app"
          >
            Aplicación
          </button>
          {connected ? (
            <span className="tab-live" title="Captura N0 activa">
              N0
            </span>
          ) : null}
        </div>

        {state.tabs.map((tab) => {
          const isActive = view === 'file' && tab.path === state.activePath;
          return (
            <div key={tab.path} className={`tab${isActive ? ' is-active' : ''}`}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="tab-label"
                title={tab.path}
                onClick={() => openFileTab(tab.path)}
              >
                {tab.name}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Cerrar ${tab.name}`}
                onClick={() => closeTab(tab.path)}
              >
                ×
              </button>
            </div>
          );
        })}
        {state.tabs.length === 0 ? <span className="tabs-idle">Archivos</span> : null}
      </div>

      <div className="editor-body">
        <div className={`app-pane${view === 'app' ? ' is-active' : ''}`}>
          <AppView active={view === 'app'} />
        </div>

        {view === 'file' ? (
          activeTab === null ? (
            <EmptyEditor />
          ) : activeTab.status === 'error' ? (
            <div className="editor-message" data-testid="editor-error">
              <p className="empty-title">No se puede abrir {activeTab.name}</p>
              <p className="empty-text">{activeTab.message}</p>
            </div>
          ) : (
            <MonacoPane
              key={activeTab.path}
              content={activeTab.content}
              language={languageForPath(activeTab.path)}
            />
          )
        ) : null}
      </div>

      <div className="editor-foot">
        <span>
          {view === 'app'
            ? (browserState?.currentUrl ?? 'Vista de aplicación')
            : (activeTab?.path ?? 'Sin archivo abierto')}
        </span>
        <span className="editor-foot-right">
          {view === 'app'
            ? connected
              ? `N0 · ${browser.state.requests.length} peticiones observadas`
              : 'N0 · sin sesión'
            : activeTab?.status === 'ready'
              ? `${formatBytes(activeTab.size)} · solo lectura`
              : 'Solo lectura'}
        </span>
      </div>
    </section>
  );
}
