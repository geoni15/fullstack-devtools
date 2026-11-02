import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from '@playwright/test';

const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const MARKER = 'fixture-e2e-123';
const SECRET_HEADER = 'token-e2e-secreto';

interface Fixture {
  frontendUrl: string;
  frontendPort: number;
  backendUrl: string;
  backendPort: number;
  close(): Promise<void>;
}

interface ChildViewInfo {
  url: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  windowTitle: string;
}

interface ViewContents {
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  debugger: { sendCommand(method: string, params: unknown): Promise<unknown> };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeout = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // El recurso aún no responde; se reintenta.
    }
    await sleep(100);
  }
  throw new Error(`Tiempo de espera agotado: ${label}`);
}

function backendResponds(backendUrl: string): Promise<boolean> {
  return fetch(`${backendUrl}/api/clientes`, { signal: AbortSignal.timeout(1000) })
    .then((response) => response.ok)
    .catch(() => false);
}

function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function startFixture(workspaceDir: string): Promise<Fixture> {
  const backendPort = await freePort();
  const backendUrl = `http://127.0.0.1:${String(backendPort)}`;
  const backendDir = path.join(workspaceDir, 'backend');
  const serverPath = path.join(backendDir, 'server.js');

  const pgDir = path.join(backendDir, 'node_modules', 'pg');
  fs.mkdirSync(pgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pgDir, 'index.js'),
    [
      'class Client {',
      '  query(sql) {',
      "    return { rows: [{ id: 1, nombre: 'Ana' }], sql };",
      '  }',
      '}',
      '',
      'module.exports = { Client };',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    serverPath,
    [
      "const http = require('node:http');",
      "const { Client } = require('pg');",
      '',
      'function listarClientes(peticion, respuesta) {',
      '  respuesta.writeHead(200, {',
      "    'Content-Type': 'application/json',",
      "    'Access-Control-Allow-Origin': peticion.headers.origin || '*',",
      "    'Access-Control-Allow-Headers': 'authorization',",
      "    'Vary': 'Origin',",
      '  });',
      "  db.query('UPDATE clientes SET visitas = visitas + 1 WHERE id = $1');",
      "  const resultado = db.query('SELECT id, nombre FROM clientes WHERE id = $1');",
      '  respuesta.end(JSON.stringify({ clientes: resultado.rows }));',
      '}',
      '',
      'const db = new Client();',
      '',
      'const rutas = new Map();',
      '',
      'const app = {',
      '  get(ruta, manejador) {',
      "    rutas.set('GET ' + ruta, manejador);",
      '  },',
      '};',
      '',
      "app.get('/api/clientes', listarClientes);",
      '',
      'const servidor = http.createServer((peticion, respuesta) => {',
      "  if (peticion.method === 'OPTIONS') {",
      '    respuesta.writeHead(204, {',
      "      'Access-Control-Allow-Origin': peticion.headers.origin || '*',",
      "      'Access-Control-Allow-Headers': 'authorization',",
      "      'Access-Control-Allow-Methods': 'GET, OPTIONS',",
      "      'Vary': 'Origin',",
      '    });',
      '    respuesta.end();',
      '    return;',
      '  }',
      "  const manejador = rutas.get(peticion.method + ' ' + peticion.url);",
      '  if (manejador) {',
      '    manejador(peticion, respuesta);',
      '    return;',
      '  }',
      '  respuesta.writeHead(404);',
      "  respuesta.end('no encontrado');",
      '});',
      '',
      "servidor.listen(Number(process.env.PORT), '127.0.0.1', () => {",
      "  console.log('backend listo');",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  const appScript = `
async function cargarClientes() {
  const respuesta = await fetch('${backendUrl}/api/clientes', {
    headers: { Authorization: 'Bearer ${SECRET_HEADER}' }
  });
  const datos = await respuesta.json();
  document.getElementById('titulo').textContent = 'Clientes: ' + datos.clientes.length;
}
document.getElementById('cargar').addEventListener('click', cargarClientes);
setTimeout(function () { void cargarClientes(); }, 300);
`;

  const frontend = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/app.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(appScript);
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><title>Fixture Frontend</title></head>
  <body>
    <h1 id="titulo">Fixture pendiente</h1>
    <button id="cargar" type="button">Cargar</button>
    <script src="/app.js"></script>
  </body>
</html>`);
      return;
    }
    response.writeHead(404);
    response.end('no encontrado');
  });
  const frontendPort = await startServer(frontend);
  const frontendUrl = `http://127.0.0.1:${String(frontendPort)}`;
  return {
    frontendUrl,
    frontendPort,
    backendUrl,
    backendPort,
    close: async () => {
      await closeServer(frontend);
    },
  };
}

let fixture: Fixture | null = null;

let electronApp: ElectronApplication;
let appClosed = false;
let page: Page;
let baseDir = '';
let workspaceDir = '';
let userDataDir = '';

function launchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-e2e-'));
  userDataDir = path.join(baseDir, 'user-data');
  fs.mkdirSync(userDataDir, { recursive: true });
  workspaceDir = path.join(baseDir, 'proyecto');
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Proyecto E2E\n', 'utf8');
  fs.writeFileSync(
    path.join(workspaceDir, 'src', 'main.js'),
    `export const MARCADOR = '${MARKER}';\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(workspaceDir, 'node_modules', 'pkg', 'index.js'), 'ignorado', 'utf8');
  fs.writeFileSync(path.join(workspaceDir, '.git', 'config'), 'ignorado', 'utf8');
  fs.writeFileSync(path.join(baseDir, 'secret.txt'), 'fuera de la raíz', 'utf8');

  fixture = await startFixture(workspaceDir);

  electronApp = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    env: launchEnv(),
  });
  page = await electronApp.firstWindow();
  await expect(page.getByRole('button', { name: 'Abrir carpeta' })).toBeVisible();

  await electronApp.evaluate(async ({ dialog }, rootPath: string) => {
    const stubbed = dialog as unknown as {
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
    stubbed.showOpenDialog = async () => ({ canceled: false, filePaths: [rootPath] });
  }, workspaceDir);
});

test.afterAll(async () => {
  if (electronApp !== undefined && !appClosed) {
    await electronApp.close();
  }
  if (fixture !== null) {
    await fixture.close();
  }
  if (baseDir !== '') {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('el renderer no expone Node, require ni canales IPC en bruto', async () => {
  const exposed = await page.evaluate(() => {
    const globalScope = window as unknown as {
      require?: unknown;
      process?: unknown;
      module?: unknown;
      bdt: Record<string, unknown>;
    };
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return {
      requireType: typeof globalScope.require,
      processType: typeof globalScope.process,
      moduleType: typeof globalScope.module,
      hasIpcRenderer: 'ipcRenderer' in globalScope,
      apiKeys: Object.keys(globalScope.bdt).sort(),
      csp: csp?.getAttribute('content') ?? '',
    };
  });

  expect(exposed.requireType).toBe('undefined');
  expect(exposed.processType).toBe('undefined');
  expect(exposed.moduleType).toBe('undefined');
  expect(exposed.hasIpcRenderer).toBe(false);
  expect(exposed.apiKeys).toEqual([
    'clearBrowserRequests',
    'configureBrowser',
    'detectProjectSetup',
    'disconnectBrowser',
    'focusBrowserWindow',
    'getBrowserSnapshot',
    'getState',
    'onBrowserEvent',
    'onRevealLocation',
    'onWorkspaceChanged',
    'openWorkspace',
    'readFile',
    'reloadBrowser',
    'revealCode',
    'scanBrowserSecurity',
    'setBrowserBounds',
    'setBrowserInspection',
  ]);
  expect(exposed.csp).toContain("default-src 'none'");
});

test('abre una carpeta, muestra el árbol e ignora node_modules y .git', async () => {
  await page.getByRole('button', { name: 'Abrir carpeta' }).click();

  await expect(page.getByTestId('tree-file-README.md')).toBeVisible();
  await expect(page.getByTestId('tree-dir-src')).toBeVisible();
  await expect(page.getByTestId('tree-dir-backend')).toBeVisible();
  await expect(page.getByTestId('tree-dir-node_modules')).toHaveCount(0);
  await expect(page.getByTestId('tree-dir-.git')).toHaveCount(0);
  await expect(page.getByText('Observando cambios')).toBeVisible();
});

test('abre un archivo en Monaco en modo solo lectura', async () => {
  await page.getByTestId('tree-dir-src').click();
  await page.getByTestId('tree-file-src/main.js').click();

  await expect(page.getByTestId('monaco-host')).toBeVisible();
  await expect(page.locator('.view-lines')).toContainText(MARKER);

  await page.locator('.monaco-editor').click();
  await page.keyboard.press('x');
  await page.keyboard.press('x');
  await page.waitForTimeout(300);

  const textAfterTyping = await page.locator('.view-lines').innerText();
  expect(textAfterTyping).toContain(MARKER);
  expect(textAfterTyping).not.toContain(`${MARKER}xx`);
});

test('rechaza lecturas fuera de la raíz a través del IPC real', async () => {
  const result = await page.evaluate(async () => {
    const globalScope = window as unknown as {
      bdt: {
        readFile: (
          filePath: string,
        ) => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
      };
    };
    return globalScope.bdt.readFile('../secret.txt');
  });

  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('BDT_E_PATH_ESCAPE');
});

test('el observador de archivos refresca el árbol', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'nuevo.txt'), 'hola', 'utf8');
  await expect(page.getByTestId('tree-file-nuevo.txt')).toBeVisible({ timeout: 15_000 });
});

test('bloquea ventanas nuevas', async () => {
  const opened = await page.evaluate(() => window.open('https://example.com') === null);
  expect(opened).toBe(true);
  expect(electronApp.windows()).toHaveLength(1);
});

function childViews(): Promise<ChildViewInfo[]> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const result: ChildViewInfo[] = [];
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: ViewContents }).webContents;
        if (!contents || contents.isDestroyed()) continue;
        result.push({
          url: contents.getURL(),
          title: contents.getTitle(),
          bounds: child.getBounds(),
          visible: child.getVisible(),
          windowTitle: win.getTitle(),
        });
      }
    }
    return result;
  }) as Promise<ChildViewInfo[]>;
}

function pageViewInfo(): Promise<ChildViewInfo | null> {
  return childViews().then((views) => views.find((view) => view.url.startsWith('http')) ?? null);
}

function panelViewInfo(): Promise<ChildViewInfo | null> {
  return childViews().then((views) => views.find((view) => view.title === 'Inspección') ?? null);
}

function panelEval<T>(source: string): Promise<T | null> {
  return electronApp.evaluate(async ({ BrowserWindow }, code: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: ViewContents }).webContents;
        if (!contents || contents.isDestroyed()) continue;
        if (contents.getTitle() !== 'Inspección') continue;
        return contents.executeJavaScript(code);
      }
    }
    return null;
  }, source) as Promise<T | null>;
}

function panelText(selector: string): Promise<string | null> {
  return panelEval<string | null>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`,
  );
}

function pageViewEvaluate(source: string): Promise<unknown> {
  return electronApp.evaluate(async ({ BrowserWindow }, code: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: ViewContents }).webContents;
        if (!contents || contents.isDestroyed()) continue;
        if (!contents.getURL().startsWith('http')) continue;
        return contents.executeJavaScript(code);
      }
    }
    return null;
  }, source);
}

