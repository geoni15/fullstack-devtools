import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserMode, LaunchRequest, ProjectSetupDetection } from '@bdt/protocol';
import { bdt } from '../api';
import { useBrowser } from '../state/browser-store';

interface AppViewProps {
  active: boolean;
}

interface TouchedFields {
  frontendPort: boolean;
  backendPort: boolean;
  frontendCommand: boolean;
  frontendCwd: boolean;
  backendCommand: boolean;
  backendCwd: boolean;
}

const UNTOUCHED: TouchedFields = {
  frontendPort: false,
  backendPort: false,
  frontendCommand: false,
  frontendCwd: false,
  backendCommand: false,
  backendCwd: false,
};

function composeUrl(base: string, port: string): string {
  const raw = base.trim();
  if (raw === '') {
    throw new Error('Indica la URL base, por ejemplo http://localhost.');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`La URL «${raw}» no es válida.`);
  }
  const trimmedPort = port.trim();
  if (trimmedPort !== '') {
    const value = Number(trimmedPort);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error('El puerto debe ser un número entero entre 1 y 65535.');
    }
    url.port = String(value);
  }
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setupLabel(detection: ProjectSetupDetection | null, detecting: boolean): string {
  if (detecting && detection === null) {
    return 'Buscando package.json en el proyecto…';
  }
  if (detection === null) {
    return 'Sin package.json detectados. Escribe los comandos a mano o arranca las apps por tu cuenta.';
  }
  const parts: string[] = [];
  const frontend = detection.frontend;
  if (frontend !== null) {
    const name = frontend.framework ?? frontend.packageName ?? frontend.dir;
    const script = frontend.launchCommand ?? 'sin script de arranque';
    const port = frontend.port === null ? '' : ` · puerto ${String(frontend.port)}`;
    parts.push(`Frontend: ${name} · ${script}${port}`);
  }
  const backend = detection.backend;
  if (backend !== null) {
    const name = backend.framework ?? backend.packageName ?? backend.dir;
    const script = backend.launchCommand ?? 'sin script de arranque';
    const port = backend.port === null ? '' : ` · puerto ${String(backend.port)}`;
    parts.push(`Backend: ${name} · ${script}${port}`);
  }
  if (parts.length === 0) {
    return `Se revisaron ${String(detection.packageCount)} package.json sin un frontend o backend reconocible.`;
  }
  return parts.join(' — ');
}

