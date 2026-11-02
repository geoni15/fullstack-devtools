import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu } from 'electron';
import { IPC_CHANNELS, type CodeLocation, type CodeLocationRequest } from '@bdt/protocol';
import { BrowserController } from './browser/controller';
import { registerBrowserWindowIpc } from './browser/chrome-ipc';
import { normalizeCodeLocation } from './code-location';
import { registerAppProtocol, registerAppScheme } from './app-protocol';
import { APP_INDEX_URL, DEV_SERVER_URL } from './config';
import { registerIpcHandlers } from './ipc';
import { createLogger } from './logger';
import { createMainWindow, type MainWindowOptions } from './window';
import { WorkspaceService } from './workspace';

const log = createLogger('main');

registerAppScheme();

function resolveDevServerUrl(): string | null {
  const raw = process.env.VITE_DEV_SERVER_URL;
  if (raw === undefined || raw === '') {
    return null;
  }
  if (raw !== DEV_SERVER_URL) {
    throw new Error(
      `VITE_DEV_SERVER_URL no permitida: ${raw}. Solo se admite ${DEV_SERVER_URL} en desarrollo.`,
    );
  }
  return raw;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let mainWindowOptions: MainWindowOptions | null = null;

  const browserHolder: { current: BrowserController | null } = { current: null };
  const workspace = new WorkspaceService(() => {
    const window = mainWindow;
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.workspaceChanged, {});
    }
    browserHolder.current?.handleWorkspaceChanged();
  });

  const revealCode = (request: CodeLocationRequest): CodeLocation | null => {
    const location = normalizeCodeLocation(workspace.getRootPath(), request);
    if (location === null) {
      return null;
    }
    const window = mainWindow;
    if (window === null || window.isDestroyed()) {
      return null;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    window.webContents.send(IPC_CHANNELS.revealLocation, location);
    return location;
  };

  const browser = new BrowserController(() => mainWindow, createLogger('browser'), {
    getWorkspaceRoot: () => workspace.getRootPath(),
    chromePreloadPath: fileURLToPath(new URL('../preload/browser-chrome.cjs', import.meta.url)),
    panelPreloadPath: fileURLToPath(new URL('../preload/inspection-panel.cjs', import.meta.url)),
    mapPreloadPath: fileURLToPath(new URL('../preload/map.cjs', import.meta.url)),
  });
  browserHolder.current = browser;

  app.on('second-instance', () => {
    if (mainWindow === null) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  app
    .whenReady()
    .then(() => {
      Menu.setApplicationMenu(null);

      const devServerUrl = resolveDevServerUrl();
      const preloadPath = fileURLToPath(new URL('../preload/preload.cjs', import.meta.url));
      const rendererDir = fileURLToPath(new URL('../renderer', import.meta.url));

      registerAppProtocol(rendererDir);
      registerIpcHandlers({
        getMainWindow: () => mainWindow,
        workspace,
        browser,
        revealCode,
        logger: createLogger('ipc'),
      });
      registerBrowserWindowIpc(browser, createLogger('browser-window'), revealCode);

      mainWindowOptions = { preloadPath, devServerUrl, log };
      mainWindow = createMainWindow(mainWindowOptions);
      mainWindow.on('closed', () => {
        browser.handleWindowClosed();
        mainWindow = null;
      });

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length !== 0 || mainWindowOptions === null) {
          return;
        }
        mainWindow = createMainWindow(mainWindowOptions);
        mainWindow.on('closed', () => {
          browser.handleWindowClosed();
          mainWindow = null;
        });
      });

      log.info('Aplicación iniciada', {
        mode: devServerUrl === null ? 'produccion' : 'desarrollo',
        target: devServerUrl ?? APP_INDEX_URL,
      });
    })
    .catch((error: unknown) => {
      log.error('Fallo al iniciar la aplicación', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    browser.dispose();
    workspace.dispose();
  });
}