function pageViewUrl(): Promise<string | null> {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: ViewContents }).webContents;
        if (!contents || contents.isDestroyed()) continue;
        const url = contents.getURL();
        if (!url.startsWith('http')) continue;
        return url;
      }
    }
    return null;
  });
}

function pageViewChildrenCount(): Promise<number> {
  return electronApp.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().reduce(
      (total, win) => total + win.contentView.children.length,
      0,
    ),
  );
}

async function waitForWindowPage(selector: string, timeout = 15_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      try {
        if ((await candidate.locator(selector).count()) > 0) {
          return candidate;
        }
      } catch {
        // La página pudo cerrarse durante el sondeo.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const urls = electronApp.windows().map((candidate) => candidate.url());
  throw new Error(`No se encontró una ventana con ${selector}. Ventanas: ${urls.join(' | ')}`);
}

function browserWindowCount(): Promise<number> {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

function browserChromeContentSize(): Promise<{ width: number; height: number } | null> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const hasPage = win.contentView.children.some((child) => {
        const contents = (child as unknown as { webContents?: { getURL(): string } }).webContents;
        return contents !== undefined && contents.getURL().startsWith('http');
      });
      if (hasPage) {
        const bounds = win.getContentBounds();
        return { width: bounds.width, height: bounds.height };
      }
    }
    return null;
  });
}

