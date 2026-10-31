import { WebContentsView, type WebContents } from 'electron';
import { BROWSER_PANEL_CHANNELS, type InspectionPanelState } from '@bdt/protocol';
import type { Logger } from '../logger';
import { hardenSession } from '../security';
import { INSPECTION_PANEL_HTML } from './ui-html';

const PANEL_PARTITION = 'bdt-panel';
const PANEL_URL = `data:text/html;charset=utf-8,${encodeURIComponent(INSPECTION_PANEL_HTML)}`;

export class InspectionPanel {
  private view: WebContentsView | null = null;
  private ready = false;
  private state: InspectionPanelState | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly log: Logger,
  ) {}

  create(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: PANEL_PARTITION,
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor('#0e1116');
    hardenSession(view.webContents.session);

    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });

    this.view = view;
    this.ready = false;
    void contents.loadURL(PANEL_URL).catch((error: unknown) => {
      this.log.warn('No se pudo cargar el panel de inspección', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return view;
  }

  getView(): WebContentsView | null {
    return this.view;
  }

  isSender(sender: WebContents): boolean {
    const view = this.view;
    return view !== null && !view.webContents.isDestroyed() && sender === view.webContents;
  }

  handleReady(sender: WebContents): boolean {
    if (!this.isSender(sender)) {
      return false;
    }
    this.ready = true;
    this.send();
    return true;
  }

  update(state: InspectionPanelState): void {
    this.state = state;
    this.send();
  }

  dispose(): void {
    const view = this.view;
    this.view = null;
    this.ready = false;
    this.state = null;
    if (view !== null && !view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  private send(): void {
    const view = this.view;
    if (!this.ready || this.state === null || view === null) {
      return;
    }
    if (view.webContents.isDestroyed()) {
      return;
    }
    view.webContents.send(BROWSER_PANEL_CHANNELS.data, this.state);
  }
}
