import { useBrowser } from '../state/browser-store';
import { useWorkspace } from '../state/workspace-store';

const LEVELS = ['N0', 'N1', 'N2', 'N3'] as const;

export function TitleBar() {
  const { state, openWorkspace } = useWorkspace();
  const browser = useBrowser();
  const captureActive = browser.state.state?.captureActive ?? false;
  const connected = browser.state.state?.connected ?? false;
  const inspectionEnabled = browser.state.state?.inspectionEnabled ?? false;

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-name">Backend DevTools</span>
        <span className="brand-sub">Desktop</span>
      </div>

      <div className="project-chip">
        <span className="project-label">Proyecto</span>
        <span className="project-name">{state.snapshot?.workspace.name ?? 'Sin abrir'}</span>
      </div>

      <button
        className="button primary"
        type="button"
        onClick={() => void openWorkspace()}
        disabled={state.busy}
      >
        {state.busy ? 'Abriendo…' : 'Abrir carpeta'}
      </button>

      <span className="titlebar-spacer" />

      <button
        className={`devtool-toggle${inspectionEnabled ? ' is-on' : ''}`}
        type="button"
        disabled={!connected}
        title={
          connected
            ? 'Activa o desactiva la inspección por clic en la aplicación'
            : 'Conecta una aplicación para usar el inspector'
        }
        onClick={() => void browser.setInspection(!inspectionEnabled)}
        data-testid="devtool-toggle"
      >
        Devtool <span className="toggle-state">{inspectionEnabled ? 'ON' : 'OFF'}</span>
      </button>

      <div className="levels" aria-label="Niveles de fidelidad">
        {LEVELS.map((level) => {
          const activeLevel = level === 'N0' && captureActive;
          return (
            <span
              key={level}
              className={`level-pill${activeLevel ? ' is-on' : ''}`}
              title={
                level === 'N0'
                  ? captureActive
                    ? 'N0: captura de red activa'
                    : 'N0: sin sesión de captura'
                  : `${level}: disponible en una fase posterior`
              }
            >
              {level}
            </span>
          );
        })}
      </div>
    </header>
  );
}