function windowTitles(): Promise<string[]> {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => win.getTitle()),
  );
}

function clickPageElement(selector: string): Promise<void> {
  return electronApp.evaluate(async ({ BrowserWindow }, target: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: ViewContents }).webContents;
        if (!contents || contents.isDestroyed()) continue;
        if (!contents.getURL().startsWith('http')) continue;
        win.show();
        win.focus();
        const point = (await contents.executeJavaScript(
          `(() => {
            const element = document.querySelector(${JSON.stringify(target)});
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
          })()`,
        )) as { x: number; y: number } | null;
        if (point === null) {
          throw new Error(`No se encontró ${target} en la página.`);
        }
        const dbg = contents.debugger;
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
        });
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        return;
      }
    }
    throw new Error('No hay ninguna página inspeccionada.');
  }, selector);
}

test('F1/F2: conecta en ventana separada con barra de direcciones y captura N0', async () => {
  if (fixture === null) {
    throw new Error('El fixture HTTP no se inició.');
  }
  const launchedBackendUrl = fixture.backendUrl;
  await page.getByTestId('tab-app').click();
  await expect(page.getByTestId('app-connect-form')).toBeVisible();

  await page.getByTestId('frontend-url').fill('http://127.0.0.1');
  await page.getByTestId('frontend-port').fill(String(fixture.frontendPort));
  await page.getByTestId('backend-url').fill('http://127.0.0.1');
  await page.getByTestId('backend-port').fill(String(fixture.frontendPort));
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('app-error')).toContainText('orígenes distintos');

  await page.getByTestId('backend-port').fill(String(fixture.backendPort));
  await page.getByTestId('backend-command').fill('node backend/server.js');
  await page.getByTestId('connect-submit').click();
  const browserPage = await waitForWindowPage('#url');

  await expect(page.getByTestId('app-toolbar')).toBeVisible();
  await expect(page.getByTestId('app-mode')).toHaveText('VENTANA');
  await expect(page.getByTestId('app-launch')).toHaveText('BACKEND LANZADO');
  await expect(page.getByTestId('app-window-panel')).toBeVisible();
  await waitFor(() => backendResponds(launchedBackendUrl), 'backend lanzado por la app');
  await expect(browserPage.locator('#url')).toHaveValue(
    new RegExp(`127\\.0\\.0\\.1:${String(fixture.frontendPort)}`),
  );
  await expect(page.locator('.statusbar')).toContainText(
    `→ 127.0.0.1:${String(fixture.backendPort)}`,
  );

  const pageView = await pageViewInfo();
  const panelView = await panelViewInfo();
  expect(pageView).not.toBeNull();
  expect(panelView).not.toBeNull();
  expect(panelView?.visible).toBe(true);
  const chromeContent = await browserChromeContentSize();
  expect(chromeContent).not.toBeNull();
  expect(pageView?.bounds.x).toBe(0);
  expect(pageView?.bounds.width).toBe((chromeContent?.width ?? 0) - (panelView?.bounds.width ?? 0));
  expect(pageView?.bounds.width ?? 0).toBeGreaterThan(panelView?.bounds.width ?? 0);
  expect(panelView?.bounds.x).toBe((pageView?.bounds.x ?? 0) + (pageView?.bounds.width ?? 0));
  expect(panelView?.bounds.width).toBeGreaterThanOrEqual(300);
  expect(await windowTitles()).not.toContain('Inspección');
  expect(await browserWindowCount()).toBe(2);

  await expect.poll(() => panelText('#runtime-status'), { timeout: 20_000 }).toBe('INSPECTOR ON');
  await expect
    .poll(() => panelText('#runtime-message'), { timeout: 20_000 })
    .toContain('1 ruta marcada');

  await page.getByTestId('app-reload').click();

  await page.getByTestId('bottom-tab-peticiones').click();
  await page.getByTestId('filter-backend').click();
  const getRow = page
    .locator('.request-row')
    .filter({ hasText: '/api/clientes' })
    .filter({ hasText: 'GET' })
    .first();
  await expect(getRow).toBeVisible();
  await getRow.click();

  const detail = page.locator('.request-detail').first();
  await expect(detail).toContainText('Cabeceras de la petición');
  await expect(detail).toContainText('[enmascarado]');
  await expect(detail).not.toContainText(SECRET_HEADER);
  await expect(detail.locator('.initiator-fn').first()).toContainText('cargarClientes');

  await browserPage.locator('#url').fill(`${fixture.frontendUrl}/?vista=2`);
  await browserPage.locator('#url').press('Enter');
  await expect
    .poll(() => pageViewUrl(), { timeout: 15_000 })
    .toBe(`${fixture.frontendUrl}/?vista=2`);

  await browserPage.locator('#url').fill('https://example.com/');
  await browserPage.locator('#url').press('Enter');
  await expect(browserPage.locator('#message')).toContainText('Solo se puede navegar');
  expect(await pageViewUrl()).toBe(`${fixture.frontendUrl}/?vista=2`);

  const probes = await pageViewEvaluate(
    '({ requireType: typeof require, processType: typeof process, bdtType: typeof window.bdt, title: document.title })',
  );
  expect(probes).toEqual({
    requireType: 'undefined',
    processType: 'undefined',
    bdtType: 'undefined',
    title: 'Fixture Frontend',
  });

  await pageViewEvaluate("window.location.href = 'https://example.com/'").catch(() => undefined);
  await page.waitForTimeout(800);
  expect(await pageViewUrl()).toBe(`${fixture.frontendUrl}/?vista=2`);

  const imageBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.contentView.children.length > 0,
    );
    if (!win) return '';
    const image = await win.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(baseDir, 'f1-window.png'), Buffer.from(imageBase64, 'base64'));
});

