import { ipcMain, type WebContents, type WebFrameMain } from 'electron';
import {
  BdtError,
  BROWSER_CHROME_CHANNELS,
  BROWSER_PANEL_CHANNELS,
  ERROR_CODES,
  INSPECTION_MODES,
  toIpcError,
  type InspectionMode,
  type IpcResult,
} from '@bdt/protocol';
import type { Logger } from '../logger';
import type { BrowserController } from './controller';

const MAX_ADDRESS_LENGTH = 2048;

function unauthorized<T>(): IpcResult<T> {
  return {
    ok: false,
    error: { code: ERROR_CODES.IPC_UNAUTHORIZED, message: 'Petición IPC no autorizada.' },
  };
}

function invalidPayload<T>(): IpcResult<T> {
  return {
    ok: false,
    error: { code: ERROR_CODES.IPC_INVALID_PAYLOAD, message: 'Petición IPC inválida.' },
  };
}

function failure<T>(error: unknown, logger: Logger, channel: string): IpcResult<T> {
  logger.error('Fallo en una orden de la ventana del navegador', {
    channel,
    code: error instanceof BdtError ? error.code : ERROR_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error),
  });
  return { ok: false, error: toIpcError(error) };
}

interface SenderEvent {
  sender: WebContents;
  senderFrame: WebFrameMain | null;
}

function isMainFrame(event: SenderEvent): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
}

export function registerBrowserWindowIpc(browser: BrowserController, logger: Logger): void {
  ipcMain.on(BROWSER_CHROME_CHANNELS.ready, (event) => {
    if (!isMainFrame(event)) return;
    browser.handleChromeReady(event.sender);
  });

  ipcMain.handle(BROWSER_CHROME_CHANNELS.navigate, (event, payload: unknown): IpcResult<void> => {
    if (!browser.isChromeSender(event.sender) || !isMainFrame(event)) {
      return unauthorized();
    }
    if (
      typeof payload !== 'string' ||
      payload.length === 0 ||
      payload.length > MAX_ADDRESS_LENGTH
    ) {
      return invalidPayload();
    }
    try {
      browser.navigateFromChrome(event.sender, payload);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(error, logger, BROWSER_CHROME_CHANNELS.navigate);
    }
  });

  const simpleActions: Array<{
    channel: string;
    action(sender: WebContents): void;
  }> = [
    { channel: BROWSER_CHROME_CHANNELS.back, action: (sender) => browser.chromeBack(sender) },
    {
      channel: BROWSER_CHROME_CHANNELS.forward,
      action: (sender) => browser.chromeForward(sender),
    },
    { channel: BROWSER_CHROME_CHANNELS.reload, action: (sender) => browser.chromeReload(sender) },
    {
      channel: BROWSER_CHROME_CHANNELS.toggleInspection,
      action: (sender) => browser.chromeToggleInspection(sender),
    },
  ];

  for (const { channel, action } of simpleActions) {
    ipcMain.handle(channel, (event, payload: unknown): IpcResult<void> => {
      if (!browser.isChromeSender(event.sender) || !isMainFrame(event)) {
        return unauthorized();
      }
      if (payload !== undefined) {
        return invalidPayload();
      }
      try {
        action(event.sender);
        return { ok: true, value: undefined };
      } catch (error) {
        return failure(error, logger, channel);
      }
    });
  }

  ipcMain.on(BROWSER_PANEL_CHANNELS.ready, (event) => {
    if (!isMainFrame(event)) return;
    browser.handlePanelReady(event.sender);
  });

  ipcMain.on(BROWSER_PANEL_CHANNELS.selectRequest, (event, payload: unknown) => {
    if (!browser.isPanelSender(event.sender) || !isMainFrame(event)) return;
    if (typeof payload !== 'string' || payload.length === 0 || payload.length > 200) return;
    try {
      browser.selectPanelRequest(payload);
    } catch (error) {
      logger.error('Fallo al seleccionar una petición de la inspección', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.on(BROWSER_PANEL_CHANNELS.setMode, (event, payload: unknown) => {
    if (!browser.isPanelSender(event.sender) || !isMainFrame(event)) return;
    if (typeof payload !== 'string') return;
    if (!(INSPECTION_MODES as readonly string[]).includes(payload)) return;
    try {
      browser.selectPanelMode(payload as InspectionMode);
    } catch (error) {
      logger.error('Fallo al cambiar el modo de inspección', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
