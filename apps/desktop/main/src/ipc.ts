import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  BdtError,
  BROWSER_BOUNDS_SCHEMA,
  BROWSER_SET_INSPECTION_SCHEMA,
  BROWSER_TARGETS_REQUEST_SCHEMA,
  CODE_LOCATION_REQUEST_SCHEMA,
  ERROR_CODES,
  IPC_CHANNELS,
  NO_PAYLOAD_SCHEMA,
  READ_FILE_REQUEST_SCHEMA,
  STORED_LAUNCH_SETUP_SCHEMA,
  toIpcError,
  type BrowserSnapshot,
  type BrowserState,
  type CodeLocation,
  type CodeLocationRequest,
  type FileContent,
  type IpcResult,
  type ProjectSetupDetection,
  type SecurityScanReport,
  type StoredLaunchSetup,
  type WorkspaceSnapshot,
} from '@bdt/protocol';
import type { BrowserController } from './browser/controller';
import type { LaunchSettingsStore } from './launch-settings';
import type { Logger } from './logger';
import { detectProjectSetup } from './project/detect-setup';
import type { WorkspaceService } from './workspace';

export interface IpcDependencies {
  getMainWindow(): BrowserWindow | null;
  workspace: WorkspaceService;
  browser: BrowserController;
  launchSettings: LaunchSettingsStore;
  revealCode(request: CodeLocationRequest): CodeLocation | null;
  logger: Logger;
}

export function isTrustedSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null,
): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  const contents = mainWindow.webContents;
  if (event.sender !== contents) {
    return false;
  }
  return event.senderFrame !== null && event.senderFrame === contents.mainFrame;
}

function unauthorized<T>(): IpcResult<T> {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.IPC_UNAUTHORIZED,
      message: 'Petición IPC no autorizada.',
    },
  };
}

const NO_WORKSPACE_KEY = 'global';

function setupKey(workspace: WorkspaceService): string {
  return workspace.getSnapshot()?.workspace.id ?? NO_WORKSPACE_KEY;
}

function invalidPayload<T>(): IpcResult<T> {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.IPC_INVALID_PAYLOAD,
      message: 'Petición IPC inválida.',
    },
  };
}