test('F2: el clic abre el panel fijo con la función, sus líneas y la ejecución N2', async () => {
  await clickPageElement('#cargar');

  await expect.poll(() => panelText('#element'), { timeout: 15_000 }).toContain('Cargar');
  await expect.poll(() => panelText('#handler'), { timeout: 15_000 }).toContain('cargarClientes');
  await expect.poll(() => panelText('#requests'), { timeout: 15_000 }).toContain('/api/clientes');
  await expect
    .poll(() => panelText('#handler-code-file'), { timeout: 15_000 })
    .toContain('/app.js');
  await expect
    .poll(() => panelText('#handler-code'), { timeout: 15_000 })
    .toContain('cargarClientes');
  await expect.poll(() => panelText('#endpoint'), { timeout: 15_000 }).toBe('GET /api/clientes');
  const requestTime = await panelEval<string | null>(
    'document.querySelector("#requests .time")?.textContent ?? null',
  );
  expect(requestTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  await expect.poll(() => panelText('#sequence'), { timeout: 15_000 }).toContain('HTTP');
  await expect.poll(() => panelText('#sequence'), { timeout: 20_000 }).toContain('RESPUESTA');
  await expect.poll(() => panelText('#backend'), { timeout: 15_000 }).toContain('listarClientes');
  await expect
    .poll(() => panelText('#backend-loc'), { timeout: 15_000 })
    .toContain('backend/server.js:4–14');
  await expect
    .poll(() => panelText('#backend-code'), { timeout: 15_000 })
    .toContain('function listarClientes');
  await expect.poll(() => panelText('#evidence'), { timeout: 15_000 }).toContain('STATIC');
  await expect
    .poll(() => panelText('#response-body'), { timeout: 20_000 })
    .toContain('"nombre": "Ana"');

  await expect.poll(() => panelText('#level'), { timeout: 25_000 }).toBe('N2');
  await expect
    .poll(() => panelText('#execution-loc'), { timeout: 25_000 })
    .toContain('listarClientes · backend/server.js:');
  await expect
    .poll(() => panelText('#breakpoints'), { timeout: 25_000 })
    .toContain('GET /api/clientes');
  await expect.poll(() => panelText('#evidence'), { timeout: 15_000 }).toContain('RUNTIME');

  const backendNumbers = await panelEval<string[]>(
    'Array.from(document.querySelectorAll("#backend-code .code-number")).map((node) => node.textContent)',
  );
  expect(backendNumbers).toContain('4');
  expect(backendNumbers).toContain('14');

  const executed = await panelEval<{ number: string | null; text: string | null } | null>(
    '(() => { const row = document.querySelector("#execution-code .code-line.is-executed"); if (!row) return null; return { number: row.querySelector(".code-number")?.textContent ?? null, text: row.querySelector(".code-text")?.textContent ?? null }; })()',
  );
  expect(['4', '5']).toContain(executed?.number ?? '');
  expect(executed?.text ?? '').toMatch(/listarClientes|respuesta\.writeHead/);

  expect(await windowTitles()).not.toContain('Inspección');
  expect(await browserWindowCount()).toBe(2);

  const imageBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: ViewContents }).webContents;
        if (!contents || contents.isDestroyed() || contents.getTitle() !== 'Inspección') {
          continue;
        }
        const image = await contents.capturePage();
        return image.toPNG().toString('base64');
      }
    }
    return '';
  });
  fs.writeFileSync(path.join(baseDir, 'f2-panel.png'), Buffer.from(imageBase64, 'base64'));
});

