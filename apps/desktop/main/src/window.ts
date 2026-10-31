import { BrowserWindow } from 'electron';
import { APP_INDEX_URL } from './config';
import type { Logger } from './logger';
import { guardWebContents, hardenSession } from './security';

export interface MainWindowOptions {
  preloadPath: string;
  devServerUrl: string | null;
  log: Logger;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1116',
    title: 'Backend DevTools Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      allowRunningInsecureContent: false,
    },
  });

  window.setMenuBarVisibility(false);
  hardenSession(window.webContents.session);
  guardWebContents(window.webContents, options.devServerUrl, options.log);

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    options.log.error('El proceso de render se ha detenido', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  const targetUrl = options.devServerUrl ?? APP_INDEX_URL;
  void window.loadURL(targetUrl).catch((error: unknown) => {
    options.log.error('No se pudo cargar la interfaz', {
      target: targetUrl,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return window;
}
