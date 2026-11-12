import { ipcMain, type WebContents, type WebFrameMain } from 'electron';
import {
  BdtError,
  BROWSER_CHROME_CHANNELS,
  BROWSER_PANEL_CHANNELS,
  CODE_LOCATION_REQUEST_SCHEMA,
  ERROR_CODES,
  INSPECTION_MODES,
  toIpcError,
  type CodeLocation,
  type CodeLocationRequest,
  type InspectionMode,
  type IpcResult,
} from '@bdt/protocol';
import type { Logger } from '../logger';
import type { BrowserController } from './controller';

const MAX_ADDRESS_LENGTH = 2048;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_HIGHLIGHT_KEY_LENGTH = 200;
const MAX_HIGHLIGHT_TARGETS = 512;

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

function isInspectorUiSender(browser: BrowserController, event: SenderEvent): boolean {
  return (
    (browser.isPanelSender(event.sender) || browser.isMapSender(event.sender)) && isMainFrame(event)
  );
}

export function registerBrowserWindowIpc(
  browser: BrowserController,
  logger: Logger,
  revealCode: (request: CodeLocationRequest) => CodeLocation | null,
): void {
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
    {
      channel: BROWSER_CHROME_CHANNELS.toggleHoverTip,
      action: (sender) => browser.chromeToggleHoverTip(sender),
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
    if (!isInspectorUiSender(browser, event)) return;
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
    if (!isInspectorUiSender(browser, event)) return;
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

  ipcMain.on(BROWSER_PANEL_CHANNELS.map, (event, payload: unknown) => {
    if (!isInspectorUiSender(browser, event)) return;
    if (typeof payload !== 'boolean') return;
    try {
      browser.setMapOpen(payload);
    } catch (error) {
      logger.error('Fallo al abrir o cerrar el mapa de flujo', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.on(BROWSER_PANEL_CHANNELS.highlight, (event, payload: unknown) => {
    if (!browser.isMapSender(event.sender)) return;
    if (!isMainFrame(event)) return;
    if (typeof payload !== 'object' || payload === null) return;
    const record = payload as { key?: unknown; selector?: unknown; targets?: unknown };
    const readTarget = (entry: {
      key?: unknown;
      selector?: unknown;
    }): { key: string | null; selector: string } | null => {
      const key =
        entry.key === null || entry.key === undefined
          ? null
          : typeof entry.key === 'string' && entry.key.length <= MAX_HIGHLIGHT_KEY_LENGTH
            ? entry.key
            : undefined;
      if (key === undefined) return null;
      if (
        typeof entry.selector !== 'string' ||
        entry.selector === '' ||
        entry.selector.length > MAX_SELECTOR_LENGTH
      ) {
        return null;
      }
      return { key, selector: entry.selector };
    };
    const targets: Array<{ key: string | null; selector: string }> = [];
    if (record.targets !== undefined) {
      if (
        !Array.isArray(record.targets) ||
        record.targets.length === 0 ||
        record.targets.length > MAX_HIGHLIGHT_TARGETS
      ) {
        return;
      }
      for (const entry of record.targets) {
        if (typeof entry !== 'object' || entry === null) return;
        const target = readTarget(entry as { key?: unknown; selector?: unknown });
        if (target === null) return;
        targets.push(target);
      }
    } else {
      const target = readTarget(record);
      if (target === null) return;
      targets.push(target);
    }
    try {
      browser.highlightFlowElements(targets);
    } catch (error) {
      logger.error('Fallo al resaltar el elemento del mapa en la página', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.on(BROWSER_PANEL_CHANNELS.revealLocation, (event, payload: unknown) => {
    if (!isInspectorUiSender(browser, event)) return;
    const parsed = CODE_LOCATION_REQUEST_SCHEMA.safeParse(payload);
    if (!parsed.success) return;
    try {
      revealCode(parsed.data);
    } catch (error) {
      logger.error('Fallo al abrir una ubicación de código desde el inspector', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
