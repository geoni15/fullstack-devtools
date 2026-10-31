import type {
  BrowserBounds,
  BrowserEvent,
  BrowserSnapshot,
  BrowserState,
  BrowserTargetsRequest,
  ProjectSetupDetection,
} from './browser';

export interface IpcError {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
}

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FileNode[];
}

export interface TreeStats {
  files: number;
  dirs: number;
  truncated: boolean;
}

export interface WorkspaceSnapshot {
  workspace: WorkspaceInfo;
  tree: FileNode;
  stats: TreeStats;
  watcher: 'active' | 'inactive';
}

export interface FileReadRequest {
  path: string;
}

export interface FileContent {
  path: string;
  size: number;
  content: string;
}

export interface BdtApi {
  openWorkspace(): Promise<IpcResult<WorkspaceSnapshot | null>>;
  getState(): Promise<IpcResult<WorkspaceSnapshot | null>>;
  readFile(path: string): Promise<IpcResult<FileContent>>;
  onWorkspaceChanged(listener: () => void): () => void;
  detectProjectSetup(): Promise<IpcResult<ProjectSetupDetection | null>>;
  configureBrowser(targets: BrowserTargetsRequest): Promise<IpcResult<BrowserSnapshot>>;
  disconnectBrowser(): Promise<IpcResult<BrowserState>>;
  reloadBrowser(): Promise<IpcResult<void>>;
  setBrowserBounds(bounds: BrowserBounds): Promise<IpcResult<void>>;
  setBrowserInspection(enabled: boolean): Promise<IpcResult<BrowserState>>;
  focusBrowserWindow(): Promise<IpcResult<void>>;
  getBrowserSnapshot(): Promise<IpcResult<BrowserSnapshot>>;
  clearBrowserRequests(): Promise<IpcResult<BrowserState>>;
  onBrowserEvent(listener: (event: BrowserEvent) => void): () => void;
}