test('SQL: muestra las consultas del manejador y confirma la línea ejecutada', async () => {
  await clickPageElement('#cargar');

  await expect.poll(() => panelText('#queries'), { timeout: 15_000 }).toContain('UPDATE');
  await expect.poll(() => panelText('#queries'), { timeout: 15_000 }).toContain('SELECT');
  await expect.poll(() => panelText('#queries'), { timeout: 15_000 }).toContain('clientes');
  await expect.poll(() => panelText('#queries'), { timeout: 15_000 }).toContain('lee clientes');
  await expect.poll(() => panelText('#queries'), { timeout: 15_000 }).toContain('escribe clientes');
  await expect.poll(() => panelText('#queries'), { timeout: 20_000 }).toContain('OBSERVADA');
  await expect
    .poll(
      () => panelEval<number>('document.querySelectorAll("#queries .query.is-observed").length'),
      { timeout: 20_000 },
    )
    .toBe(2);

  const sqlText = await panelEval<string>(
    'Array.from(document.querySelectorAll("#queries .sql")).map((node) => node.textContent).join(" | ")',
  );
  expect(sqlText).toContain('$1');
  expect(sqlText).not.toContain('Bearer');
});

test('Registro: log cronológico con filtros y peticiones en pestaña propia', async () => {
  await page.getByTestId('bottom-tab-peticiones').click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.locator('.request-row').first()).toBeVisible();
  const rowTime = await page.locator('.request-time').first().innerText();
  expect(rowTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  const firstRow = page.locator('.request-row').first();
  if ((await firstRow.getAttribute('aria-expanded')) !== 'true') {
    await firstRow.click();
  }
  const timelineDetail = page.locator('.request-detail').first();
  await expect(timelineDetail).toContainText('Secuencia');
  await expect(timelineDetail).toContainText('HTTP');

  await page.getByTestId('bottom-tab-registro').click();
  const log = page.getByTestId('activity-log');
  await expect(log).toBeVisible();

  await clickPageElement('#cargar');

  await expect.poll(() => log.innerText(), { timeout: 20_000 }).toContain('Clic en button');
  await expect.poll(() => log.innerText(), { timeout: 20_000 }).toContain('/api/clientes');
  await expect
    .poll(() => log.innerText(), { timeout: 25_000 })
    .toContain('Ejecución de listarClientes');
  await expect.poll(() => log.innerText(), { timeout: 25_000 }).toContain('SQL SELECT');
  await expect
    .poll(() => page.locator('.activity-row[data-category="sql"]').count(), { timeout: 25_000 })
    .toBeGreaterThan(0);
  const sqlRow = page
    .locator('.activity-row[data-category="sql"]')
    .filter({ hasText: 'SQL SELECT' })
    .first();
  await expect(sqlRow).toContainText('pg');
  await expect(sqlRow).toContainText('clientes');

  await page.getByTestId('activity-filter-sql').click();
  const sqlCategories = await page
    .locator('.activity-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-category')));
  expect(sqlCategories.length).toBeGreaterThan(0);
  expect(sqlCategories.every((category) => category === 'sql')).toBe(true);

  await page.getByTestId('activity-filter-request').click();
  await expect(
    page
      .locator('.activity-row[data-category="request"]')
      .filter({ hasText: '/api/clientes' })
      .first(),
  ).toBeVisible();

  await page.getByTestId('activity-filter-frontend').click();
  await expect(page.locator('.activity-row[data-category="frontend"]').first()).toBeVisible();
  const frontendCategories = await page
    .locator('.activity-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-category')));
  expect(frontendCategories.every((category) => category === 'frontend')).toBe(true);

  await page.getByTestId('activity-filter-all').click();
  await expect(page.getByTestId('activity-filter-all')).toHaveAttribute('aria-selected', 'true');
});