function reportFailure<T>(error: unknown, logger: Logger, channel: string): IpcResult<T> {
  logger.error('Fallo al atender una petición IPC', {
    channel,
    code: error instanceof BdtError ? error.code : ERROR_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return { ok: false, error: toIpcError(error) };
}

export function registerIpcHandlers(dependencies: IpcDependencies): void {
  const { getMainWindow, workspace, browser, launchSettings, revealCode, logger } = dependencies;

  ipcMain.handle(
    IPC_CHANNELS.openWorkspace,
    async (event, payload): Promise<IpcResult<WorkspaceSnapshot | null>> => {
      const window = getMainWindow();
      if (!isTrustedSender(event, window) || window === null) {
        return unauthorized();
      }
      if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
        return invalidPayload();
      }

      try {
        const selection = await dialog.showOpenDialog(window, {
          title: 'Abrir carpeta del proyecto',
          buttonLabel: 'Abrir proyecto',
          properties: ['openDirectory'],
        });
        const selectedPath = selection.filePaths[0];
        if (selection.canceled || selectedPath === undefined) {
          return { ok: true, value: null };
        }
        const snapshot = await workspace.open(selectedPath);
        await launchSettings.setLastWorkspace(snapshot.workspace.rootPath);
        return { ok: true, value: snapshot };
      } catch (error) {
        return reportFailure(error, logger, IPC_CHANNELS.openWorkspace);
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.getState, (event, payload): IpcResult<WorkspaceSnapshot | null> => {
    const window = getMainWindow();
    if (!isTrustedSender(event, window)) {
      return unauthorized();
    }
    if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
      return invalidPayload();
    }

    try {
      return { ok: true, value: workspace.getSnapshot() };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.getState);
    }
  });

  ipcMain.handle(IPC_CHANNELS.readFile, (event, payload): IpcResult<FileContent> => {
    const window = getMainWindow();
    if (!isTrustedSender(event, window)) {
      return unauthorized();
    }
    const parsed = READ_FILE_REQUEST_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return invalidPayload();
    }

    try {
      return { ok: true, value: workspace.readFile(parsed.data.path) };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.readFile);
    }
  });

  ipcMain.handle(IPC_CHANNELS.revealCode, (event, payload): IpcResult<CodeLocation | null> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    const parsed = CODE_LOCATION_REQUEST_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return invalidPayload();
    }
    try {
      return { ok: true, value: revealCode(parsed.data) };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.revealCode);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.detectProjectSetup,
    async (event, payload): Promise<IpcResult<ProjectSetupDetection | null>> => {
      if (!isTrustedSender(event, getMainWindow())) {
        return unauthorized();
      }
      if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
        return invalidPayload();
      }
      try {
        const root = workspace.getRootPath();
        if (root === null) {
          return { ok: true, value: null };
        }
        return { ok: true, value: await detectProjectSetup(root) };
      } catch (error) {
        return reportFailure(error, logger, IPC_CHANNELS.detectProjectSetup);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.loadStoredSetup,
    async (event, payload): Promise<IpcResult<StoredLaunchSetup | null>> => {
      if (!isTrustedSender(event, getMainWindow())) {
        return unauthorized();
      }
      if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
        return invalidPayload();
      }
      try {
        const key = setupKey(workspace);
        const stored = await launchSettings.get(key);
        // Sin setup propio del proyecto se reutiliza el último comando usado:
        // el proyecto puede abrirse después de conectar y no debe pisar lo escrito.
        const fallback =
          stored !== null || key === NO_WORKSPACE_KEY
            ? null
            : await launchSettings.get(NO_WORKSPACE_KEY);
        return { ok: true, value: stored ?? fallback };
      } catch (error) {
        return reportFailure(error, logger, IPC_CHANNELS.loadStoredSetup);
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.saveStoredSetup, async (event, payload): Promise<IpcResult<void>> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    const parsed = STORED_LAUNCH_SETUP_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return invalidPayload();
    }
    try {
      const key = setupKey(workspace);
      await launchSettings.set(key, parsed.data);
      // La copia global mantiene el último comando aunque el proyecto se abra después.
      if (key !== NO_WORKSPACE_KEY) {
        await launchSettings.set(NO_WORKSPACE_KEY, parsed.data);
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.saveStoredSetup);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.browserConfigure,
    async (event, payload): Promise<IpcResult<BrowserSnapshot>> => {
      if (!isTrustedSender(event, getMainWindow())) {
        return unauthorized();
      }
      const parsed = BROWSER_TARGETS_REQUEST_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        return invalidPayload();
      }
      try {
        return { ok: true, value: await browser.configure(parsed.data) };
      } catch (error) {
        return reportFailure(error, logger, IPC_CHANNELS.browserConfigure);
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.browserDisconnect, (event, payload): IpcResult<BrowserState> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
      return invalidPayload();
    }
    try {
      return { ok: true, value: browser.disconnect() };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserDisconnect);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserReload, (event, payload): IpcResult<void> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
      return invalidPayload();
    }
    try {
      browser.reload();
      return { ok: true, value: undefined };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserReload);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserBounds, (event, payload): IpcResult<void> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    const parsed = BROWSER_BOUNDS_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return invalidPayload();
    }
    try {
      browser.setBounds(parsed.data);
      return { ok: true, value: undefined };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserBounds);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserSetInspection, (event, payload): IpcResult<BrowserState> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    const parsed = BROWSER_SET_INSPECTION_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      return invalidPayload();
    }
    try {
      return { ok: true, value: browser.setInspection(parsed.data.enabled) };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserSetInspection);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserFocus, (event, payload): IpcResult<void> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
      return invalidPayload();
    }
    try {
      browser.focusBrowserWindow();
      return { ok: true, value: undefined };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserFocus);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserSnapshot, (event, payload): IpcResult<BrowserSnapshot> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
      return invalidPayload();
    }
    try {
      return { ok: true, value: browser.getSnapshot() };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserSnapshot);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.browserSecurityScan,
    async (event, payload): Promise<IpcResult<SecurityScanReport>> => {
      if (!isTrustedSender(event, getMainWindow())) {
        return unauthorized();
      }
      if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
        return invalidPayload();
      }
      try {
        return { ok: true, value: await browser.scanSecurity() };
      } catch (error) {
        return reportFailure(error, logger, IPC_CHANNELS.browserSecurityScan);
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.browserClearRequests, (event, payload): IpcResult<BrowserState> => {
    if (!isTrustedSender(event, getMainWindow())) {
      return unauthorized();
    }
    if (!NO_PAYLOAD_SCHEMA.safeParse(payload).success) {
      return invalidPayload();
    }
    try {
      return { ok: true, value: browser.clearRequests() };
    } catch (error) {
      return reportFailure(error, logger, IPC_CHANNELS.browserClearRequests);
    }
  });
}
