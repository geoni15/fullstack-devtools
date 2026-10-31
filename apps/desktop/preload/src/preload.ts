import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  type BdtApi,
  type BrowserBounds,
  type BrowserEvent,
  type BrowserSnapshot,
  type BrowserState,
  type BrowserTargetsRequest,
  type FileContent,
  type IpcResult,
  type ProjectSetupDetection,
  type WorkspaceSnapshot,
} from '@bdt/protocol';

const api: BdtApi = {
  openWorkspace: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openWorkspace) as Promise<IpcResult<WorkspaceSnapshot | null>>,
  getState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getState) as Promise<IpcResult<WorkspaceSnapshot | null>>,
  readFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.readFile, { path: filePath }) as Promise<
      IpcResult<FileContent>
    >,
  detectProjectSetup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.detectProjectSetup) as Promise<
      IpcResult<ProjectSetupDetection | null>
    >,
  onWorkspaceChanged: (listener: () => void) => {
    if (typeof listener !== 'function') {
      throw new TypeError('El listener debe ser una función.');
    }
    const handler = (): void => {
      listener();
    };
    ipcRenderer.on(IPC_CHANNELS.workspaceChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.workspaceChanged, handler);
    };
  },
  configureBrowser: (targets: BrowserTargetsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.browserConfigure, targets) as Promise<
      IpcResult<BrowserSnapshot>
    >,
  disconnectBrowser: () =>
    ipcRenderer.invoke(IPC_CHANNELS.browserDisconnect) as Promise<IpcResult<BrowserState>>,
  reloadBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.browserReload) as Promise<IpcResult<void>>,
  setBrowserBounds: (bounds: BrowserBounds) =>
    ipcRenderer.invoke(IPC_CHANNELS.browserBounds, bounds) as Promise<IpcResult<void>>,
  setBrowserInspection: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.browserSetInspection, { enabled }) as Promise<
      IpcResult<BrowserState>
    >,
  focusBrowserWindow: () =>
    ipcRenderer.invoke(IPC_CHANNELS.browserFocus) as Promise<IpcResult<void>>,
  getBrowserSnapshot: () =>
    ipcRenderer.invoke(IPC_CHANNELS.browserSnapshot) as Promise<IpcResult<BrowserSnapshot>>,
  clearBrowserRequests: () =>
    ipcRenderer.invoke(IPC_CHANNELS.browserClearRequests) as Promise<IpcResult<BrowserState>>,
  onBrowserEvent: (listener: (event: BrowserEvent) => void) => {
    if (typeof listener !== 'function') {
      throw new TypeError('El listener debe ser una función.');
    }
    const handler = (_event: unknown, payload: BrowserEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.browserEvent, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.browserEvent, handler);
    };
  },
};

contextBridge.exposeInMainWorld('bdt', Object.freeze(api));
