import { BrowserWindow, type WebContents } from 'electron';
import { BROWSER_PANEL_CHANNELS, type FlowMapState } from '@bdt/protocol';
import type { Logger } from '../logger';
import { hardenSession } from '../security';
import { FLOW_MAP_HTML } from './ui-html';

const MAP_PARTITION = 'bdt-flow-map';
const MAP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FLOW_MAP_HTML)}`;

export class FlowMapWindow {
  private window: BrowserWindow | null = null;
  private ready = false;
  private state: FlowMapState | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly log: Logger,
    private readonly onClosed: () => void,
  ) {}

  open(): void {
    const current = this.window;
    if (current !== null && !current.isDestroyed()) {
      if (current.isMinimized()) current.restore();
      current.show();
      current.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 780,
      minHeight: 480,
      show: false,
      backgroundColor: '#0b1017',
      title: 'Mapa de flujo · Backend DevTools',
      autoHideMenuBar: true,
      webPreferences: {
        partition: MAP_PARTITION,
        preload: this.preloadPath,
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
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    window.webContents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    window.once('ready-to-show', () => {
      if (this.window === window && !window.isDestroyed()) {
        window.show();
      }
    });
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.ready = false;
      this.state = null;
      this.onClosed();
    });
    this.window = window;
    this.ready = false;
    void window.loadURL(MAP_URL).catch((error: unknown) => {
      this.log.warn('No se pudo cargar la ventana del mapa de flujo', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  focus(): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  close(): void {
    const window = this.window;
    this.window = null;
    this.ready = false;
    this.state = null;
    if (window !== null && !window.isDestroyed()) {
      window.close();
    }
  }

  isSender(sender: WebContents): boolean {
    const window = this.window;
    return window !== null && !window.isDestroyed() && sender === window.webContents;
  }

  handleReady(sender: WebContents): boolean {
    if (!this.isSender(sender)) return false;
    this.ready = true;
    this.send();
    return true;
  }

  updateMap(state: FlowMapState): void {
    this.state = state;
    this.send();
  }

  private send(): void {
    const window = this.window;
    if (!this.ready || this.state === null || window === null) return;
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(BROWSER_PANEL_CHANNELS.mapData, this.state);
  }
}