export function AppView({ active }: AppViewProps) {
  const {
    state,
    connect,
    disconnect,
    reload,
    clearRequests,
    setInspection,
    focusBrowserWindow,
    dismissError,
  } = useBrowser();
  const browser = state.state;
  const connected = browser?.connected ?? false;
  const busy = state.busy;
  const [frontendBase, setFrontendBase] = useState('http://localhost');
  const [frontendPort, setFrontendPort] = useState('5173');
  const [frontendCommand, setFrontendCommand] = useState('');
  const [frontendCwd, setFrontendCwd] = useState('');
  const [backendBase, setBackendBase] = useState('http://localhost');
  const [backendPort, setBackendPort] = useState('8080');
  const [backendCommand, setBackendCommand] = useState('');
  const [backendCwd, setBackendCwd] = useState('');
  const [inspectorPort, setInspectorPort] = useState('');
  const [mode, setMode] = useState<BrowserMode>('window');
  const [detected, setDetected] = useState<ProjectSetupDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const touchedRef = useRef<TouchedFields>({ ...UNTOUCHED });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const send = (): void => {
      const rect = host.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: active && connected && mode === 'embedded' && rect.width > 0 && rect.height > 0,
      };
      boundsRef.current = bounds;
      void bdt.setBrowserBounds(bounds).catch(() => undefined);
    };
    const observer = new ResizeObserver(send);
    observer.observe(host);
    window.addEventListener('resize', send);
    send();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', send);
      const last = boundsRef.current;
      if (last.width > 0 && last.height > 0) {
        void bdt.setBrowserBounds({ ...last, visible: false }).catch(() => undefined);
      }
    };
  }, [active, connected, mode]);

  useEffect(() => {
    let activeDetection = true;

    const apply = (detection: ProjectSetupDetection | null): void => {
      setDetected(detection);
      const touched = touchedRef.current;
      const frontend = detection?.frontend ?? null;
      if (frontend === null) {
        if (!touched.frontendPort) setFrontendPort('5173');
        if (!touched.frontendCommand) setFrontendCommand('');
        if (!touched.frontendCwd) setFrontendCwd('');
      } else {
        if (frontend.port !== null && !touched.frontendPort) setFrontendPort(String(frontend.port));
        if (!touched.frontendCommand) {
          setFrontendCommand(frontend.launchCommand ?? '');
        }
        if (!touched.frontendCwd) {
          setFrontendCwd(frontend.launchCwd === '.' ? '' : frontend.launchCwd);
        }
      }
      const backend = detection?.backend ?? null;
      if (backend === null) {
        if (!touched.backendPort) setBackendPort('8080');
        if (!touched.backendCommand) setBackendCommand('');
        if (!touched.backendCwd) setBackendCwd('');
      } else {
        if (backend.port !== null && !touched.backendPort) setBackendPort(String(backend.port));
        if (!touched.backendCommand) {
          setBackendCommand(backend.launchCommand ?? '');
        }
        if (!touched.backendCwd) {
          setBackendCwd(backend.launchCwd === '.' ? '' : backend.launchCwd);
        }
      }
    };

    const load = async (resetTouched: boolean): Promise<void> => {
      if (resetTouched) {
        touchedRef.current = { ...UNTOUCHED };
      }
      setDetecting(true);
      try {
        const result = await bdt.detectProjectSetup();
        if (!activeDetection) return;
        apply(result.ok ? result.value : null);
      } catch {
        if (activeDetection) apply(null);
      } finally {
        if (activeDetection) setDetecting(false);
      }
    };

    void load(false);
    const unsubscribe = bdt.onWorkspaceChanged(() => {
      void load(true);
    });
    return () => {
      activeDetection = false;
      unsubscribe();
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalError(null);
    setDismissedError(null);
    let frontendUrl: string;
    let backendUrl: string;
    let nodeInspectorPort: number | null = null;
    let frontendLaunch: LaunchRequest | null = null;
    let backendLaunch: LaunchRequest | null = null;
    try {
      frontendUrl = composeUrl(frontendBase, frontendPort);
      backendUrl = composeUrl(backendBase, backendPort);
      const trimmedInspector = inspectorPort.trim();
      if (trimmedInspector !== '') {
        const value = Number(trimmedInspector);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error('El puerto del inspector de Node debe estar entre 1 y 65535.');
        }
        nodeInspectorPort = value;
      }
      const frontend = frontendCommand.trim();
      if (frontend !== '') {
        frontendLaunch = { command: frontend, cwd: frontendCwd.trim() };
      }
      const backend = backendCommand.trim();
      if (backend !== '') {
        backendLaunch = { command: backend, cwd: backendCwd.trim() };
      }
    } catch (error) {
      setLocalError(errorMessage(error));
      return;
    }
    void connect(frontendUrl, backendUrl, mode, nodeInspectorPort, frontendLaunch, backendLaunch);
  };

  const computedError = localError ?? state.error ?? browser?.error ?? null;
  const error = computedError === dismissedError ? null : computedError;
  const handleDismiss = (): void => {
    setLocalError(null);
    setDismissedError(computedError);
    dismissError();
  };
  const config = browser?.config ?? null;
  const loading = browser?.loading ?? false;
  const detectionEvidence =
    detected === null
      ? ''
      : [...(detected.frontend?.evidence ?? []), ...(detected.backend?.evidence ?? [])].join(' · ');

  return (
    <div className="app-view">
      {connected && config !== null ? (
        <>
          <div className="app-toolbar" data-testid="app-toolbar">
            <span className={`app-status${browser?.captureActive === true ? ' is-live' : ''}`}>
              {browser?.captureActive === true ? 'CAPTURANDO' : 'SIN CAPTURA'}
            </span>
            <span className="app-mode" data-testid="app-mode">
              {config.mode === 'window' ? 'VENTANA' : 'INTEGRADO'}
            </span>
            {config.frontendLaunch !== null && config.frontendLaunch.pid !== null ? (
              <span
                className="app-mode"
                data-testid="app-launch-frontend"
                title={`PID ${String(config.frontendLaunch.pid)}`}
              >
                FRONTEND LANZADO
              </span>
            ) : null}
            {config.backendLaunch !== null && config.backendLaunch.pid !== null ? (
              <span
                className="app-mode"
                data-testid="app-launch"
                title={`PID ${String(config.backendLaunch.pid)} · inspector 127.0.0.1:${String(
                  config.backendLaunch.inspectorPort ?? '',
                )}`}
              >
                BACKEND LANZADO
              </span>
            ) : null}
            <span className="app-title" title={browser?.currentUrl ?? config.frontend.url}>
              {browser?.title ?? config.frontend.host}
            </span>
            {loading ? <span className="app-loading">Cargando</span> : null}
            <button
              type="button"
              className={`button small${browser?.inspectionEnabled === true ? ' is-on' : ''}`}
              onClick={() => void setInspection(!(browser?.inspectionEnabled ?? false))}
              data-testid="app-inspect"
            >
              {browser?.inspectionEnabled === true ? 'Devtool ON' : 'Devtool OFF'}
            </button>
            {config.mode === 'window' ? (
              <button
                type="button"
                className="button small"
                onClick={() => void focusBrowserWindow()}
                data-testid="app-focus"
              >
                Mostrar ventana
              </button>
            ) : null}
            <button
              type="button"
              className="button small"
              onClick={() => void reload()}
              data-testid="app-reload"
            >
              Recargar
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => void clearRequests()}
              data-testid="app-clear"
            >
              Limpiar
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => void disconnect()}
              data-testid="app-disconnect"
            >
              Desconectar
            </button>
          </div>
          {error !== null ? (
            <div className="app-error" data-testid="app-error">
              <span>{error}</span>
              <button type="button" className="button small" onClick={handleDismiss}>
                Descartar
              </button>
            </div>
          ) : null}
          {config.mode === 'window' ? (
            <div className="app-window-panel" data-testid="app-window-panel">
              <div>
                <p className="empty-title">El navegador está en una ventana separada</p>
                <p className="empty-text">
                  Esa ventana tiene su propia barra de direcciones. Con la inspección activa, el
                  panel queda fijo a la derecha y la página se ajusta para dejarle sitio: un clic en
                  cualquier elemento muestra su manejador, las peticiones al servidor —también las
                  que la página ya cargó de fondo—, la función del backend con su archivo y líneas
                  numeradas, y la línea que se ejecutó. La app arrancó lo que no estaba en marcha y
                  detendrá esos procesos al desconectar.
                </p>
              </div>
              <button
                type="button"
                className="button primary"
                onClick={() => void focusBrowserWindow()}
                data-testid="app-show-window"
              >
                Mostrar ventana
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <form className="app-connect" onSubmit={handleSubmit} data-testid="app-connect-form">
          <p className="empty-title">Conectar una aplicación web</p>
          <p className="empty-text">
            La app lee todos los package.json del proyecto para deducir cómo arrancar el frontend y
            el backend, rellena los comandos y solo inicia lo que no esté ya en marcha. Los procesos
            se detienen al desconectar. Solo se admiten direcciones locales (localhost, 127.0.0.1 o
            ::1); la aplicación se abre aislada, sin acceso a Node, archivos ni IPC.
          </p>

          <div className="connect-mode" role="radiogroup" aria-label="Modo del navegador">
            <span className="connect-role">Navegador</span>
            <label className="mode-option">
              <input
                type="radio"
                name="browser-mode"
                value="window"
                checked={mode === 'window'}
                onChange={() => setMode('window')}
                data-testid="mode-window"
              />
              <span>Ventana separada (recomendado)</span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name="browser-mode"
                value="embedded"
                checked={mode === 'embedded'}
                onChange={() => setMode('embedded')}
                data-testid="mode-embedded"
              />
              <span>Integrado en el IDE</span>
            </label>
          </div>

          <div
            className="connect-detection"
            data-testid="setup-detection"
            title={detectionEvidence}
          >
            <span className="connect-role">Detección automática</span>
            <span className="connect-role-note">{setupLabel(detected, detecting)}</span>
          </div>

          <div className="connect-grid">
            <div className="connect-group">
              <span className="connect-role">Frontend</span>
              <span className="connect-role-note">Página que se muestra en la vista embebida</span>
              <label className="connect-field">
                <span>URL</span>
                <input
                  type="text"
                  value={frontendBase}
                  onChange={(event) => setFrontendBase(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="frontend-url"
                />
              </label>
              <label className="connect-field">
                <span>Puerto</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={frontendPort}
                  onChange={(event) => {
                    touchedRef.current.frontendPort = true;
                    setFrontendPort(event.target.value);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="frontend-port"
                />
              </label>
              <label className="connect-field">
                <span>Comando (automático)</span>
                <input
                  type="text"
                  value={frontendCommand}
                  onChange={(event) => {
                    touchedRef.current.frontendCommand = true;
                    setFrontendCommand(event.target.value);
                  }}
                  placeholder="npm run dev"
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="frontend-command"
                />
              </label>
              <label className="connect-field">
                <span>Directorio (opcional)</span>
                <input
                  type="text"
                  value={frontendCwd}
                  onChange={(event) => {
                    touchedRef.current.frontendCwd = true;
                    setFrontendCwd(event.target.value);
                  }}
                  placeholder="."
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="frontend-cwd"
                />
              </label>
            </div>

            <div className="connect-group">
              <span className="connect-role">Backend</span>
              <span className="connect-role-note">
                Origen de la API que se clasifica en el timeline
              </span>
              <label className="connect-field">
                <span>URL</span>
                <input
                  type="text"
                  value={backendBase}
                  onChange={(event) => setBackendBase(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="backend-url"
                />
              </label>
              <label className="connect-field">
                <span>Puerto</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={backendPort}
                  onChange={(event) => {
                    touchedRef.current.backendPort = true;
                    setBackendPort(event.target.value);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="backend-port"
                />
              </label>
              <label className="connect-field">
                <span>Inspector Node (opcional)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={inspectorPort}
                  onChange={(event) => setInspectorPort(event.target.value)}
                  placeholder="automático"
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="inspector-port"
                />
              </label>
              <label className="connect-field">
                <span>Comando (automático)</span>
                <input
                  type="text"
                  value={backendCommand}
                  onChange={(event) => {
                    touchedRef.current.backendCommand = true;
                    setBackendCommand(event.target.value);
                  }}
                  placeholder="node backend/server.js o npm run dev"
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="backend-command"
                />
              </label>
              <label className="connect-field">
                <span>Directorio (opcional)</span>
                <input
                  type="text"
                  value={backendCwd}
                  onChange={(event) => {
                    touchedRef.current.backendCwd = true;
                    setBackendCwd(event.target.value);
                  }}
                  placeholder="."
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="backend-cwd"
                />
              </label>
            </div>
          </div>

          {error !== null ? (
            <div className="app-error" data-testid="app-error">
              <span>{error}</span>
              <button type="button" className="button small" onClick={handleDismiss}>
                Descartar
              </button>
            </div>
          ) : null}

          <div className="connect-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy}
              data-testid="connect-submit"
            >
              {busy ? 'Conectando…' : 'Conectar'}
            </button>
            <span className="connect-hint">
              Un comando «node archivo» se inicia con «--inspect» y recibe PORT; un «npm run script»
              arranca sin inspector de Node. La barra solo permite frontend y backend configurados.
              Cuerpos JSON enmascarados.
            </span>
          </div>
        </form>
      )}

      <div
        className="app-frame-host"
        ref={hostRef}
        data-testid="app-frame-host"
        hidden={!connected || config?.mode !== 'embedded'}
      />
    </div>
  );
}
