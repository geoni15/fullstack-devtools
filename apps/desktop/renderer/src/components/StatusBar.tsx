import { useBrowser } from '../state/browser-store';
import { useWorkspace } from '../state/workspace-store';

export function StatusBar() {
  const { state } = useWorkspace();
  const browser = useBrowser();
  const snapshot = state.snapshot;
  const browserState = browser.state.state;
  const connected = browserState?.connected ?? false;

  return (
    <footer className="statusbar">
      <span className="statusbar-root" title={snapshot?.workspace.rootPath ?? ''}>
        {snapshot?.workspace.rootPath ?? 'Sin proyecto abierto'}
      </span>
      <span className="statusbar-spacer" />
      {snapshot !== null ? (
        <span className="statusbar-item">
          {snapshot.watcher === 'active' ? 'Observando cambios' : 'Observador inactivo'}
        </span>
      ) : null}
      <span className="statusbar-item">
        {connected && browserState !== null && browserState.config !== null
          ? `N0 · ${browserState.config.frontend.host} → ${browserState.config.backend.host} · ${
              browser.state.requests.length
            } peticiones`
          : 'N0 · sin sesión de captura'}
      </span>
    </footer>
  );
}