test('Mapa: alterna orden cronológico, estructural y jerárquico por archivo', async () => {
  await panelEval('document.getElementById("map-toggle")?.click()');
  const mapPage = await waitForWindowPage('#map-order-structural');

  await expect(mapPage.locator('#map-order-structural')).toBeVisible();
  await expect
    .poll(
      async () => {
        const stats = await mapPage.locator('#map-stats').innerText();
        const match = /(\d+) archivos/.exec(stats);
        return match === null ? 0 : Number(match[1]);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  await mapPage.locator('#map-order-structural').click();
  await expect(mapPage.locator('#map-order-structural')).toHaveAttribute('aria-pressed', 'true');
  await expect(mapPage.locator('#map-status')).toContainText('Orden estructural');
  await expect(mapPage.locator('.flow-layer-label').first()).toContainText('ARCHIVO');

  await mapPage.locator('#map-order-hierarchy').click();
  await expect(mapPage.locator('#map-order-hierarchy')).toHaveAttribute('aria-pressed', 'true');
  await expect(mapPage.locator('#map-status')).toContainText('Orden jerárquico');
  await expect(mapPage.locator('.flow-layer-label').first()).toContainText('NIVEL 0');

  await mapPage.locator('#map-order-chrono').click();
  await expect(mapPage.locator('#map-order-chrono')).toHaveAttribute('aria-pressed', 'true');
  await expect(mapPage.locator('#map-status')).not.toContainText('Orden estructural');

  await mapPage.locator('#map-page').click();
  await expect.poll(() => browserWindowCount()).toBe(2);
});

test('F2: la inspección OFF oculta el panel, la página recupera el ancho y desconectar cierra las vistas', async () => {
  if (fixture === null) {
    throw new Error('El fixture HTTP no se inició.');
  }
  const launchedBackendUrl = fixture.backendUrl;
  const withPanel = await pageViewInfo();
  expect(withPanel).not.toBeNull();
  await waitFor(() => backendResponds(launchedBackendUrl), 'backend lanzado por la app');
  const innerWidthWithPanel = Number(await pageViewEvaluate('window.innerWidth'));
  const chromePage = await waitForWindowPage('#inspect');

  await chromePage.locator('#inspect').click();
  await expect.poll(async () => (await panelViewInfo())?.visible ?? null).toBe(false);
  await expect(chromePage.locator('#inspect')).toHaveText('Inspección OFF');
  const withoutPanel = await pageViewInfo();
  expect(withoutPanel?.bounds.width ?? 0).toBeGreaterThan(withPanel?.bounds.width ?? 0);
  expect(await pageViewEvaluate('window.innerWidth')).toBeGreaterThan(innerWidthWithPanel);

  await clickPageElement('#cargar');
  await page.waitForTimeout(800);
  expect((await panelViewInfo())?.visible).toBe(false);
  expect(await windowTitles()).not.toContain('Inspección');

  await chromePage.locator('#inspect').click();
  await expect.poll(async () => (await panelViewInfo())?.visible ?? null).toBe(true);
  await expect(chromePage.locator('#inspect')).toHaveText('Inspección ON');
  expect(await pageViewEvaluate('window.innerWidth')).toBe(innerWidthWithPanel);
  await expect.poll(() => panelText('#level'), { timeout: 10_000 }).toBe('N0');

  await page.getByTestId('app-disconnect').click();
  await expect(page.getByTestId('app-connect-form')).toBeVisible();
  await expect.poll(() => browserWindowCount()).toBe(1);
  expect(await pageViewChildrenCount()).toBe(0);
  await expect.poll(() => backendResponds(launchedBackendUrl), { timeout: 15_000 }).toBe(false);
});

test('F1: el modo integrado sigue disponible', async () => {
  if (fixture === null) {
    throw new Error('El fixture HTTP no se inició.');
  }
  const launchedBackendUrl = fixture.backendUrl;
  await page.getByTestId('frontend-url').fill('http://127.0.0.1');
  await page.getByTestId('frontend-port').fill(String(fixture.frontendPort));
  await page.getByTestId('backend-url').fill('http://127.0.0.1');
  await page.getByTestId('backend-port').fill(String(fixture.backendPort));
  await page.getByTestId('backend-command').fill('node backend/server.js');
  await page.getByTestId('mode-embedded').check();
  await page.getByTestId('connect-submit').click();

  await expect(page.getByTestId('app-mode')).toHaveText('INTEGRADO');
  await expect(page.getByTestId('app-launch')).toHaveText('BACKEND LANZADO');
  await expect(page.getByTestId('app-frame-host')).toBeVisible();
  expect(await browserWindowCount()).toBe(1);
  await waitFor(() => backendResponds(launchedBackendUrl), 'backend lanzado por la app');
  expect(await pageViewUrl()).toBe(`${fixture.frontendUrl}/`);
  const probes = await pageViewEvaluate(
    '({ requireType: typeof require, processType: typeof process, bdtType: typeof window.bdt })',
  );
  expect(probes).toEqual({
    requireType: 'undefined',
    processType: 'undefined',
    bdtType: 'undefined',
  });

  await page.getByTestId('app-disconnect').click();
  await expect(page.getByTestId('app-connect-form')).toBeVisible();
  expect(await pageViewChildrenCount()).toBe(0);
  await expect.poll(() => backendResponds(launchedBackendUrl), { timeout: 15_000 }).toBe(false);
});

test('bloquea la navegación fuera del origen permitido', async () => {
  const before = page.url();
  await page.evaluate(() => {
    window.location.href = 'https://example.com';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  expect(await browserWindowCount()).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
});

test('al cerrar la app se detiene el backend lanzado', async () => {
  if (fixture === null) {
    throw new Error('El fixture HTTP no se inició.');
  }
  if (electronApp === undefined) {
    throw new Error('La aplicación Electron no está disponible.');
  }
  const launchedBackendUrl = fixture.backendUrl;
  await page.getByTestId('frontend-url').fill('http://127.0.0.1');
  await page.getByTestId('frontend-port').fill(String(fixture.frontendPort));
  await page.getByTestId('backend-url').fill('http://127.0.0.1');
  await page.getByTestId('backend-port').fill(String(fixture.backendPort));
  await page.getByTestId('backend-command').fill('node backend/server.js');
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('app-launch')).toHaveText('BACKEND LANZADO');
  await waitFor(() => backendResponds(launchedBackendUrl), 'backend lanzado por la app');

  await electronApp.close();
  appClosed = true;
  await expect.poll(() => backendResponds(launchedBackendUrl), { timeout: 15_000 }).toBe(false);
});
