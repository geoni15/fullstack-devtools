import {
  BdtError,
  ERROR_CODES,
  type BackendLaunchConfig,
  type BackendLaunchRequest,
  type BrowserConfig,
  type BrowserEndpoint,
  type BrowserTargetsRequest,
} from '@bdt/protocol';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function invalid(message: string): BdtError {
  return new BdtError(ERROR_CODES.BROWSER_CONFIG_INVALID, message);
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function parseEndpoint(rawValue: string, label: string): BrowserEndpoint {
  let url: URL;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw invalid(`La URL del ${label} no es válida.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid(`La URL del ${label} debe usar http o https.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid(`La URL del ${label} no puede incluir credenciales.`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw invalid(
      `La URL del ${label} debe apuntar a la máquina local (127.0.0.1, localhost o ::1).`,
    );
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return {
    url: url.toString(),
    origin: url.origin,
    host: url.host,
    port,
  };
}

function parseInspectorPort(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalid('El puerto del inspector de Node debe estar entre 1 y 65535.');
  }
  return value;
}

function parseLaunch(
  request: BackendLaunchRequest | null | undefined,
  label: string,
): BackendLaunchConfig | null {
  if (request === null || request === undefined) {
    return null;
  }
  const command = request.command.trim();
  if (command === '') {
    throw invalid(`El comando para arrancar el ${label} no puede estar vacío.`);
  }
  if (/[\0\r\n]/.test(command)) {
    throw invalid(`El comando para arrancar el ${label} no es válido.`);
  }
  const cwd = request.cwd.trim();
  if (cwd.includes('\0')) {
    throw invalid(`El directorio de trabajo del ${label} no es válido.`);
  }
  return { command, cwd, pid: null, inspectorPort: null };
}

export function parseBrowserTargets(request: BrowserTargetsRequest): BrowserConfig {
  const frontend = parseEndpoint(request.frontendUrl, 'frontend');
  const backend = parseEndpoint(request.backendUrl, 'backend');
  if (frontend.origin === backend.origin) {
    throw invalid('El frontend y el backend deben usar orígenes distintos.');
  }
  if (request.mode !== 'window' && request.mode !== 'embedded') {
    throw invalid('El modo del navegador debe ser «window» o «embedded».');
  }
  const nodeInspectorPort = parseInspectorPort(request.nodeInspectorPort);
  const frontendLaunch = parseLaunch(request.frontendLaunch, 'frontend');
  const backendLaunch = parseLaunch(request.backendLaunch, 'backend');
  if (backendLaunch !== null) {
    backendLaunch.inspectorPort = nodeInspectorPort;
  }
  return {
    frontend,
    backend,
    mode: request.mode,
    nodeInspectorPort,
    frontendLaunch,
    backendLaunch,
  };
}
